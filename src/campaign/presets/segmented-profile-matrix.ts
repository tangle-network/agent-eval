/**
 * Eval-owned execution for profile matrices whose external authorization is
 * shorter than the complete matrix.
 *
 * A plan freezes the complete profile × scenario × replicate design. A
 * segment claims an explicit, disjoint set of rows and uses the campaign cell
 * cache as the durable per-cell record. Finalization first checks that every
 * planned row has one claim and one valid record, then replays the ordinary
 * `runProfileMatrix` projection from those records without dispatching work.
 */

import { dirname, join } from 'node:path'
import { type AgentProfile, agentProfileHash, agentProfileId } from '../../agent-profile'
import { canonicalJson, contentHash } from '../../verdict-cache'
import { cellCachePath } from '../cell-schedule'
import { assertCampaignDesign, campaignScenarioIdentity } from '../coverage'
import { resolveRunDir } from '../run-dir'
import { campaignCellCostProvenance, projectCampaignCellQuality } from '../run-record'
import type { CampaignStorage } from '../storage'
import { fsCampaignStorage } from '../storage'
import type { CampaignCellResult, JudgeConfig, Scenario } from '../types'
import {
  type ProfileDispatchFn,
  ProfileMatrixError,
  profileMatrixCampaignIdentity,
  type RunProfileMatrixOptions,
  type RunProfileMatrixResult,
  runProfileMatrix,
} from './run-profile-matrix'

const PLAN_FILE = 'profile-matrix-plan.json'
const SEGMENTS_FILE = 'profile-matrix-segments.jsonl'

export class SegmentedProfileMatrixError extends ProfileMatrixError {
  constructor(message: string) {
    super(`segmented matrix: ${message}`)
  }
}

export interface ProfileMatrixRow {
  rowId: string
  ordinal: number
  profileId: string
  scenarioId: string
  rep: number
}

export interface ProfileMatrixPlan<TScenario extends Scenario, TArtifact> {
  readonly schemaVersion: 1
  readonly matrixId: string
  readonly experimentId: string
  readonly planDigest: `sha256:${string}`
  readonly profiles: readonly AgentProfile[]
  readonly scenarios: readonly TScenario[]
  readonly judges: readonly JudgeConfig<TArtifact, TScenario>[]
  readonly reps: number
  readonly seed: number
  readonly splitTag: NonNullable<RunProfileMatrixOptions<TScenario, TArtifact>['splitTag']>
  readonly commitSha: string
  /** Stable dispatch implementation/configuration identity used by cell caches. */
  readonly dispatchRef: string
  readonly integrity: NonNullable<RunProfileMatrixOptions<TScenario, TArtifact>['integrity']>
  readonly allowMixed: boolean
  readonly validate: boolean
  readonly personaOf?: (scenario: TScenario) => string
  readonly corpusText?: (
    artifact: TArtifact,
    scenario: TScenario,
  ) => { prompt: string; completion: string } | undefined
  readonly rows: readonly ProfileMatrixRow[]
}

export interface CreateProfileMatrixPlanOptions<TScenario extends Scenario, TArtifact>
  extends Pick<
    RunProfileMatrixOptions<TScenario, TArtifact>,
    | 'profiles'
    | 'scenarios'
    | 'judges'
    | 'commitSha'
    | 'experimentId'
    | 'splitTag'
    | 'reps'
    | 'seed'
    | 'integrity'
    | 'allowMixed'
    | 'validate'
    | 'personaOf'
    | 'corpusText'
  > {
  /** Stable dispatch implementation/configuration identity used by cell caches. */
  dispatchRef: string
}

export interface ProfileMatrixCoverage {
  expected: number
  present: number
  missing: string[]
  failed: string[]
  zeroScore: string[]
}

