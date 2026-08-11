/**
 * Paper-grade RunRecord schema + runtime validator.
 *
 * Every run that participates in a promotion gate, paper table, or
 * researcher loop SHOULD be recorded as a `RunRecord`. The mandatory
 * fields are exactly those the paper "Two Loops, Three Roles" requires
 * for reproducibility: who/what/when/cost/seed/hash, plus the search vs
 * holdout split tag. A task score is optional because execution-only records
 * must preserve missing labels instead of converting errors into zero quality.
 *
 * This is intentionally NOT a replacement for the rich `Run` /
 * `ProposeReviewReport` / `ScenarioResult` types already in the
 * package. Those are runtime structures with full provenance. A
 * `RunRecord` is the analysis-time projection — the JSON-friendly
 * row you'd put in a parquet file or paste into a notebook.
 *
 * Validate at the boundary:
 *
 *   const rec = validateRunRecord(rawJson)         // throws on missing
 *   const ok  = isRunRecord(rawJson)               // boolean check
 *   const rec = parseRunRecordSafe(rawJson)        // { ok, value | error }
 *
 * The validator runs in pure TS — zod is intentionally NOT a
 * dependency. Round-trip tested in `tests/run-record.test.ts`.
 */

import type { AgentProfileCell } from './agent-profile-cell'
import { validateAgentProfileCell } from './agent-profile-cell'
import type { CostProvenance } from './cost-ledger'
import { ValidationError } from './errors'
// Value import of a leaf module that itself imports only this file's TYPES —
// no runtime cycle. It keeps the raw split-score derivation spelled in exactly
// one place (see `rollout/score-derivation-guard`).
import { observedScore } from './rollout/reward'
import { FAILURE_CLASSES, type FailureClass } from './trace/schema'

/** Search/dev/holdout split tag. 'search' is the paper-grade alias for the
 *  combined train+test pool that the optimizer is allowed to read. */
export type RunSplitTag = 'search' | 'dev' | 'holdout'

/**
 * Explicit execution-lifecycle result for a run.
 *
 * This is separate from task quality (`outcome`) and failure classification.
 * Producers set it only from root-run or process evidence.
 */
export type RunTerminalOutcome = 'succeeded' | 'failed' | 'cancelled' | 'incomplete' | 'unknown'

export interface RunTokenUsage {
  input: number
  /** All generated tokens charged as output, including reasoning tokens. */
  output: number
  /** Present only when one or more paid calls did not report token usage.
   *  In that case, every numeric field is a known subtotal, not a measured total. */
  tokensKnown?: false
  /** Reasoning-token subset of `output`, when the provider reports it. */
  reasoning?: number
  /** Prompt tokens served from a provider cache. */
  cached?: number
  /** Prompt tokens written into a provider cache. */
  cacheWrite?: number
}

/** How a run's USD amount was obtained. */
export type RunCostProvenance = CostProvenance

export interface RunJudgeMetadata {
  model: string
  promptVersion: string
  /** [0,1] confidence the judge declared. Constant judge confidence
   *  across many runs is a fallback signal (see `canary.ts`). */
  confidence: number
  /** True if the judge degraded to a fallback path (rules-only,
   *  prior-call cache, etc.). The canary uses this to alert. */
  fallback: boolean
}

/**
 * Per-judge / per-dimension breakdown for runs scored by an ensemble of
 * judges over a multi-dimensional rubric.
 *
 * The collapsed `outcome.searchScore` / `holdoutScore` carries the
 * composite the gate uses. The full breakdown belongs here so consumers
 * can answer "which judge disagreed?", "which dimension dragged the
 * composite down?", and "did half the panel fail?" without re-running.
 *
 * `perJudge[judgeId][dim]` is the canonical source; `perDimMean` and
 * `composite` are convenience projections — derivable but precomputed so
 * downstream IRR primitives (`interRaterReliability`,
 * `corpusInterRaterAgreement`) and reporters don't pay the same
 * aggregation twice.
 *
 * Fail-loud discipline: judges that errored out land in `failedJudges`
 * by id. A missing key in `perJudge` is ambiguous (silent zero vs not
 * run); the explicit list makes a partial-failure recorded as such.
 */
