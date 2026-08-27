/**
 * # `intake/feedback-table` — multi-rater approve/reject corpus → `RunRecord[]`.
 *
 * The generic shape behind Obsidian's `#approved` / `#rejected` tags, a
 * Google Sheet, a Postgres `feedback` table, or any CSV with ratings.
 *
 * Caller supplies one row per (run, rater) tuple plus per-run metadata; the
 * adapter rolls them up into the substrate-canonical `RunRecord` shape so
 * `analyzeRuns({ runs, raterScores })` can produce inter-rater agreement,
 * disagreement triage, and downstream recommendations.
 *
 * Per-run `RunRecord.outcome.searchScore` is the rater-mean rating
 * (normalised to 0..1 when scale is supplied); `outcome.raw` carries the
 * per-rater scores keyed by rater id for downstream attribution.
 */

import type { JudgeScoresRecord, RunOutcome, RunRecord, RunSplitTag } from '../../run-record'

export interface FeedbackTableRow {
  /** Stable id for this run — the unit a rater scored. Drives pairing
   *  across analysis primitives. */
  runId: string
  /** Identifier of the rater that produced this rating. */
  rater: string
  /** The rating itself. Accepts boolean (approve/reject), 0..1 scalar,
   *  or any numeric scale — see `scale`. */
  rating: number | boolean
  /** Optional metadata carried through to `RunRecord.outcome.raw` and the
   *  custom-shape metadata bag. */
  metadata?: Record<string, unknown>
}

export interface FeedbackTableMeta {
  runId: string
  /** When omitted, defaults to `'feedback-corpus'`. Used to group related
   *  runs in `analyzeRuns()` lift analysis. */
  experimentId?: string
  /** When omitted, defaults to `runId` — each run is its own candidate. */
  candidateId?: string
  /** Cost in USD, when available. Set to 0 when unknown — the consumer's
   *  cost analysis sections will collapse gracefully. */
  costUsd?: number
  /** Wall-clock ms, when available. Defaults to 0. */
  wallMs?: number
  /** Model identifier including snapshot. Default `unknown@unknown`. */
  model?: string
  /** Optional sha256 of the prompt; default `'sha256:unknown'`. */
  promptHash?: string
  /** Default `'sha256:unknown'`. */
  configHash?: string
  /** Default `'unknown'`. */
  commitSha?: string
  /** Default `'holdout'` — feedback corpora are by nature the holdout
   *  signal a closed-loop improvement aims at. */
  splitTag?: RunSplitTag
  /** Free-form metadata available to consumers via the cast-out path on
   *  the resulting RunRecord. */
  extras?: Record<string, unknown>
}

export interface FromFeedbackTableOptions {
  /** Per-(run, rater) ratings. */
  ratings: FeedbackTableRow[]
  /** Per-run metadata. When a runId appears in `ratings` but not here, the
   *  adapter synthesises minimal metadata with defaults documented above. */
  meta?: FeedbackTableMeta[]
  /** Rating scale. Provide `{ min, max }` for non-0..1 numeric scales.
   *  Booleans are normalised: true → 1, false → 0. Default: assumes
   *  ratings are already 0..1. */
  scale?: { min: number; max: number }
  /** When true, the rater scores are emitted into `raterScores` (a sibling
   *  array `analyzeRuns()` accepts) instead of being averaged into the
   *  run's `outcome.searchScore`. Default `true` — preserves rater-level
   *  signal for inter-rater analysis. */
  emitRaterScores?: boolean
}

export interface FromFeedbackTableResult {
  runs: RunRecord[]
  /** Rater-level scores ready to pass into `analyzeRuns({ raterScores })`
   *  for inter-rater agreement + disagreement triage. */
  raterScores: Array<{ runId: string; rater: string; score: number }>
}

export function fromFeedbackTable(opts: FromFeedbackTableOptions): FromFeedbackTableResult {
  const { ratings, meta = [], scale, emitRaterScores = true } = opts
  const metaByRun = new Map(meta.map((m) => [m.runId, m]))

  // Normalise per-rating to a 0..1 score.
  const normalise = (rating: number | boolean): number => {
    if (typeof rating === 'boolean') return rating ? 1 : 0
    if (!Number.isFinite(rating)) return Number.NaN
    if (!scale) return rating
    const { min, max } = scale
    if (max === min) return rating
    return (rating - min) / (max - min)
  }

  // Group ratings by runId.
  const byRun = new Map<string, FeedbackTableRow[]>()
  for (const row of ratings) {
    const list = byRun.get(row.runId) ?? []
    list.push(row)
    byRun.set(row.runId, list)
  }

  const runs: RunRecord[] = []
  const raterScores: FromFeedbackTableResult['raterScores'] = []

  for (const [runId, rowsForRun] of byRun) {
    const normalised = rowsForRun
      .map((r) => ({ rater: r.rater, score: normalise(r.rating) }))
      .filter((r) => Number.isFinite(r.score))
    if (normalised.length === 0) continue

    const meanScore = normalised.reduce((s, r) => s + r.score, 0) / normalised.length

    const runMeta = metaByRun.get(runId) ?? ({ runId } as FeedbackTableMeta)

    const judgeScores: JudgeScoresRecord = {
      perJudge: Object.fromEntries(normalised.map((r) => [r.rater, { rating: r.score }])),
      perDimMean: { rating: meanScore },
      composite: meanScore,
    }

    const outcome: RunOutcome = {
      // Feedback corpora ARE the holdout signal — score lands on
      // `holdoutScore` so downstream substrate primitives (`paretoChart`,
      // promotion gates) read it correctly by default.
      holdoutScore: meanScore,
      raw: Object.fromEntries(normalised.map((r) => [`rater:${r.rater}`, r.score])),
      judgeScores,
    }

    runs.push({
      runId,
      experimentId: runMeta.experimentId ?? 'feedback-corpus',
      candidateId: runMeta.candidateId ?? runId,
      seed: 0,
      model: runMeta.model ?? 'unknown@unknown',
      promptHash: runMeta.promptHash ?? 'sha256:unknown',
      configHash: runMeta.configHash ?? 'sha256:unknown',
      commitSha: runMeta.commitSha ?? 'unknown',
      wallMs: runMeta.wallMs ?? 0,
      costUsd: runMeta.costUsd ?? 0,
      tokenUsage: { input: 0, output: 0 },
      outcome,
      splitTag: runMeta.splitTag ?? 'holdout',
    } as RunRecord)

    if (emitRaterScores) {
      for (const r of normalised) raterScores.push({ runId, rater: r.rater, score: r.score })
    }
  }

  return { runs, raterScores }
}