export interface RunProfileMatrixSegmentOptions<TScenario extends Scenario, TArtifact> {
  plan: ProfileMatrixPlan<TScenario, TArtifact>
  /** Stable external grant or attempt identity. Reuse it to resume. */
  segmentId: string
  /** Explicit row ids from `plan.rows`; duplicate or unknown rows fail. */
  rows: readonly (string | ProfileMatrixRow)[]
  dispatch: ProfileDispatchFn<TScenario, TArtifact>
  runDir: string
  storage?: CampaignStorage
  maxConcurrency?: number
  maxProfileConcurrency?: number
  costCeiling?: number
  labeledStore?: RunProfileMatrixOptions<TScenario, TArtifact>['labeledStore']
  captureSource?: RunProfileMatrixOptions<TScenario, TArtifact>['captureSource']
  now?: () => Date
}

export interface ProfileMatrixSegmentResult<TArtifact, TScenario extends Scenario> {
  segmentId: string
  rowIds: string[]
  matrix: RunProfileMatrixResult<TArtifact, TScenario>
  coverage: ProfileMatrixCoverage
}

export interface FinalizeProfileMatrixOptions<TScenario extends Scenario, TArtifact> {
  plan: ProfileMatrixPlan<TScenario, TArtifact>
  runDir: string
  storage?: CampaignStorage
  maxConcurrency?: number
  maxProfileConcurrency?: number
  now?: () => Date
}

export interface FinalizedProfileMatrixResult<TArtifact, TScenario extends Scenario>
  extends RunProfileMatrixResult<TArtifact, TScenario> {
  coverage: ProfileMatrixCoverage
}

export function createProfileMatrixPlan<TScenario extends Scenario, TArtifact>(
  opts: CreateProfileMatrixPlanOptions<TScenario, TArtifact>,
): ProfileMatrixPlan<TScenario, TArtifact> {
  if (!Array.isArray(opts.profiles) || opts.profiles.length === 0) {
    throw new SegmentedProfileMatrixError('profiles must not be empty')
  }
  if (!Array.isArray(opts.scenarios) || opts.scenarios.length === 0) {
    throw new SegmentedProfileMatrixError('scenarios must not be empty')
  }
  const reps = opts.reps ?? 1
  const seed = opts.seed ?? 42
  const splitTag = opts.splitTag ?? 'search'
  const integrity = opts.integrity ?? 'assert'
  const allowMixed = opts.allowMixed ?? true
  const validate = opts.validate ?? true
  if (typeof opts.commitSha !== 'string' || opts.commitSha.trim().length === 0) {
    throw new SegmentedProfileMatrixError('commitSha must be a non-empty string')
  }
  if (typeof opts.dispatchRef !== 'string' || opts.dispatchRef.trim().length === 0) {
    throw new SegmentedProfileMatrixError(
      'dispatchRef must be a non-empty stable identity for segmented execution',
    )
  }
  assertCampaignDesign(opts.scenarios, reps)

  const profiles = [...opts.profiles]
  const scenarios = [...opts.scenarios]
  const judges = [...(opts.judges ?? [])]
  const profileIds = profiles.map(agentProfileId)
  const duplicateProfiles = profileIds.filter((id, index) => profileIds.indexOf(id) !== index)
  if (duplicateProfiles.length > 0) {
    throw new SegmentedProfileMatrixError(
      `duplicate profile ids: ${[...new Set(duplicateProfiles)].join(', ')}`,
    )
  }

  const experimentId =
    opts.experimentId ??
    `pm_${contentHash({ profileIds, scenarios: scenarios.map((scenario) => scenario.id) }).slice(0, 16)}`
  if (experimentId.trim().length === 0) {
    throw new SegmentedProfileMatrixError('experimentId must be non-empty')
  }

  const identityMaterial = {
    schema: 'tangle.profile-matrix-plan.v1',
    profiles: profiles.map((profile, index) => ({
      ordinal: index,
      id: profileIds[index],
      hash: `sha256:${agentProfileHash(profile)}`,
      profile,
    })),
    scenarios: scenarios.map((scenario, index) => ({
      ordinal: index,
      identity: campaignScenarioIdentity(scenario),
      scenario,
    })),
    judges: judges.map((judge) => ({
      name: judge.name,
      dimensions: judge.dimensions,
      judgeVersion: judge.judgeVersion ?? null,
      score: judge.score.toString(),
      appliesTo: judge.appliesTo?.toString() ?? null,
    })),
    reps,
    seed,
    splitTag,
    commitSha: opts.commitSha,
    dispatchRef: opts.dispatchRef,
    experimentId,
    integrity,
    allowMixed,
    validate,
    personaOf: opts.personaOf?.toString() ?? null,
    corpusText: opts.corpusText?.toString() ?? null,
  }
  const planDigest = `sha256:${contentHash(identityMaterial)}` as const
  const matrixId = `pmx_${planDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`
  const rows: ProfileMatrixRow[] = []
  const seenCellIds = new Set<string>()
  let ordinal = 0
  for (const profileId of profileIds) {
    for (const scenario of scenarios) {
      for (let rep = 0; rep < reps; rep += 1) {
        const cellId = `${scenario.id}:${rep}`
        if (seenCellIds.has(`${profileId}:${cellId}`)) {
          throw new SegmentedProfileMatrixError(
            `profile/scenario/rep cell id collision for '${profileId}:${cellId}'`,
          )
        }
        seenCellIds.add(`${profileId}:${cellId}`)
        rows.push({
          rowId: `row_${contentHash({ matrixId, profileId, scenarioId: scenario.id, rep }).slice(0, 24)}`,
          ordinal,
          profileId,
          scenarioId: scenario.id,
          rep,
        })
        ordinal += 1
      }
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    matrixId,
    experimentId,
    planDigest,
    profiles: Object.freeze(profiles),
    scenarios: Object.freeze(scenarios),
    judges: Object.freeze(judges),
    reps,
    seed,
    splitTag,
    commitSha: opts.commitSha,
    dispatchRef: opts.dispatchRef,
    integrity,
    allowMixed,
    validate,
    ...(opts.personaOf === undefined ? {} : { personaOf: opts.personaOf }),
    ...(opts.corpusText === undefined ? {} : { corpusText: opts.corpusText }),
    rows: Object.freeze(rows),
  }) as ProfileMatrixPlan<TScenario, TArtifact>
}