export interface JudgeScoresRecord {
  /** Per-judge per-dimension scores. `{ "kimi-k2.6": { helpfulness: 0.8, clarity: 0.7 }, ... }`. */
  perJudge: Record<string, Record<string, number>>
  /** Per-dim mean across judges. Convenience — derivable from `perJudge`. */
  perDimMean: Record<string, number>
  /** Composite mean across successful judges. Mirrors the task score only
   *  when `failedJudges` is empty. */
  composite: number
  /** Judges that errored or returned an unparseable verdict. Recorded
   *  by id (e.g. `['glm-5.1']`) so a partial-failure case is explicit,
   *  not inferred from missing keys in `perJudge`. */
  failedJudges?: string[]
  /** Free-form notes the judges emitted (joined across judges or
   *  first-judge only — consumer's choice). */
  notes?: string
}

export interface RunOutcome {
  /** Score on the search/optimization split. Optional for holdout-only and
   *  execution-only records. */
  searchScore?: number
  /** Score on the held-out split. Optional for search-only and execution-only
   *  records. When both scores are absent, the run is explicitly unlabeled. */
  holdoutScore?: number
  /** Bag of any other metric the run produced — judge dimensions,
   *  pass/fail counters, latency stats, etc. Numeric only — keeps
   *  reporters honest. */
  raw: Record<string, number>
  /** Per-judge / per-dim breakdown. Consumers writing ensemble
   *  judgements populate this; substrate primitives like
   *  `interRaterReliability` and `corpusInterRaterAgreement` accept
   *  these records as input. Optional — single-judge or scalar-only
   *  runs leave it unset. */
  judgeScores?: JudgeScoresRecord
  /** Authenticity / realness verdict — did the run build the REAL thing on the
   *  intended infra, or fake it (see `./authenticity`)? Optional: only domains
   *  with an authenticity config populate it. Carried in the corpus so the
   *  flywheel / off-policy learning can optimize for real completion, not gamed
   *  pass-rate. `score` is 0-1; `gated` is the anti-Goodhart flag — a gated run
   *  must not count as a real success regardless of `score`. */
  realness?: { score: number; gated: boolean; reason?: string }
}

/**
 * Mandatory paper-grade fields for a single evaluation run. Optional
 * fields are extension points; mandatory fields throw if missing.
 *
 * Hash discipline:
 *   - `promptHash` is the sha256 of the EFFECTIVE prompt sent to the
 *     model (after any steering bundle merge).
 *   - `configHash` is the sha256 of the effective run config (model,
 *     temperature, tools, judges, splits). The pair (promptHash,
 *     configHash) uniquely identifies an experiment cell.
 *
 * Model snapshot discipline:
 *   - `model` MUST encode a snapshot version. Bare aliases like
 *     `claude-sonnet-4` or `gpt-4o` are banned — they remap silently.
 *     Use `claude-sonnet-4-6@2025-04-15` or `gpt-4o-2024-11-20`.
 */
export interface RunRecord {
  /** UUID for the run. */
  runId: string
  /** Logical experiment grouping (a treatment vs a baseline within
   *  the same sweep should share `experimentId`). */
  experimentId: string
  /** Stable identifier for the candidate (variant) being run. The
   *  promotion gate compares two `candidateId`s on matched items. */
  candidateId: string
  /** RNG seed for the run. Always recorded — silent re-seeding is
   *  the most common cause of non-reproducible numbers. */
  seed: number
  /** Model identifier WITH snapshot version. */
  model: string
  /** sha256 of the effective prompt (post-steering). */
  promptHash: string
  /** sha256 of the effective config. */
  configHash: string
  /** Git SHA the harness was run from. */
  commitSha: string
  /** End-to-end wall-clock duration in milliseconds. */
  wallMs: number
  /** Time spent queued before execution started, if known. */
  queueMs?: number
  /** Total USD cost, or null when the producer could not capture one. */
  costUsd: number | null
  /** Whether `costUsd` came from billing data, a price calculation, or is unavailable. */
  costProvenance: RunCostProvenance
  /** Token usage breakdown. */
  tokenUsage: RunTokenUsage
  /** Root-run or process terminal result. Never inferred from a child span. */
  terminalOutcome: RunTerminalOutcome
  /** Root-run or process failure reason. Valid only for a failed, cancelled,
   *  or incomplete terminal result; never populated from a child span. */
  terminalFailureReason?: string
  /** Judge-side metadata, if a judge was used. */
  judgeMetadata?: RunJudgeMetadata
  /** Per-split scores + raw bag. */
  outcome: RunOutcome
  /** Canonical task-failure class drawn from the shared
   *  `FAILURE_CLASSES` taxonomy. Producers set it only from task-result
   *  evidence. Execution errors belong in
   *  `outcome.raw.execution_error_count`. */
  failureClass?: FailureClass
  /** Free-form task-failure detail scoped under a non-success
   *  `failureClass`. It is invalid without that class. */
  failureMode?: string
  /** Which split this run was drawn from. */
  splitTag: RunSplitTag
  /**
   * Stable scenario identifier the run observed or was scored against.
   * Comparison primitives match this identity rather than input order.
   */
  scenarioId: string
  /**
   * Canonical identity for the agent profile cell that produced this row:
   * profile artifact hash plus optional harness/model/prompt/reporting
   * dimensions. Use `agentProfile.cellId` to group persona sweeps and
   * longitudinal reports by the complete source profile, not by a loose
   * candidate label or opaque config hash.
   */
  agentProfile?: AgentProfileCell
}

