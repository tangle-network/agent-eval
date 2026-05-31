/**
 * @experimental
 *
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
 * dispatch reported via `ctx.cost.observeTokens`, and runs `assertRealBackend`
 * BY CONSTRUCTION before returning — so a stub-backend run fails loudly instead
 * of reporting a clean 0/N leaderboard.
 *
 * Dispatch contract: a dispatch that calls an LLM MUST report usage via
 * `ctx.cost.observeTokens({ input, output })` (and cost via `ctx.cost.observe`).
 * A dispatch that reports zero tokens is indistinguishable from a stub and the
 * integrity guard treats it as one.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { type AgentProfile, agentProfileHash } from '../../agent-profile'
import { AgentEvalError } from '../../errors'
import {
  assertRealBackend,
  type BackendIntegrityReport,
  summarizeBackendIntegrity,
} from '../../integrity/backend-integrity'
import {
  type RunOutcome,
  type RunRecord,
  type RunSplitTag,
  validateRunRecord,
} from '../../run-record'
import { runCampaign } from '../run-campaign'
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

/** Thrown when the matrix is misconfigured (no profiles, a profile whose model
 *  lacks a snapshot version, etc.). Distinct from `BackendIntegrityError`,
 *  which signals a stub backend at run time. */
export class ProfileMatrixError extends AgentEvalError {
  constructor(message: string) {
    super('profile_matrix', message)
  }
}

/** Dispatch for one cell: render `profile` against `scenario`, returning the
 *  artifact the judges score. Report LLM usage via `ctx.cost.observeTokens`
 *  and `ctx.cost.observe` — the integrity guard depends on it. */
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
  /** Max concurrent cells WITHIN each profile's campaign. Default 2.
   *  Profiles run sequentially so the cost ceiling is honored deterministically. */
  maxConcurrency?: number
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
  /** Mean composite across this profile's records. */
  meanComposite: number
  totalCostUsd: number
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

function cellComposite(cell: CampaignCellResult<unknown>): number {
  const composites = Object.values(cell.judgeScores).map((s) => s.composite)
  return composites.length === 0 ? 0 : mean(composites)
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
  scenario?: TScenario
  corpusText?: (
    artifact: TArtifact,
    scenario: TScenario,
  ) => { prompt: string; completion: string } | undefined
}