export async function runProfileMatrixSegment<TScenario extends Scenario, TArtifact>(
  opts: RunProfileMatrixSegmentOptions<TScenario, TArtifact>,
): Promise<ProfileMatrixSegmentResult<TArtifact, TScenario>> {
  const segmentId = requireIdentifier(opts.segmentId, 'segmentId')
  const storage = opts.storage ?? fsCampaignStorage()
  const runDir = resolveRunDir(opts.runDir)
  assertPlan(opts.plan)
  const selected = normalizeRows(opts.plan, opts.rows)
  ensureManifest(storage, runDir, manifestFor(opts.plan))
  claimSegment(storage, runDir, opts.plan, segmentId, selected)

  const selectedIds = new Set(selected.map((row) => row.rowId))
  const selectedProfileIds = new Set(selected.map((row) => row.profileId))
  const profiles = opts.plan.profiles.filter((profile) =>
    selectedProfileIds.has(agentProfileId(profile)),
  )

  const matrix = await runProfileMatrix<TScenario, TArtifact>({
    profiles,
    scenarios: [...opts.plan.scenarios],
    dispatch: opts.dispatch,
    judges: [...opts.plan.judges],
    runDir,
    commitSha: opts.plan.commitSha,
    dispatchRef: opts.plan.dispatchRef,
    experimentId: opts.plan.experimentId,
    matrixId: opts.plan.matrixId,
    splitTag: opts.plan.splitTag,
    reps: opts.plan.reps,
    seed: opts.plan.seed,
    integrity: 'off',
    allowMixed: opts.plan.allowMixed,
    maxConcurrency: opts.maxConcurrency,
    maxProfileConcurrency: opts.maxProfileConcurrency,
    costCeiling: opts.costCeiling,
    labeledStore: opts.labeledStore,
    captureSource: opts.captureSource,
    storage,
    now: opts.now,
    personaOf: opts.plan.personaOf,
    validate: opts.plan.validate,
    corpusText: opts.plan.corpusText,
    reuseFailedCells: false,
    rowFilter: ({ profile, scenario, rep }) =>
      selectedIds.has(rowIdFor(opts.plan, agentProfileId(profile), scenario.id, rep)),
  })

  persistSegmentCells(storage, runDir, matrix)
  const coverage = readCoverage(storage, runDir, opts.plan)
  return { segmentId, rowIds: selected.map((row) => row.rowId), matrix, coverage }
}