/**
 * Canonical task-result classification.
 *
 * A producer may omit classification, record explicit success, or attach
 * domain-specific detail to a non-success class. Detail can never stand alone.
 * Execution errors belong in `outcome.raw.execution_error_count`.
 */
export type RunTaskFailure =
  | { failureClass?: undefined; failureMode?: undefined }
  | { failureClass: 'success'; failureMode?: undefined }
  | {
      failureClass: Exclude<FailureClass, 'success'>
      failureMode?: string
    }

/**
 * Return task quality, preferring held-out evidence when both scores exist.
 *
 * RAW: no realness protection is applied. Built on `observedScore` rather
 * than repeating the split derivation, so only `rollout/reward.ts` reads the
 * raw fields. Anything that becomes training data must use `trainingScore` or
 * `trainingReward` instead.
 */
export function runTaskScore(record: RunRecord): number | undefined {
  const score = observedScore(record)
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined
}

// ── Validation ───────────────────────────────────────────────────────

const MANDATORY_TOP_LEVEL = [
  'runId',
  'experimentId',
  'candidateId',
  'seed',
  'model',
  'promptHash',
  'configHash',
  'commitSha',
  'wallMs',
  'costUsd',
  'costProvenance',
  'tokenUsage',
  'terminalOutcome',
  'outcome',
  'splitTag',
  'scenarioId',
] as const

const SPLIT_TAGS: ReadonlyArray<RunSplitTag> = ['search', 'dev', 'holdout']
const TERMINAL_OUTCOMES: ReadonlyArray<RunTerminalOutcome> = [
  'succeeded',
  'failed',
  'cancelled',
  'incomplete',
  'unknown',
]

export class RunRecordValidationError extends ValidationError {
  readonly path: string
  constructor(message: string, path = '') {
    super(path ? `${message} (at ${path})` : message)
    this.path = path
  }
}

/**
 * Strict validator. Throws `RunRecordValidationError` on the first
 * missing or wrongly-typed field. Returns the input cast to
 * `RunRecord` on success — the validator does not coerce.
 */
