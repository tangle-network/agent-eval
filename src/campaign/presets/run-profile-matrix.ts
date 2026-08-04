/**
 * `runProfileMatrix` — the missing keystone between `runAgentMatrix` and the
 * backend-integrity guard.
 *
 * The gap it closes: `runAgentMatrix` is a topology-opaque scheduler whose
 * cells return a bare `{ output, verdict, costUsd }` — no `tokenUsage`, not a
 * `RunRecord`. `assertRealBackend` / `summarizeBackendIntegrity` key on
 * `RunRecord.tokenUsage`, so they cannot run on a raw matrix result. Every
 * consumer therefore hand-writes the same bridge: fan a profile × scenario
 * cartesian, call dispatch, fabricate a `RunRecord` with token usage, thread it
 * back, run the integrity guard. That hand-rolled bridge is exactly the pile of
 * bespoke `eval:*` scripts the adoption skills keep trying (and failing) to
 * forbid.
 *
 * `runProfileMatrix` IS that bridge, once:
 *
 *   - axis 3 (PROFILE) = `profiles: AgentProfile[]`
 *   - axis 1 (PERSONA/SCENARIO) = `scenarios: Scenario[]` (each scenario carries
 *     its persona; `personaOf` groups them for the `byPersona` pivot)
 *   - the scoring axis = `judges`
 *
 * It runs `runCampaign` once per profile (reusing its seeds, reps, bootstrap
 * CIs, resumability, and the `LabeledScenarioStore` capture flywheel), maps
 * every cell to a validated `RunRecord` carrying the real `tokenUsage` the
 * dispatch committed via `ctx.cost.runPaidCall`, and runs `assertRealBackend`
 * BY CONSTRUCTION before returning — so a stub-backend run fails loudly instead
 * of reporting a clean 0/N leaderboard.
 *
 * Dispatch contract: a dispatch that calls an LLM MUST report usage via
 * `ctx.cost.runPaidCall({ execute, receipt })`.
 * A dispatch that reports zero tokens is indistinguishable from a stub and the
 * integrity guard treats it as one.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  type AgentProfile,
  agentProfileHash,
  agentProfileId,
  agentProfileModelId,
  HARNESS_NATIVE_MODEL,
  harnessAxisOf,
} from '../../agent-profile'
import { type AgentProfileCell, buildAgentProfileCell } from '../../agent-profile-cell'
import { mapConcurrent } from '../../concurrency'
import type { CostProvenance } from '../../cost-ledger'
import { AgentEvalError } from '../../errors'
import {
  assertRealBackend,
  type BackendIntegrityReport,
  summarizeBackendIntegrity,
} from '../../integrity/backend-integrity'
import {
  modelHasSnapshot,
  type RunRecord,
  type RunSplitTag,
  runTaskScore,
  validateRunRecord,
} from '../../run-record'
import { runCampaign } from '../run-campaign'
import { campaignCellToRunRecord } from '../run-record'
import type { CampaignStorage } from '../storage'
import type {
  CampaignCellResult,
  CampaignResult,
  DispatchContext,
  JudgeConfig,
  LabeledScenarioSource,
  LabeledScenarioStore,
  Scenario,
} from '../types'

/** Thrown when the matrix is misconfigured (no profiles, missing resolved model evidence,
 *  etc.). Distinct from `BackendIntegrityError`,
 *  which signals a stub backend at run time. */
export class ProfileMatrixError extends AgentEvalError {
  constructor(message: string) {
    super('profile_matrix', message)
  }
}

/** Dispatch for one cell: render `profile` against `scenario`, returning the
 *  artifact the judges score. Run LLM work through `ctx.cost.runPaidCall` —
 *  the integrity check depends on its receipt. */
export type ProfileDispatchFn<TScenario extends Scenario, TArtifact> = (
  profile: AgentProfile,
  scenario: TScenario,
  ctx: DispatchContext,
) => Promise<TArtifact>