export async function finalizeProfileMatrix<TScenario extends Scenario, TArtifact>(
  opts: FinalizeProfileMatrixOptions<TScenario, TArtifact>,
): Promise<FinalizedProfileMatrixResult<TArtifact, TScenario>> {
  const storage = opts.storage ?? fsCampaignStorage()
  const runDir = resolveRunDir(opts.runDir)
  assertPlan(opts.plan)
  ensureManifest(storage, runDir, manifestFor(opts.plan))
  const claims = readSegmentClaims(storage, runDir)
  assertCompleteClaims(opts.plan, claims)
  const coverage = readCoverage(storage, runDir, opts.plan)
  if (coverage.missing.length > 0) {
    throw new SegmentedProfileMatrixError(
      `cannot finalize with missing rows: ${coverage.missing.join(', ')}`,
    )
  }

  const matrix = await runProfileMatrix<TScenario, TArtifact>({
    profiles: [...opts.plan.profiles],
    scenarios: [...opts.plan.scenarios],
    dispatch: async () => {
      throw new SegmentedProfileMatrixError(
        'finalization attempted to dispatch an uncached row; the persisted coverage changed during finalization',
      )
    },
    judges: [...opts.plan.judges],
    runDir,
    commitSha: opts.plan.commitSha,
    dispatchRef: opts.plan.dispatchRef,
    experimentId: opts.plan.experimentId,
    matrixId: opts.plan.matrixId,
    splitTag: opts.plan.splitTag,
    reps: opts.plan.reps,
    seed: opts.plan.seed,
    integrity: opts.plan.integrity,
    allowMixed: opts.plan.allowMixed,
    maxConcurrency: opts.maxConcurrency,
    maxProfileConcurrency: opts.maxProfileConcurrency,
    storage,
    now: opts.now,
    personaOf: opts.plan.personaOf,
    validate: opts.plan.validate,
    corpusText: opts.plan.corpusText,
    reuseFailedCells: true,
  })
  assertFinalRows(opts.plan, matrix)
  return { ...matrix, coverage }
}

interface PersistedMatrixManifest {
  schemaVersion: 1
  matrixId: string
  experimentId: string
  planDigest: string
  profiles: Array<{ id: string; hash: string }>
  scenarios: Array<{ id: string; kind: string; scenarioDigest: string }>
  reps: number
  seed: number
  splitTag: string
  commitSha: string
  dispatchRef: string
  rows: ProfileMatrixRow[]
}

interface SegmentClaim {
  schemaVersion: 1
  segmentId: string
  planDigest: string
  rowIds: string[]
}

function manifestFor<TScenario extends Scenario, TArtifact>(
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
): PersistedMatrixManifest {
  return {
    schemaVersion: 1,
    matrixId: plan.matrixId,
    experimentId: plan.experimentId,
    planDigest: plan.planDigest,
    profiles: plan.profiles.map((profile) => ({
      id: agentProfileId(profile),
      hash: `sha256:${agentProfileHash(profile)}`,
    })),
    scenarios: plan.scenarios.map((scenario) => campaignScenarioIdentity(scenario)),
    reps: plan.reps,
    seed: plan.seed,
    splitTag: plan.splitTag,
    commitSha: plan.commitSha,
    dispatchRef: plan.dispatchRef,
    rows: [...plan.rows],
  }
}