export function validateRunRecord(input: unknown): RunRecord {
  if (input === null || typeof input !== 'object') {
    throw new RunRecordValidationError('expected object')
  }
  const obj = input as Record<string, unknown>

  for (const key of MANDATORY_TOP_LEVEL) {
    if (!(key in obj)) {
      throw new RunRecordValidationError(`missing mandatory field "${key}"`)
    }
  }

  expectString(obj.runId, 'runId')
  expectString(obj.experimentId, 'experimentId')
  expectString(obj.candidateId, 'candidateId')
  expectFiniteNumber(obj.seed, 'seed')
  expectString(obj.model, 'model')
  expectString(obj.promptHash, 'promptHash')
  expectString(obj.configHash, 'configHash')
  expectString(obj.commitSha, 'commitSha')
  expectNonNegativeNumber(obj.wallMs, 'wallMs')
  if (obj.queueMs !== undefined) expectNonNegativeNumber(obj.queueMs, 'queueMs')
  validateCost(obj.costUsd, obj.costProvenance)

  // Snapshot discipline: bare model aliases are not paper-grade.
  if (!modelHasSnapshot(obj.model as string)) {
    throw new RunRecordValidationError(
      `model "${obj.model}" lacks a snapshot version (use 'name@YYYY-MM-DD' or 'name-YYYYMMDD')`,
      'model',
    )
  }

  // Token usage.
  const tu = obj.tokenUsage
  if (tu === null || typeof tu !== 'object') {
    throw new RunRecordValidationError('tokenUsage must be an object', 'tokenUsage')
  }
  const tuRec = tu as Record<string, unknown>
  expectNonNegativeNumber(tuRec.input, 'tokenUsage.input')
  expectNonNegativeNumber(tuRec.output, 'tokenUsage.output')
  if (tuRec.tokensKnown !== undefined && tuRec.tokensKnown !== false) {
    throw new RunRecordValidationError(
      'tokensKnown must be false when present; omit it when token usage is complete',
      'tokenUsage.tokensKnown',
    )
  }
  if (tuRec.reasoning !== undefined) {
    expectNonNegativeNumber(tuRec.reasoning, 'tokenUsage.reasoning')
    if ((tuRec.reasoning as number) > (tuRec.output as number)) {
      throw new RunRecordValidationError(
        'reasoning tokens must be a subset of output tokens',
        'tokenUsage.reasoning',
      )
    }
  }
  if (tuRec.cached !== undefined) expectNonNegativeNumber(tuRec.cached, 'tokenUsage.cached')
  if (tuRec.cacheWrite !== undefined) {
    expectNonNegativeNumber(tuRec.cacheWrite, 'tokenUsage.cacheWrite')
  }

  // Judge metadata, optional.
  if (obj.judgeMetadata !== undefined) {
    const jm = obj.judgeMetadata
    if (jm === null || typeof jm !== 'object') {
      throw new RunRecordValidationError('judgeMetadata must be an object', 'judgeMetadata')
    }
    const jmRec = jm as Record<string, unknown>
    expectString(jmRec.model, 'judgeMetadata.model')
    expectString(jmRec.promptVersion, 'judgeMetadata.promptVersion')
    expectFiniteNumber(jmRec.confidence, 'judgeMetadata.confidence')
    if (typeof jmRec.fallback !== 'boolean') {
      throw new RunRecordValidationError(
        'judgeMetadata.fallback must be boolean',
        'judgeMetadata.fallback',
      )
    }
  }

  // Outcome.
  const out = obj.outcome
  if (out === null || typeof out !== 'object') {
    throw new RunRecordValidationError('outcome must be an object', 'outcome')
  }
  const outRec = out as Record<string, unknown>
  if (outRec.searchScore !== undefined)
    expectFiniteNumber(outRec.searchScore, 'outcome.searchScore')
  if (outRec.holdoutScore !== undefined)
    expectFiniteNumber(outRec.holdoutScore, 'outcome.holdoutScore')
  const raw = outRec.raw
  if (raw === null || typeof raw !== 'object') {
    throw new RunRecordValidationError('outcome.raw must be an object', 'outcome.raw')
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    expectFiniteNumber(v, `outcome.raw.${k}`)
  }
  // Realness verdict, optional.
  if (outRec.realness !== undefined) {
    const r = outRec.realness
    if (r === null || typeof r !== 'object') {
      throw new RunRecordValidationError('outcome.realness must be an object', 'outcome.realness')
    }
    const rr = r as Record<string, unknown>
    expectFiniteNumber(rr.score, 'outcome.realness.score')
    if (typeof rr.gated !== 'boolean') {
      throw new RunRecordValidationError(
        'outcome.realness.gated must be a boolean',
        'outcome.realness.gated',
      )
    }
  }

  // Per-judge / per-dim breakdown, optional.
  if (outRec.judgeScores !== undefined) {
    validateJudgeScores(outRec.judgeScores, 'outcome.judgeScores')
  }

  // Failure mode optional.
  if (
    obj.failureClass !== undefined &&
    (typeof obj.failureClass !== 'string' ||
      !FAILURE_CLASSES.includes(obj.failureClass as FailureClass))
  ) {
    throw new RunRecordValidationError(
      `failureClass must be one of ${FAILURE_CLASSES.join(', ')}`,
      'failureClass',
    )
  }
  if (obj.failureMode !== undefined) {
    expectString(obj.failureMode, 'failureMode')
    if (obj.failureClass === undefined || obj.failureClass === 'success') {
      throw new RunRecordValidationError(
        'failureMode requires a non-success failureClass',
        'failureMode',
      )
    }
  }

  if (
    typeof obj.terminalOutcome !== 'string' ||
    !TERMINAL_OUTCOMES.includes(obj.terminalOutcome as RunTerminalOutcome)
  ) {
    throw new RunRecordValidationError(
      `terminalOutcome must be one of ${TERMINAL_OUTCOMES.join(', ')}`,
      'terminalOutcome',
    )
  }
  if (obj.terminalFailureReason !== undefined) {
    expectString(obj.terminalFailureReason, 'terminalFailureReason')
    if (
      obj.terminalOutcome !== 'failed' &&
      obj.terminalOutcome !== 'cancelled' &&
      obj.terminalOutcome !== 'incomplete'
    ) {
      throw new RunRecordValidationError(
        'terminalFailureReason requires terminalOutcome failed, cancelled, or incomplete',
        'terminalFailureReason',
      )
    }
  }

  if (obj.agentProfile !== undefined) {
    try {
      const profile = validateAgentProfileCell(obj.agentProfile)
      if (profile.model !== undefined && profile.model !== obj.model) {
        throw new RunRecordValidationError(
          `agentProfile.model "${profile.model}" does not match model "${obj.model}"`,
          'agentProfile.model',
        )
      }
      if (profile.promptHash !== undefined && profile.promptHash !== obj.promptHash) {
        throw new RunRecordValidationError(
          `agentProfile.promptHash "${profile.promptHash}" does not match promptHash "${obj.promptHash}"`,
          'agentProfile.promptHash',
        )
      }
    } catch (error) {
      if (error instanceof RunRecordValidationError) throw error
      if (error instanceof Error) {
        throw new RunRecordValidationError(error.message, 'agentProfile')
      }
      throw error
    }
  }

  expectString(obj.scenarioId, 'scenarioId')

  // Split tag.
  if (typeof obj.splitTag !== 'string' || !SPLIT_TAGS.includes(obj.splitTag as RunSplitTag)) {
    throw new RunRecordValidationError(
      `splitTag must be one of ${SPLIT_TAGS.join(', ')}, got ${String(obj.splitTag)}`,
      'splitTag',
    )
  }

  return input as RunRecord
}