export interface RunProfileMatrixOptions<TScenario extends Scenario, TArtifact> {
  /** Axis 3 — the agent-under-test configurations. Each is one column. */
  profiles: AgentProfile[]
  /** Axis 1 — the persona/scenario corpus, run against every profile. */
  scenarios: TScenario[]
  /** Renders one (profile, scenario) cell. */
  dispatch: ProfileDispatchFn<TScenario, TArtifact>
  /** The scoring axis. */
  judges?: JudgeConfig<TArtifact, TScenario>[]
  /** Where each profile's campaign writes artifacts/traces. One subdir per
   *  profile. */
  runDir: string
  /** Git SHA the harness ran from — stamped onto every RunRecord (mandatory
   *  for paper-grade records). */
  commitSha: string
  /** Additional stable identity for dispatch behavior that can change without
   *  changing `commitSha`, such as a caller-owned executable or remote config. */
  dispatchRef?: string
  /** Logical experiment id shared across the whole matrix so the promotion
   *  gate can pair profiles on matched scenarios. Default: a hash of the
   *  profile + scenario ids. */
  experimentId?: string
  /** Which split these runs belong to. Default `'search'`. */
  splitTag?: RunSplitTag
  /** Replicates per (profile, scenario) cell for CI bands. Default 1. */
  reps?: number
  /** Campaign seed (per profile). Default 42. */
  seed?: number
  /**
   * Backend-integrity posture, enforced AFTER the matrix completes:
   *   - `'assert'` (default) — throw `BackendIntegrityError` if the run was a
   *     stub (and, with `allowMixed:false`, if it was mixed).
   *   - `'warn'` — log the verdict but never throw.
   *   - `'off'` — skip the guard entirely (only for offline/replay analysis).
   */
  integrity?: 'assert' | 'warn' | 'off'
  /** Forwarded to `assertRealBackend`. Default true (tolerate partial 429
   *  cascades); set false for strict CI gates. */
  allowMixed?: boolean
  /** Max concurrent cells WITHIN each profile's campaign. Default 2. */
  maxConcurrency?: number
  /** Max profile campaigns in flight. Default 1. Each profile keeps its own
   *  run directory and cost ceiling; raise this when those resources are independent. */
  maxProfileConcurrency?: number
  /** Cumulative USD cap per profile campaign. */
  costCeiling?: number
  /** Capture flywheel — forwarded to each campaign. */
  labeledStore?: LabeledScenarioStore | 'off'
  captureSource?: LabeledScenarioSource
  /** Storage backend. Default `fsCampaignStorage`. Pass
   *  `inMemoryCampaignStorage()` for edge/CF-Worker/test runs. */
  storage?: CampaignStorage
  /** Test seam — override the wall clock. */
  now?: () => Date
  /** Optional persona key per scenario — drives the `byPersona` pivot. When
   *  unset, `byPersona` is omitted. */
  personaOf?: (scenario: TScenario) => string
  /** Validate every produced RunRecord with `validateRunRecord` (fail-loud).
   *  Default true — catches bad model snapshots and non-finite judge dims at
   *  the boundary instead of letting them poison downstream analysis. */
  validate?: boolean
  /** Corpus-by-default: derive the trajectory text (`prompt` + `completion`)
   *  for each cell from its artifact + scenario. When set, every produced
   *  record carries `prompt`/`completion` (a `CorpusRecord`) so the run's
   *  graded trajectories can be appended to the durable RL corpus with no
   *  side-channel — `appendToCorpus(result.records, path)`. Fail-soft: a
   *  throwing or undefined-returning extractor just omits the text. */
  corpusText?: (
    artifact: TArtifact,
    scenario: TScenario,
  ) => { prompt: string; completion: string } | undefined
}

export interface ProfileSummary {
  profileId: string
  profileHash: string
  model: string
  /** RunRecords produced for this profile (= scenarios × reps). */
  records: number
  /** Mean across scored records, or null when the profile has no task labels. */
  meanComposite: number | null
  /** Total cost, or null when any call's cost was not captured. */
  totalCostUsd: number | null
  costProvenance: CostProvenance
  /** Per-profile integrity verdict — surfaces a single profile that ran stub
   *  even when the matrix as a whole looks real. */
  integrity: BackendIntegrityReport
}