function assertPlan<TScenario extends Scenario, TArtifact>(
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
): void {
  const rebuilt = createProfileMatrixPlan({
    profiles: [...plan.profiles],
    scenarios: [...plan.scenarios],
    judges: [...plan.judges],
    commitSha: plan.commitSha,
    dispatchRef: plan.dispatchRef,
    experimentId: plan.experimentId,
    splitTag: plan.splitTag,
    reps: plan.reps,
    seed: plan.seed,
    integrity: plan.integrity,
    allowMixed: plan.allowMixed,
    validate: plan.validate,
    personaOf: plan.personaOf,
    corpusText: plan.corpusText,
  })
  if (
    rebuilt.planDigest !== plan.planDigest ||
    rebuilt.matrixId !== plan.matrixId ||
    canonicalJson(rebuilt.rows) !== canonicalJson(plan.rows)
  ) {
    throw new SegmentedProfileMatrixError('plan inputs changed after identity was created')
  }
}

function ensureManifest(
  storage: CampaignStorage,
  runDir: string,
  expected: PersistedMatrixManifest,
): void {
  storage.ensureDir(runDir)
  const path = join(runDir, PLAN_FILE)
  const existing = storage.read(path)
  if (existing === undefined) {
    const content = `${canonicalJson(expected)}\n`
    if (storage.append(path, content, 0) !== undefined) return
  }
  const persisted = storage.read(path)
  if (persisted === undefined) {
    throw new SegmentedProfileMatrixError('persisted plan is unreadable')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(persisted)
  } catch {
    throw new SegmentedProfileMatrixError('persisted plan is corrupt JSON')
  }
  if (canonicalJson(parsed) !== canonicalJson(expected)) {
    throw new SegmentedProfileMatrixError(
      'persisted plan identity does not match the supplied inputs',
    )
  }
}

function normalizeRows<TScenario extends Scenario, TArtifact>(
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
  rows: readonly (string | ProfileMatrixRow)[],
): ProfileMatrixRow[] {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new SegmentedProfileMatrixError('a segment must select at least one row')
  }
  const byId = new Map(plan.rows.map((row) => [row.rowId, row]))
  const selected: ProfileMatrixRow[] = []
  const seen = new Set<string>()
  for (const input of rows) {
    const rowId = typeof input === 'string' ? input : input?.rowId
    if (typeof rowId !== 'string' || rowId.length === 0) {
      throw new SegmentedProfileMatrixError('segment rows must contain row ids')
    }
    if (seen.has(rowId))
      throw new SegmentedProfileMatrixError(`duplicate row '${rowId}' in segment`)
    const row = byId.get(rowId)
    if (!row) throw new SegmentedProfileMatrixError(`row '${rowId}' is not declared by the plan`)
    if (typeof input !== 'string' && canonicalJson(input) !== canonicalJson(row)) {
      throw new SegmentedProfileMatrixError(`row '${rowId}' does not match the declared plan row`)
    }
    seen.add(rowId)
    selected.push(row)
  }
  return selected.sort((left, right) => left.ordinal - right.ordinal)
}

function claimSegment<TScenario extends Scenario, TArtifact>(
  storage: CampaignStorage,
  runDir: string,
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
  segmentId: string,
  selected: readonly ProfileMatrixRow[],
): void {
  const path = join(runDir, SEGMENTS_FILE)
  const expected = canonicalJson({
    schemaVersion: 1,
    segmentId,
    planDigest: plan.planDigest,
    rowIds: selected.map((row) => row.rowId).sort(),
  } satisfies SegmentClaim)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const raw = storage.read(path) ?? ''
    const claims = parseSegmentClaims(raw, path)
    const existing = claims.find((claim) => claim.segmentId === segmentId)
    if (existing) {
      if (canonicalJson(existing) !== expected) {
        throw new SegmentedProfileMatrixError(
          `segment '${segmentId}' was resumed with different rows or plan identity`,
        )
      }
      return
    }
    const selectedIds = new Set(selected.map((row) => row.rowId))
    const overlap = claims.flatMap((claim) =>
      claim.rowIds
        .filter((rowId) => selectedIds.has(rowId))
        .map((rowId) => `${rowId} (${claim.segmentId})`),
    )
    if (overlap.length > 0) {
      throw new SegmentedProfileMatrixError(
        `segment rows overlap existing claims: ${overlap.join(', ')}`,
      )
    }
    const event = `${expected}\n`
    const next = storage.append(path, event, byteLength(raw))
    if (next !== undefined) return
  }
  throw new SegmentedProfileMatrixError(
    `could not claim segment '${segmentId}' after concurrent updates`,
  )
}