function validateCost(costUsd: unknown, provenance: unknown): void {
  if (provenance === null || typeof provenance !== 'object') {
    throw new RunRecordValidationError('costProvenance must be an object', 'costProvenance')
  }
  const value = provenance as Record<string, unknown>
  if (value.kind !== 'observed' && value.kind !== 'estimated' && value.kind !== 'uncaptured') {
    throw new RunRecordValidationError(
      'costProvenance.kind must be observed, estimated, or uncaptured',
      'costProvenance.kind',
    )
  }
  if (value.kind === 'uncaptured') {
    if (value.usd !== null) {
      throw new RunRecordValidationError(
        'uncaptured costProvenance.usd must be null',
        'costProvenance.usd',
      )
    }
    if (costUsd !== null) {
      throw new RunRecordValidationError('uncaptured cost requires costUsd to be null', 'costUsd')
    }
    return
  }
  expectNonNegativeNumber(costUsd, 'costUsd')
  expectNonNegativeNumber(value.usd, 'costProvenance.usd')
  if (value.usd !== costUsd) {
    throw new RunRecordValidationError(
      'costProvenance.usd must equal costUsd',
      'costProvenance.usd',
    )
  }
}

/** Boolean validator — convenience for filtering arrays. */
export function isRunRecord(input: unknown): input is RunRecord {
  try {
    validateRunRecord(input)
    return true
  } catch {
    return false
  }
}

/** Non-throwing validator — returns a discriminated union. */
export function parseRunRecordSafe(
  input: unknown,
): { ok: true; value: RunRecord } | { ok: false; error: RunRecordValidationError } {
  try {
    return { ok: true, value: validateRunRecord(input) }
  } catch (e) {
    if (e instanceof RunRecordValidationError) return { ok: false, error: e }
    throw e
  }
}