export interface ScenarioRollup {
  meanComposite: number
  n: number
}

export interface RunProfileMatrixResult<TArtifact, TScenario extends Scenario> {
  matrixId: string
  experimentId: string
  /** One RunRecord per (profile, scenario, rep) cell — the integrity-checked,
   *  paper-grade output. Feed straight into `analyzeRuns`, `HeldOutGate`,
   *  scorecards, the hosted wire format. */
  records: RunRecord[]
  byProfile: Record<string, ProfileSummary>
  byScenario: Record<string, ScenarioRollup>
  /** Present only when `personaOf` was supplied. */
  byPersona?: Record<string, ScenarioRollup>
  /** Whole-matrix integrity report (the one `integrity:'assert'` enforces). */
  integrity: BackendIntegrityReport
  /** The raw per-profile campaign results, keyed by profile id. */
  campaigns: Record<string, CampaignResult<TArtifact, TScenario>>
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function sha(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

interface BuildRecordArgs<TScenario extends Scenario, TArtifact> {
  cell: CampaignCellResult<TArtifact>
  profile: AgentProfile
  profileHash: string
  configHash: string
  experimentId: string
  splitTag: RunSplitTag
  commitSha: string
  matrixId: string
  /** The (profile, harness, model, dimensions) identity of this cell — attached to
   *  every record so results group by the canonical `groupRunsByAgentProfileCell`
   *  (harness/model aware) instead of profileId alone. */
  agentProfileCell?: AgentProfileCell
  scenario?: TScenario
  corpusText?: (
    artifact: TArtifact,
    scenario: TScenario,
  ) => { prompt: string; completion: string } | undefined
}

function receiptModels(cell: CampaignCellResult<unknown>): string[] {
  const reported = cell.resolvedModels ?? (cell.resolvedModel ? [cell.resolvedModel] : [])
  return [...new Set(reported.map((model) => model.trim()).filter(Boolean))]
}

/** Resolve and validate every paid-call model used by one cell. */
function recordModel(
  cell: CampaignCellResult<unknown>,
  profileId: string,
  declaredModel: string,
): string {
  const reported = receiptModels(cell)
  if (modelHasSnapshot(declaredModel)) {
    for (const model of reported) {
      if (model !== declaredModel) {
        throw new ProfileMatrixError(
          `profile '${profileId}' paid-call model '${model}' for cell '${cell.cellId}' does not match its declared exact model '${declaredModel}'`,
        )
      }
    }
    return declaredModel
  }

  if (reported.length === 0) {
    throw new ProfileMatrixError(
      `profile '${profileId}' declared a moving model but its dispatch reported no resolved model for cell '${cell.cellId}' — return a snapshot-bearing model in the ctx.cost.runPaidCall receipt`,
    )
  }
  for (const model of reported) {
    if (!modelHasSnapshot(model)) {
      throw new ProfileMatrixError(
        `profile '${profileId}' resolved to model '${model}' for cell '${cell.cellId}', which lacks a snapshot version — pin it in the paid-call receipt`,
      )
    }
    if (declaredModel !== HARNESS_NATIVE_MODEL && !sameMovingModel(declaredModel, model)) {
      throw new ProfileMatrixError(
        `profile '${profileId}' declared model '${declaredModel}' but cell '${cell.cellId}' reported unrelated snapshot '${model}'`,
      )
    }
  }
  if (reported.length !== 1) {
    throw new ProfileMatrixError(
      `profile '${profileId}' cell '${cell.cellId}' reported multiple paid-call model snapshots: ${reported.join(', ')}`,
    )
  }
  return reported[0]!
}

function sameMovingModel(declared: string, resolved: string): boolean {
  const resolvedBase = resolved
    .replace(/@[^/]+$/u, '')
    .replace(/-\d{8}$/u, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/u, '')
    .replace(/-\d{4}$/u, '')
    .replace(/:date-[^/]+$/u, '')
  return (
    resolvedBase === declared ||
    resolvedBase.endsWith(`/${declared}`) ||
    declared.endsWith(`/${resolvedBase}`)
  )
}

function buildRunRecord<TScenario extends Scenario, TArtifact>(
  args: BuildRecordArgs<TScenario, TArtifact>,
): RunRecord {
  const { cell, profile, profileHash, configHash, experimentId, splitTag, commitSha, matrixId } =
    args
  const profileId = agentProfileId(profile)
  const declaredModel = agentProfileModelId(profile)
  // Every record pins a snapshot. When a profile intentionally carries the provider-facing
  // moving alias, the paid-call receipt supplies the immutable identity used here.
  const model = recordModel(cell, profileId, declaredModel)
  const record = campaignCellToRunRecord(cell, {
    runId: `${matrixId}:${profileId}:${cell.cellId}`,
    experimentId,
    candidateId: profileId,
    model,
    promptHash: profileHash,
    configHash,
    commitSha,
    splitTag,
    agentProfile: args.agentProfileCell,
  }) as RunRecord & { prompt?: string; completion?: string }

  // Corpus-by-default: stamp the trajectory text onto the record (CorpusRecord
  // shape — the validator ignores the extra keys) so the run is dataset-able
  // with no side-channel. Fail-soft: a bad extractor never fails the run.
  if (args.corpusText && args.scenario) {
    try {
      const text = args.corpusText(cell.artifact, args.scenario)
      if (text && typeof text.prompt === 'string' && typeof text.completion === 'string') {
        record.prompt = text.prompt
        record.completion = text.completion
      }
    } catch {
      // extractor threw — omit trajectory text, keep the graded record.
    }
  }
  return record
}

/**
 * Profile × scenario matrix runner: fan N agent profiles across M scenarios, project each cell to a validated `RunRecord` with real token usage, and enforce the backend-integrity guard before returning.
 */
export async function runProfileMatrix<TScenario extends Scenario, TArtifact>(
  opts: RunProfileMatrixOptions<TScenario, TArtifact>,
): Promise<RunProfileMatrixResult<TArtifact, TScenario>> {
  if (opts.profiles.length === 0) throw new ProfileMatrixError('profiles must not be empty')
  if (opts.scenarios.length === 0) throw new ProfileMatrixError('scenarios must not be empty')

  const splitTag = opts.splitTag ?? 'search'
  const seed = opts.seed ?? 42
  const validate = opts.validate ?? true
  const integrityMode = opts.integrity ?? 'assert'
  const maxProfileConcurrency = opts.maxProfileConcurrency ?? 1
  const profileIds = opts.profiles.map(agentProfileId)
  if (opts.dispatchRef !== undefined && opts.dispatchRef.trim().length === 0) {
    throw new ProfileMatrixError('dispatchRef must be a non-empty string when provided')
  }
  const duplicateProfileIds = profileIds.filter((id, index) => profileIds.indexOf(id) !== index)
  if (duplicateProfileIds.length > 0) {
    throw new ProfileMatrixError(
      `duplicate agentProfileId values are not allowed: ${[...new Set(duplicateProfileIds)].join(', ')}`,
    )
  }
  const experimentId =
    opts.experimentId ??
    `pm_${sha({ profileIds, scenarios: opts.scenarios.map((s) => s.id) }).slice(0, 16)}`
  const matrixId = `mtx_${sha({
    experimentId,
    profileIds,
    seed,
    splitTag,
    commitSha: opts.commitSha,
    dispatchRef: opts.dispatchRef ?? null,
  }).slice(0, 16)}`
  // Scenario lookup for the corpus-text extractor (records carry trajectory text).
  const scenarioById = new Map(opts.scenarios.map((s) => [s.id, s]))

  // Preflight: every profile must hash and every static record field must validate before spend.
  //
  // A moving provider alias or `HARNESS_NATIVE_MODEL` cannot be a durable record identity.
  // Probe it with a placeholder here so the remaining profile checks still run before spend;
  // every completed cell must later supply its actual snapshot in the paid-call receipt.
  for (const profile of opts.profiles) {
    const profileHash = agentProfileHash(profile)
    const profileId = agentProfileId(profile)
    const declaredModel = agentProfileModelId(profile)
    const model = modelHasSnapshot(declaredModel)
      ? declaredModel
      : `${declaredModel}@runtime-resolved`
    try {
      validateRunRecord({
        runId: `${matrixId}:${profileId}:probe`,
        experimentId,
        candidateId: profileId,
        seed,
        model,
        promptHash: profileHash,
        configHash: profileHash,
        commitSha: opts.commitSha,
        wallMs: 0,
        costUsd: null,
        costProvenance: { kind: 'uncaptured', usd: null },
        tokenUsage: { input: 0, output: 0 },
        terminalOutcome: 'succeeded',
        outcome: { raw: { execution_error_count: 0 } },
        splitTag,
        scenarioId: 'recordability-probe',
      })
    } catch (err) {
      throw new ProfileMatrixError(
        `profile '${profileId}' is not recordable: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const records: RunRecord[] = []
  const campaigns: Record<string, CampaignResult<TArtifact, TScenario>> = {}
  const byProfile: Record<string, ProfileSummary> = {}

  const columns = await mapConcurrent(
    opts.profiles,
    maxProfileConcurrency,
    async (profile, _index, signal) => {
      const profileHash = agentProfileHash(profile)
      const profileId = agentProfileId(profile)
      const declaredModel = agentProfileModelId(profile)
      const configHash = sha({
        profile: profileHash,
        judges: (opts.judges ?? []).map((j) => j.name),
        seed,
        splitTag,
        dispatchRef: opts.dispatchRef ?? null,
      })
      const dispatchRef = `profile-matrix:${sha({
        commitSha: opts.commitSha,
        caller: opts.dispatchRef ?? null,
        profileId,
        profileHash,
        configHash,
      })}`

      // Bind the profile into a campaign dispatch. Name it so the campaign's
      // manifest hash is stable + distinct per profile.
      const dispatch = (scenario: TScenario, ctx: DispatchContext): Promise<TArtifact> =>
        opts.dispatch(profile, scenario, ctx)
      Object.defineProperty(dispatch, 'name', { value: `profile_${sanitize(profileId)}` })

      const campaign = await runCampaign<TScenario, TArtifact>({
        scenarios: opts.scenarios,
        dispatch,
        dispatchRef,
        signal,
        judges: opts.judges,
        seed,
        reps: opts.reps,
        maxConcurrency: opts.maxConcurrency,
        costCeiling: opts.costCeiling,
        labeledStore: opts.labeledStore,
        captureSource: opts.captureSource,
        storage: opts.storage,
        now: opts.now,
        runDir: join(opts.runDir, sanitize(profileId)),
      })

      // The canonical (profile, harness, model) identity for every record in this
      // column, so results group by `groupRunsByAgentProfileCell` (harness/model
      // aware). Harness comes from the axis stamp `expandProfileAxes` left on the
      // profile; a profile that wasn't axis-expanded simply has no harness in its
      // cell (unchanged grouping). A moving model alias means the cell identity
      // must carry the resolved snapshot per cell (surfaced via
      // `cell.resolvedModels`), so the pivot groups by the model that actually ran and
      // the cell identity matches the RunRecord's pinned model.
      const axis = harnessAxisOf(profile)
      const buildCellIdentity = (cellModel: string): Promise<AgentProfileCell> =>
        buildAgentProfileCell({
          profileId,
          sourceProfile: { kind: 'agent-interface-profile', hash: profileHash },
          model: cellModel,
          ...(axis ? { harness: { id: axis.harness } } : {}),
        })
      // A profile with a pinned declared model builds its cell identity once and
      // shares it; a moving alias builds one per cell after resolution.
      const sharedCellIdentity = modelHasSnapshot(declaredModel)
        ? await buildCellIdentity(declaredModel)
        : undefined

      const profileRecords: RunRecord[] = []
      for (const cell of campaign.cells) {
        const agentProfileCell =
          sharedCellIdentity ??
          (await buildCellIdentity(recordModel(cell, profileId, declaredModel)))
        const record = buildRunRecord({
          cell,
          profile,
          profileHash,
          configHash,
          experimentId,
          splitTag,
          commitSha: opts.commitSha,
          matrixId,
          agentProfileCell,
          scenario: scenarioById.get(cell.scenarioId),
          corpusText: opts.corpusText,
        })
        if (validate) validateRunRecord(record)
        profileRecords.push(record)
      }

      const recordedModels = [...new Set(profileRecords.map((record) => record.model))]
      if (recordedModels.length > 1) {
        throw new ProfileMatrixError(
          `profile '${profileId}' resolved to multiple model snapshots: ${recordedModels.join(', ')}`,
        )
      }

      const costProvenance = campaign.aggregates.cost.costProvenance
      const totalCostUsd = costProvenance.kind === 'uncaptured' ? null : costProvenance.usd
      return {
        profileId,
        campaign,
        records: profileRecords,
        summary: {
          profileId,
          profileHash,
          model: recordedModels[0] ?? declaredModel,
          records: profileRecords.length,
          meanComposite: meanOrNull(
            profileRecords.map(scoreOf).filter((score): score is number => score !== undefined),
          ),
          totalCostUsd,
          costProvenance,
          integrity: summarizeBackendIntegrity(profileRecords),
        },
      }
    },
  )

  // Merge in caller order so concurrency cannot change output or report ordering.
  for (const column of columns) {
    campaigns[column.profileId] = column.campaign
    byProfile[column.profileId] = column.summary
    records.push(...column.records)
  }

  // Integrity by construction — the whole point of the primitive.
  const integrity = summarizeBackendIntegrity(records)
  if (integrityMode === 'assert') {
    assertRealBackend(records, { allowMixed: opts.allowMixed ?? true })
  } else if (integrityMode === 'warn' && integrity.verdict !== 'real') {
    // eslint-disable-next-line no-console
    console.warn(
      `[runProfileMatrix] backend integrity: ${integrity.verdict} — ${integrity.diagnosis}`,
    )
  }

  // Pivots.
  const byScenario = rollup(records, (r) => r.scenarioId)
  const byPersona = opts.personaOf
    ? rollupByPersona(records, opts.scenarios, opts.personaOf)
    : undefined

  return { matrixId, experimentId, records, byProfile, byScenario, byPersona, integrity, campaigns }
}

/** Score for a produced RunRecord, absent when the campaign cell was unscored.
 *  Ungated (`runTaskScore` is raw) — a matrix pivot reports measured scores;
 *  it is not a training input. */
function scoreOf(r: RunRecord): number | undefined {
  return runTaskScore(r)
}

function meanOrNull(values: number[]): number | null {
  return values.length === 0 ? null : mean(values)
}

function rollup(
  records: RunRecord[],
  keyOf: (r: RunRecord) => string | undefined,
): Record<string, ScenarioRollup> {
  const groups = new Map<string, number[]>()
  for (const r of records) {
    const key = keyOf(r)
    if (key === undefined) continue
    const score = scoreOf(r)
    if (score === undefined) continue
    const arr = groups.get(key) ?? []
    arr.push(score)
    groups.set(key, arr)
  }
  const out: Record<string, ScenarioRollup> = {}
  for (const [key, xs] of groups) out[key] = { meanComposite: mean(xs), n: xs.length }
  return out
}

function rollupByPersona<TScenario extends Scenario>(
  records: RunRecord[],
  scenarios: TScenario[],
  personaOf: (s: TScenario) => string,
): Record<string, ScenarioRollup> {
  const personaByScenarioId = new Map<string, string>()
  for (const s of scenarios) personaByScenarioId.set(s.id, personaOf(s))
  return rollup(records, (r) => (r.scenarioId ? personaByScenarioId.get(r.scenarioId) : undefined))
}