function readSegmentClaims(storage: CampaignStorage, runDir: string): SegmentClaim[] {
  const path = join(runDir, SEGMENTS_FILE)
  const raw = storage.read(path)
  if (raw === undefined) return []
  return parseSegmentClaims(raw, path)
}

function parseSegmentClaims(raw: string, path: string): SegmentClaim[] {
  const claims: SegmentClaim[] = []
  const seenSegments = new Set<string>()
  const seenRows = new Map<string, string>()
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new SegmentedProfileMatrixError(`segment registry is corrupt at ${path}:${index + 1}`)
    }
    if (canonicalJson(parsed) !== line) {
      throw new SegmentedProfileMatrixError(
        `segment registry is not canonical at ${path}:${index + 1}`,
      )
    }
    const claim = parsed as Partial<SegmentClaim>
    if (
      claim.schemaVersion !== 1 ||
      typeof claim.segmentId !== 'string' ||
      typeof claim.planDigest !== 'string' ||
      !Array.isArray(claim.rowIds) ||
      claim.rowIds.some((rowId) => typeof rowId !== 'string') ||
      new Set(claim.rowIds).size !== claim.rowIds.length
    ) {
      throw new SegmentedProfileMatrixError(
        `segment registry has an invalid claim at ${path}:${index + 1}`,
      )
    }
    if (seenSegments.has(claim.segmentId)) {
      throw new SegmentedProfileMatrixError(`segment registry repeats segment '${claim.segmentId}'`)
    }
    seenSegments.add(claim.segmentId)
    const normalized = {
      schemaVersion: 1 as const,
      segmentId: claim.segmentId,
      planDigest: claim.planDigest,
      rowIds: [...claim.rowIds].sort(),
    }
    for (const rowId of normalized.rowIds) {
      const owner = seenRows.get(rowId)
      if (owner) {
        throw new SegmentedProfileMatrixError(
          `segment registry overlaps row '${rowId}' between '${owner}' and '${normalized.segmentId}'`,
        )
      }
      seenRows.set(rowId, normalized.segmentId)
    }
    claims.push(normalized)
  }
  return claims
}

function assertCompleteClaims<TScenario extends Scenario, TArtifact>(
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
  claims: readonly SegmentClaim[],
): void {
  const expected = new Set(plan.rows.map((row) => row.rowId))
  const claimed = new Set<string>()
  for (const claim of claims) {
    if (claim.planDigest !== plan.planDigest) {
      throw new SegmentedProfileMatrixError(
        `segment '${claim.segmentId}' belongs to a different plan identity`,
      )
    }
    for (const rowId of claim.rowIds) {
      if (!expected.has(rowId)) {
        throw new SegmentedProfileMatrixError(
          `segment '${claim.segmentId}' claims an undeclared row '${rowId}'`,
        )
      }
      claimed.add(rowId)
    }
  }
  const missingClaims = plan.rows.filter((row) => !claimed.has(row.rowId)).map((row) => row.rowId)
  if (missingClaims.length > 0) {
    throw new SegmentedProfileMatrixError(
      `cannot finalize until every row is claimed: ${missingClaims.join(', ')}`,
    )
  }
}

function persistSegmentCells<TArtifact, TScenario extends Scenario>(
  storage: CampaignStorage,
  runDir: string,
  matrix: RunProfileMatrixResult<TArtifact, TScenario>,
): void {
  for (const [profileId, campaign] of Object.entries(matrix.campaigns)) {
    for (const cell of campaign.cells) {
      const path = cellCachePath(join(runDir, profileDirectory(profileId)), cell.cellId)
      storage.ensureDir(dirname(path))
      // Campaign caches already use JSON.stringify, which omits optional
      // undefined fields such as a successful cell's `error` property.
      storage.write(path, `${JSON.stringify(cell)}\n`)
    }
  }
}

