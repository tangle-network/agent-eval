/**
 * Paper-grade RunRecord schema + runtime validator.
 *
 * Every run that participates in a promotion gate, paper table, or
 * researcher loop SHOULD be recorded as a `RunRecord`. The mandatory
 * fields are exactly those the paper "Two Loops, Three Roles" requires
 * for reproducibility: who/what/when/cost/seed/hash, plus the search vs
 * holdout split tag and either a `searchScore` or a `holdoutScore`.
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
import { ValidationError } from './errors'

/** Search/dev/holdout split tag. 'search' is the paper-grade alias for the
 *  combined train+test pool that the optimizer is allowed to read. */
export type RunSplitTag = 'search' | 'dev' | 'holdout'

export interface RunTokenUsage {
  input: number
  output: number
  cached?: number
}

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
  /** Composite mean across all dims and judges. Mirrors the score
   *  the gate sees on `outcome.searchScore` / `holdoutScore`. */
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
  /** Score on the search/optimization split. Optional because a
   *  holdout-only evaluation only fills `holdoutScore`. */
  searchScore?: number
  /** Score on the held-out split. Optional because a search-only run
   *  only fills `searchScore`. At least one must be present. */
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
 *     configHash) uniquely identifies an experimental cell.
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
  /** Total USD cost. Mandatory — runs without a cost number are
   *  unbounded by definition and must not be admitted into the gate. */
  costUsd: number
  /** Token usage breakdown. */
  tokenUsage: RunTokenUsage
  /** Judge-side metadata, if a judge was used. */
  judgeMetadata?: RunJudgeMetadata
  /** Per-split scores + raw bag. */
  outcome: RunOutcome
  /** Categorical failure tag, when the run failed and the harness
   *  classified it. Free-form string; standard tags live in
   *  `failure-taxonomy.ts`. */
  failureMode?: string
  /** Which split this run was drawn from. */
  splitTag: RunSplitTag
  /**
   * Stable scenario identifier the run was scored against. Optional for
   * backwards compatibility, but **strongly recommended**: every primitive
   * that pairs runs by scenario (preferences, paired stats, BT tournament)
   * keys on this. The campaign artifact populates it canonically; legacy
   * runs without it fall back to inference from `outcome.raw.scenario_id`
   * or `experimentId`.
   */
  scenarioId?: string
  /**
   * Canonical identity for the agent profile cell that produced this row:
   * profile artifact hash plus optional harness/model/prompt/reporting
   * dimensions. Use `agentProfile.cellId` to group persona sweeps and
   * longitudinal reports by the complete source profile, not by a loose
   * candidate label or opaque config hash.
   */
  agentProfile?: AgentProfileCell
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
  'tokenUsage',
  'outcome',
  'splitTag',
] as const

const SPLIT_TAGS: ReadonlyArray<RunSplitTag> = ['search', 'dev', 'holdout']

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
  expectFiniteNumber(obj.wallMs, 'wallMs')
  if (obj.queueMs !== undefined) expectFiniteNumber(obj.queueMs, 'queueMs')
  expectFiniteNumber(obj.costUsd, 'costUsd')

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
  expectFiniteNumber(tuRec.input, 'tokenUsage.input')
  expectFiniteNumber(tuRec.output, 'tokenUsage.output')
  if (tuRec.cached !== undefined) expectFiniteNumber(tuRec.cached, 'tokenUsage.cached')

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
  if (outRec.searchScore === undefined && outRec.holdoutScore === undefined) {
    throw new RunRecordValidationError(
      'outcome must define searchScore or holdoutScore (or both)',
      'outcome',
    )
  }
  const raw = outRec.raw
  if (raw === null || typeof raw !== 'object') {
    throw new RunRecordValidationError('outcome.raw must be an object', 'outcome.raw')
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    expectFiniteNumber(v, `outcome.raw.${k}`)
  }

  // Per-judge / per-dim breakdown, optional.
  if (outRec.judgeScores !== undefined) {
    validateJudgeScores(outRec.judgeScores, 'outcome.judgeScores')
  }

  // Failure mode optional.
  if (obj.failureMode !== undefined) expectString(obj.failureMode, 'failureMode')

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

  // Split tag.
  if (typeof obj.splitTag !== 'string' || !SPLIT_TAGS.includes(obj.splitTag as RunSplitTag)) {
    throw new RunRecordValidationError(
      `splitTag must be one of ${SPLIT_TAGS.join(', ')}, got ${String(obj.splitTag)}`,
      'splitTag',
    )
  }

  return input as RunRecord
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
 * Heuristic snapshot check. Accepts:
 *   - `name@YYYY-MM-DD` (Anthropic style: `claude-sonnet-4-6@2025-04-15`)
 *   - `name-YYYYMMDD`   (OpenAI style: `gpt-4o-2024-11-20`)
 *   - `name@<arbitrary-token>` (allow opaque snapshots like `@v3`)
 *   - explicit `:date-...` Vertex-style tags
 *
 * Rejects bare aliases like `claude-sonnet-4` or `gpt-4o` that remap
 * silently as providers ship new snapshots.
 */
function modelHasSnapshot(model: string): boolean {
  if (model.includes('@')) return true
  if (/-\d{8}$/.test(model)) return true
  if (/-\d{4}-\d{2}-\d{2}$/.test(model)) return true
  if (/:date-/.test(model)) return true
  return false
}