function buildRunRecord<TScenario extends Scenario, TArtifact>(
  args: BuildRecordArgs<TScenario, TArtifact>,
): RunRecord {
  const { cell, profile, profileHash, configHash, experimentId, splitTag, commitSha, matrixId } =
    args
  const composite = cellComposite(cell)

  // Flatten judge dimensions (judge-prefixed to avoid collisions) into raw.
  const raw: Record<string, number> = { composite }
  const perJudge: Record<string, Record<string, number>> = {}
  const dimAccum: Record<string, number[]> = {}
  const notes: string[] = []
  for (const [judgeName, js] of Object.entries(cell.judgeScores)) {
    perJudge[judgeName] = { ...js.dimensions }
    for (const [dim, value] of Object.entries(js.dimensions)) {
      raw[`${judgeName}.${dim}`] = value
      dimAccum[dim] ??= []
      dimAccum[dim]!.push(value)
    }
    if (js.notes) notes.push(`${judgeName}: ${js.notes}`)
  }
  const perDimMean: Record<string, number> = {}
  for (const [dim, values] of Object.entries(dimAccum)) perDimMean[dim] = mean(values)

  // Cost / efficiency guardrail dimensions — RAW-ONLY. The composite stays the
  // judge objective (anti-Goodhart); these are tracked + dashboarded + carried
  // into the dataset, never optimized. Makes every run multi-dimensional by
  // construction (the cost/tokens/latency the cell already reports). Computed
  // ratios are guarded so a zero-cost stub or zero-quality cell never writes a
  // non-finite value into the raw bag.
  raw.cost_usd = cell.costUsd
  raw.tokens_input = cell.tokenUsage.input
  raw.tokens_output = cell.tokenUsage.output
  if (typeof cell.tokenUsage.cached === 'number') raw.tokens_cached = cell.tokenUsage.cached
  raw.latency_ms = cell.durationMs
  if (cell.costUsd > 0) {
    raw.tokens_per_dollar = (cell.tokenUsage.input + cell.tokenUsage.output) / cell.costUsd
  }
  if (composite > 0.01) raw.cost_per_quality = cell.costUsd / composite

  const outcome: RunOutcome =
    splitTag === 'holdout' ? { holdoutScore: composite, raw } : { searchScore: composite, raw }
  if (Object.keys(perJudge).length > 0) {
    outcome.judgeScores = {
      perJudge,
      perDimMean,
      composite,
      ...(notes.length > 0 ? { notes: notes.join(' | ') } : {}),
    }
  }

  const record: RunRecord & { prompt?: string; completion?: string } = {
    runId: `${matrixId}:${profile.id}:${cell.cellId}`,
    experimentId,
    candidateId: profile.id,
    seed: cell.seed,
    model: profile.model,
    promptHash: profileHash,
    configHash,
    commitSha,
    wallMs: cell.durationMs,
    costUsd: cell.costUsd,
    tokenUsage: cell.tokenUsage,
    outcome,
    splitTag,
    scenarioId: cell.scenarioId,
    ...(cell.error ? { failureMode: cell.error } : {}),
  }

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

export async function runProfileMatrix<TScenario extends Scenario, TArtifact>(
  opts: RunProfileMatrixOptions<TScenario, TArtifact>,
): Promise<RunProfileMatrixResult<TArtifact, TScenario>> {
  if (opts.profiles.length === 0) throw new ProfileMatrixError('profiles must not be empty')
  if (opts.scenarios.length === 0) throw new ProfileMatrixError('scenarios must not be empty')

  const splitTag = opts.splitTag ?? 'search'
  const seed = opts.seed ?? 42
  const validate = opts.validate ?? true
  const integrityMode = opts.integrity ?? 'assert'
  const profileIds = opts.profiles.map((p) => p.id)
  const experimentId =
    opts.experimentId ??
    `pm_${sha({ profileIds, scenarios: opts.scenarios.map((s) => s.id) }).slice(0, 16)}`
  const matrixId = `mtx_${sha({ experimentId, profileIds, seed, splitTag }).slice(0, 16)}`
  // Scenario lookup for the corpus-text extractor (records carry trajectory text).
  const scenarioById = new Map(opts.scenarios.map((s) => [s.id, s]))

  // Preflight: every profile must hash (non-empty model) AND its model must
  // carry a snapshot version, BEFORE any LLM spend. A probe record run through
  // validateRunRecord catches both in the exact place they'd otherwise surface
  // far downstream.
  for (const profile of opts.profiles) {
    const profileHash = agentProfileHash(profile)
    try {
      validateRunRecord({
        runId: `${matrixId}:${profile.id}:probe`,
        experimentId,
        candidateId: profile.id,
        seed,
        model: profile.model,
        promptHash: profileHash,
        configHash: profileHash,
        commitSha: opts.commitSha,
        wallMs: 0,
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        outcome:
          splitTag === 'holdout' ? { holdoutScore: 0, raw: {} } : { searchScore: 0, raw: {} },
        splitTag,
      })
    } catch (err) {
      throw new ProfileMatrixError(
        `profile '${profile.id}' is not recordable: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const records: RunRecord[] = []
  const campaigns: Record<string, CampaignResult<TArtifact, TScenario>> = {}
  const byProfile: Record<string, ProfileSummary> = {}

  for (const profile of opts.profiles) {
    const profileHash = agentProfileHash(profile)
    const configHash = sha({
      profile: profileHash,
      judges: (opts.judges ?? []).map((j) => j.name),
      seed,
      splitTag,
    })

    // Bind the profile into a campaign dispatch. Name it so the campaign's
    // manifest hash is stable + distinct per profile.
    const dispatch = (scenario: TScenario, ctx: DispatchContext): Promise<TArtifact> =>
      opts.dispatch(profile, scenario, ctx)
    Object.defineProperty(dispatch, 'name', { value: `profile_${sanitize(profile.id)}` })

    const campaign = await runCampaign<TScenario, TArtifact>({
      scenarios: opts.scenarios,
      dispatch,
      judges: opts.judges,
      seed,
      reps: opts.reps,
      maxConcurrency: opts.maxConcurrency,
      costCeiling: opts.costCeiling,
      labeledStore: opts.labeledStore,
      captureSource: opts.captureSource,
      storage: opts.storage,
      now: opts.now,
      runDir: join(opts.runDir, sanitize(profile.id)),
    })
    campaigns[profile.id] = campaign

    const profileRecords: RunRecord[] = []
    for (const cell of campaign.cells) {
      const record = buildRunRecord({
        cell,
        profile,
        profileHash,
        configHash,
        experimentId,
        splitTag,
        commitSha: opts.commitSha,
        matrixId,
        scenario: scenarioById.get(cell.scenarioId),
        corpusText: opts.corpusText,
      })
      if (validate) validateRunRecord(record)
      profileRecords.push(record)
      records.push(record)
    }

    byProfile[profile.id] = {
      profileId: profile.id,
      profileHash,
      model: profile.model,
      records: profileRecords.length,
      meanComposite: mean(profileRecords.map(compositeOf)),
      totalCostUsd: profileRecords.reduce((a, r) => a + r.costUsd, 0),
      integrity: summarizeBackendIntegrity(profileRecords),
    }
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

/** Composite for a produced RunRecord (the split score it carries). */
function compositeOf(r: RunRecord): number {
  return r.outcome.holdoutScore ?? r.outcome.searchScore ?? 0
}

function rollup(
  records: RunRecord[],
  keyOf: (r: RunRecord) => string | undefined,
): Record<string, ScenarioRollup> {
  const groups = new Map<string, number[]>()
  for (const r of records) {
    const key = keyOf(r)
    if (key === undefined) continue
    const arr = groups.get(key) ?? []
    arr.push(compositeOf(r))
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