function readCoverage<TScenario extends Scenario, TArtifact>(
  storage: CampaignStorage,
  runDir: string,
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
): ProfileMatrixCoverage {
  const expectedManifestHashes = new Map<string, string>(
    plan.profiles.map((profile) => {
      const identity = profileMatrixCampaignIdentity({
        profile,
        scenarios: [...plan.scenarios],
        judges: [...plan.judges],
        commitSha: plan.commitSha,
        dispatchRef: plan.dispatchRef,
        splitTag: plan.splitTag,
        seed: plan.seed,
        reps: plan.reps,
      })
      return [identity.profileId, identity.manifestHash] as const
    }),
  )
  const missing: string[] = []
  const failed: string[] = []
  const zeroScore: string[] = []
  let present = 0
  for (const row of plan.rows) {
    const path = cellCachePath(
      join(runDir, profileDirectory(row.profileId)),
      `${row.scenarioId}:${row.rep}`,
    )
    const raw = storage.read(path)
    if (raw === undefined) {
      missing.push(row.rowId)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new SegmentedProfileMatrixError(`cell '${row.rowId}' has corrupt JSON`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SegmentedProfileMatrixError(`cell '${row.rowId}' has an invalid record shape`)
    }
    const cell = parsed as CampaignCellResult<TArtifact>
    if (
      cell.cellId !== `${row.scenarioId}:${row.rep}` ||
      cell.scenarioId !== row.scenarioId ||
      cell.rep !== row.rep ||
      cell.manifestHash !== expectedManifestHashes.get(row.profileId)
    ) {
      throw new SegmentedProfileMatrixError(
        `cell '${row.rowId}' has stale identity fields (manifest or row identity)`,
      )
    }
    try {
      campaignCellCostProvenance(cell)
    } catch (error) {
      throw new SegmentedProfileMatrixError(
        `cell '${row.rowId}' failed cost-record validation: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    present += 1
    if (cell.error !== undefined) {
      failed.push(row.rowId)
      continue
    }
    if (projectCampaignCellQuality(cell).score === 0) zeroScore.push(row.rowId)
  }
  return {
    expected: plan.rows.length,
    present,
    missing,
    failed,
    zeroScore,
  }
}

function assertFinalRows<TScenario extends Scenario, TArtifact>(
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
  matrix: RunProfileMatrixResult<TArtifact, TScenario>,
): void {
  const expected = new Set(plan.rows.map((row) => `${row.profileId}:${row.scenarioId}:${row.rep}`))
  const seen = new Set<string>()
  for (const record of matrix.records) {
    const key = `${record.candidateId}:${record.scenarioId}:${record.outcome.raw.rep}`
    if (!expected.has(key) || seen.has(key)) {
      throw new SegmentedProfileMatrixError(
        `final matrix has an unexpected or duplicate row '${key}'`,
      )
    }
    seen.add(key)
  }
  if (seen.size !== expected.size) {
    throw new SegmentedProfileMatrixError(
      `final matrix returned ${seen.size}/${expected.size} declared rows`,
    )
  }
}

function rowIdFor<TScenario extends Scenario, TArtifact>(
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
  profileId: string,
  scenarioId: string,
  rep: number,
): string {
  const row = plan.rows.find(
    (candidate) =>
      candidate.profileId === profileId &&
      candidate.scenarioId === scenarioId &&
      candidate.rep === rep,
  )
  if (!row)
    throw new SegmentedProfileMatrixError(`row is not declared: ${profileId}/${scenarioId}/${rep}`)
  return row.rowId
}

function profileDirectory(profileId: string): string {
  return profileId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function requireIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SegmentedProfileMatrixError(`${name} must be a non-empty string`)
  }
  return value
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
