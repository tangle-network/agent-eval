/**
 * # `@tangle-network/agent-eval/contract` — eval-run diff primitive.
 *
 * The substrate side of the v-N-versus-v-N+1 dashboard view. Given two
 * `EvalRunEvent`s (or two `EvalRunGenerationSnapshot`s from one run), this
 * returns a normalised diff: per-cell composite + per-judge/per-dimension
 * deltas, surface-hash change, aggregate cost + duration shifts.
 *
 * Consumed by:
 *   - The hosted-tier dashboard (intelligence-web) — renders v3 vs v4
 *     comparisons of cells × judges × dimensions.
 *   - CI reporting — emits a "shipped: composite +0.07, cost +$1.20" line
 *     in PR review for autonomous-improvement runs.
 *   - Any downstream consumer that needs "what actually changed" without
 *     reimplementing the matching + arithmetic.
 *
 * Cells are matched on the natural composite key `(scenarioId, rep)`.
 * Unmatched cells surface as `removed` / `added` so callers can tell
 * "this cell got worse" from "this cell wasn't run."
 */

import type { GateDecision } from '../campaign/types'
import type { EvalRunCellScore, EvalRunEvent, EvalRunGenerationSnapshot } from '../hosted/types'

// ── Types ────────────────────────────────────────────────────────────

/** Per-dimension delta. `before` / `after` are null when the judge did not
 *  emit a value for that side. `delta` is `after - before`; null when
 *  either side is null. */
export interface EvalDimensionDelta {
  before: number | null
  after: number | null
  delta: number | null
}

/** Per-cell delta, keyed on `(scenarioId, rep)`. */
export interface EvalCellScoreDelta {
  scenarioId: string
  rep: number
  compositeBefore: number
  compositeAfter: number
  compositeDelta: number
  /** Per-judge → per-dimension deltas. Outer key = judge name from
   *  `EvalRunCellScore.dimensions`; inner key = dimension name. */
  dimensions: Record<string, Record<string, EvalDimensionDelta>>
}

/** Diff between two generation snapshots — the unit the dashboard renders
 *  for a single "v3 vs v4" comparison. */
export interface EvalGenerationDiff {
  beforeIndex: number
  afterIndex: number
  beforeSurfaceHash: string
  afterSurfaceHash: string
  surfaceChanged: boolean
  /** Cells present in both snapshots, matched on `(scenarioId, rep)`. */
  matched: EvalCellScoreDelta[]
  /** Cells present in `before` but missing from `after`. */
  removed: EvalRunCellScore[]
  /** Cells present in `after` but missing from `before`. */
  added: EvalRunCellScore[]
  /** Aggregate composite mean across all cells in the snapshot. */
  compositeBefore: number
  compositeAfter: number
  compositeDelta: number
  costUsdBefore: number
  costUsdAfter: number
  costUsdDelta: number
  durationMsBefore: number
  durationMsAfter: number
  durationMsDelta: number
}

/** Diff between two full eval-runs. Includes both baseline-vs-baseline and
 *  winner-vs-winner generation diffs when both sides expose them, plus
 *  run-level metadata. */
export interface EvalRunDiff {
  beforeRunId: string
  afterRunId: string
  beforeTimestamp: string
  afterTimestamp: string
  beforeGateDecision: GateDecision | null
  afterGateDecision: GateDecision | null
  beforeHoldoutLift: number | null
  afterHoldoutLift: number | null
  holdoutLiftDelta: number | null
  beforeTotalCostUsd: number
  afterTotalCostUsd: number
  totalCostUsdDelta: number
  beforeTotalDurationMs: number
  afterTotalDurationMs: number
  totalDurationMsDelta: number
  /** Baseline-vs-baseline diff. Null when either run has no baseline. */
  baselineDiff: EvalGenerationDiff | null
  /** Highest-index-generation comparison. Null when either run has no
   *  recorded generations (e.g. baseline-only or errored before any
   *  generation completed). */
  winnersDiff: EvalGenerationDiff | null
}

// ── Implementation ───────────────────────────────────────────────────

function keyForCell(cell: EvalRunCellScore): string {
  // JSON-tuple key — `scenarioId` may legitimately contain `::` or any other
  // delimiter, so we use JSON.stringify on a 2-tuple to get an unambiguous,
  // collision-free composite key.
  return JSON.stringify([cell.scenarioId, cell.rep])
}

/** Build the per-dimension delta map for a matched cell. Each judge name +
 *  dimension name encountered on EITHER side appears in the result. */
function diffDimensions(
  before: EvalRunCellScore['dimensions'],
  after: EvalRunCellScore['dimensions'],
): EvalCellScoreDelta['dimensions'] {
  const out: EvalCellScoreDelta['dimensions'] = {}
  const judges = new Set<string>([...Object.keys(before), ...Object.keys(after)])
  for (const judge of judges) {
    const beforeDims = before[judge] ?? {}
    const afterDims = after[judge] ?? {}
    const dims = new Set<string>([...Object.keys(beforeDims), ...Object.keys(afterDims)])
    const judgeOut: Record<string, EvalDimensionDelta> = {}
    for (const dim of dims) {
      // Coerce non-finite values (NaN, ±Infinity) to null so the diff never
      // surfaces NaN/Infinity to the dashboard. A NaN score is a substrate
      // bug from upstream; the diff treats it as "no value" rather than
      // propagating the corruption.
      const rawBefore = beforeDims[dim]
      const rawAfter = afterDims[dim]
      const b = typeof rawBefore === 'number' && Number.isFinite(rawBefore) ? rawBefore : null
      const a = typeof rawAfter === 'number' && Number.isFinite(rawAfter) ? rawAfter : null
      judgeOut[dim] = {
        before: b,
        after: a,
        delta: b !== null && a !== null ? a - b : null,
      }
    }
    out[judge] = judgeOut
  }
  return out
}