/** Round-trip helper — `JSON.parse(JSON.stringify(record))` then validate. */
export function roundTripRunRecord(record: RunRecord): RunRecord {
  const json = JSON.stringify(record)
  return validateRunRecord(JSON.parse(json))
}

// ── Internals ────────────────────────────────────────────────────────

function expectString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunRecordValidationError(`expected non-empty string`, path)
  }
}

function expectFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RunRecordValidationError(`expected finite number`, path)
  }
}

function expectNonNegativeNumber(value: unknown, path: string): void {
  expectFiniteNumber(value, path)
  if ((value as number) < 0) {
    throw new RunRecordValidationError('expected non-negative number', path)
  }
}

function validateJudgeScores(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') {
    throw new RunRecordValidationError('judgeScores must be an object', path)
  }
  const rec = value as Record<string, unknown>

  const perJudge = rec.perJudge
  if (perJudge === null || typeof perJudge !== 'object') {
    throw new RunRecordValidationError('perJudge must be an object', `${path}.perJudge`)
  }
  for (const [judgeId, dims] of Object.entries(perJudge as Record<string, unknown>)) {
    if (dims === null || typeof dims !== 'object') {
      throw new RunRecordValidationError(
        'per-judge entry must be an object of dimension scores',
        `${path}.perJudge.${judgeId}`,
      )
    }
    for (const [dim, score] of Object.entries(dims as Record<string, unknown>)) {
      expectFiniteNumber(score, `${path}.perJudge.${judgeId}.${dim}`)
    }
  }

  const perDimMean = rec.perDimMean
  if (perDimMean === null || typeof perDimMean !== 'object') {
    throw new RunRecordValidationError('perDimMean must be an object', `${path}.perDimMean`)
  }
  for (const [dim, mean] of Object.entries(perDimMean as Record<string, unknown>)) {
    expectFiniteNumber(mean, `${path}.perDimMean.${dim}`)
  }

  expectFiniteNumber(rec.composite, `${path}.composite`)

  if (rec.failedJudges !== undefined) {
    if (!Array.isArray(rec.failedJudges)) {
      throw new RunRecordValidationError(
        'failedJudges must be an array of strings',
        `${path}.failedJudges`,
      )
    }
    for (let i = 0; i < rec.failedJudges.length; i++) {
      const id = rec.failedJudges[i]
      if (typeof id !== 'string' || id.length === 0) {
        throw new RunRecordValidationError(
          'failedJudges entry must be a non-empty string',
          `${path}.failedJudges[${i}]`,
        )
      }
    }
  }

  if (rec.notes !== undefined && typeof rec.notes !== 'string') {
    throw new RunRecordValidationError('notes must be a string', `${path}.notes`)
  }
}

/**
 * Snapshot check for provider model identifiers. Accepts ISO and compact
 * dates, Router's `-MMDD` snapshots, one opaque `@token`, and Vertex-style
 * `:date-token` suffixes. Routing selectors such as `@preset/name` are not
 * immutable model identities.
 */
export function modelHasSnapshot(model: string): boolean {
  if (model.length === 0 || model.trim() !== model) return false

  const opaqueAt = model.lastIndexOf('@')
  if (opaqueAt > 0) {
    const base = model.slice(0, opaqueAt)
    const token = model.slice(opaqueAt + 1)
    if (!base.includes('@') && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(token)) {
      return true
    }
  }

  const isoDate = model.match(/-(\d{4})-(\d{2})-(\d{2})$/u)
  if (isoDate && validSnapshotDate(isoDate[1]!, isoDate[2]!, isoDate[3]!)) return true

  const compactDate = model.match(/-(\d{4})(\d{2})(\d{2})$/u)
  if (compactDate && validSnapshotDate(compactDate[1]!, compactDate[2]!, compactDate[3]!)) {
    return true
  }

  const routerDate = model.match(/-(\d{2})(\d{2})$/u)
  if (routerDate && validSnapshotDate(undefined, routerDate[1]!, routerDate[2]!)) return true

  return /:date-[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(model)
}

function validSnapshotDate(year: string | undefined, month: string, day: string): boolean {
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return false

  const yearNumber = year === undefined ? undefined : Number(year)
  const leapYear =
    yearNumber === undefined ||
    (yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0))
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return Number.isInteger(dayNumber) && dayNumber >= 1 && dayNumber <= daysInMonth[monthNumber - 1]!
}