/**
 * Diff two generation snapshots. Cells are matched on `(scenarioId, rep)`;
 * unmatched cells surface in `added` / `removed`. Aggregate fields are
 * recomputed from the snapshot's stored fields, not re-derived from cells —
 * this keeps the diff consistent with whatever aggregation the substrate
 * actually reported.
 */
export function diffGenerations(
  before: EvalRunGenerationSnapshot,
  after: EvalRunGenerationSnapshot,
): EvalGenerationDiff {
  const beforeMap = new Map(before.cells.map((c) => [keyForCell(c), c]))
  const afterMap = new Map(after.cells.map((c) => [keyForCell(c), c]))

  const matched: EvalCellScoreDelta[] = []
  const removed: EvalRunCellScore[] = []
  const added: EvalRunCellScore[] = []

  for (const [key, beforeCell] of beforeMap) {
    const afterCell = afterMap.get(key)
    if (!afterCell) {
      removed.push(beforeCell)
      continue
    }
    matched.push({
      scenarioId: beforeCell.scenarioId,
      rep: beforeCell.rep,
      compositeBefore: beforeCell.compositeMean,
      compositeAfter: afterCell.compositeMean,
      compositeDelta: afterCell.compositeMean - beforeCell.compositeMean,
      dimensions: diffDimensions(beforeCell.dimensions, afterCell.dimensions),
    })
  }
  for (const [key, afterCell] of afterMap) {
    if (!beforeMap.has(key)) added.push(afterCell)
  }

  return {
    beforeIndex: before.index,
    afterIndex: after.index,
    beforeSurfaceHash: before.surfaceHash,
    afterSurfaceHash: after.surfaceHash,
    surfaceChanged: before.surfaceHash !== after.surfaceHash,
    matched,
    removed,
    added,
    compositeBefore: before.compositeMean,
    compositeAfter: after.compositeMean,
    compositeDelta: after.compositeMean - before.compositeMean,
    costUsdBefore: before.costUsd,
    costUsdAfter: after.costUsd,
    costUsdDelta: after.costUsd - before.costUsd,
    durationMsBefore: before.durationMs,
    durationMsAfter: after.durationMs,
    durationMsDelta: after.durationMs - before.durationMs,
  }
}

/** Highest-index generation, or null if the run recorded none. */
function winnerOf(run: EvalRunEvent): EvalRunGenerationSnapshot | null {
  if (run.generations.length === 0) return null
  let winner = run.generations[0] as EvalRunGenerationSnapshot
  for (const gen of run.generations) {
    if (gen.index > winner.index) winner = gen
  }
  return winner
}

/**
 * Diff two full eval-runs. Produces baseline-vs-baseline and
 * winner-vs-winner generation diffs when both sides expose them, plus
 * run-level cost / lift / gate-decision deltas.
 */
export function diffRuns(before: EvalRunEvent, after: EvalRunEvent): EvalRunDiff {
  const beforeWinner = winnerOf(before)
  const afterWinner = winnerOf(after)
  const baselineDiff =
    before.baseline && after.baseline ? diffGenerations(before.baseline, after.baseline) : null
  const winnersDiff =
    beforeWinner && afterWinner ? diffGenerations(beforeWinner, afterWinner) : null

  const beforeLift = before.holdoutLift ?? null
  const afterLift = after.holdoutLift ?? null

  return {
    beforeRunId: before.runId,
    afterRunId: after.runId,
    beforeTimestamp: before.timestamp,
    afterTimestamp: after.timestamp,
    beforeGateDecision: before.gateDecision ?? null,
    afterGateDecision: after.gateDecision ?? null,
    beforeHoldoutLift: beforeLift,
    afterHoldoutLift: afterLift,
    holdoutLiftDelta: beforeLift !== null && afterLift !== null ? afterLift - beforeLift : null,
    beforeTotalCostUsd: before.totalCostUsd,
    afterTotalCostUsd: after.totalCostUsd,
    totalCostUsdDelta: after.totalCostUsd - before.totalCostUsd,
    beforeTotalDurationMs: before.totalDurationMs,
    afterTotalDurationMs: after.totalDurationMs,
    totalDurationMsDelta: after.totalDurationMs - before.totalDurationMs,
    baselineDiff,
    winnersDiff,
  }
}

/**
 * Within-run baseline → winning-generation diff. The natural "what did the
 * improvement loop produce" view for a single run. Returns null when the
 * run never reached a generation past baseline (errored early, or the gate
 * shipped the baseline as-is).
 */
export function diffRunBaselineToWinner(run: EvalRunEvent): EvalGenerationDiff | null {
  if (!run.baseline) return null
  const winner = winnerOf(run)
  if (!winner || winner.index === run.baseline.index) return null
  return diffGenerations(run.baseline, winner)
}
