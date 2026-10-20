/** Tables and library-independent chart specifications from scored runs. */

import type { GateDecision } from './held-out-gate'
import { fmt } from './research-report-render'
import { observedSplitScore } from './rollout/reward'
import type { RunRecord } from './run-record'
import {
  benjaminiHochberg,
  confidenceInterval,
  pairedBootstrap,
  pairedCohensDz,
  wilcoxonSignedRank,
} from './statistics'
import { mean as avg } from './statistics/mean'
import { medianOfSorted, pairScoresByKey } from './summary-report-evidence'

// ── summaryTable ───────────────────────────────────────────────────────

export interface SummaryTableOptions {
  /** Comparator candidate id. Wilcoxon + paired Cohen's dz are computed
   *  versus this candidate. Required for paired stats columns. */
  comparator?: string
  /** Which split to read scores from. Default 'holdout'. */
  split?: 'search' | 'holdout'
  /** Confidence level for the bootstrap CI on the mean. Default 0.95. */
  confidence?: number
  /** FDR for BH adjustment of the comparison p-values. Default 0.05. */
  fdr?: number
}

export interface SummaryTableRow {
  candidateId: string
  n: number
  mean: number
  ciLow: number
  ciHigh: number
  /** BH-adjusted q-value vs comparator, or null when unavailable. */
  qValue: number | null
  /** Paired Cohen's dz vs comparator, or null when the paired variance is zero. */
  cohensD: number | null
  /** Matched observations used for paired comparison, or null on the comparator row. */
  pairedN: number | null
  /** Candidate observations without a comparator match. */
  unpairedCandidateN: number | null
  /** Comparator observations without a candidate match. */
  unpairedComparatorN: number | null
}

export interface SummaryTable {
  rows: SummaryTableRow[]
  comparator: string | null
  split: 'search' | 'holdout'
  /** Pre-rendered markdown — drop into a paper or PR. */
  markdown: string
}

/**
 * Table 1 helper. Buckets runs by `candidateId`, computes mean +
 * bootstrap CI on the chosen split, and (when a comparator is given)
 * BH-adjusted Wilcoxon p + paired Cohen's dz versus that comparator.
 */
export function summaryTable(runs: RunRecord[], opts: SummaryTableOptions = {}): SummaryTable {
  const split = opts.split ?? 'holdout'
  const confidence = opts.confidence ?? 0.95
  const fdr = opts.fdr ?? 0.05
  const comparator = opts.comparator ?? null

  const byCandidate = new Map<string, { runs: RunRecord[]; scores: number[] }>()
  for (const r of runs) {
    if (r.splitTag !== split) continue
    // RAW (`observedSplitScore`): every figure in this module reports what the
    // runs scored. Zeroing a gamed run here would erase it from the very table
    // a reviewer reads to notice it, and the split is already filtered above,
    // so the exact-split reader is the right one — no cross-split fallback.
    const v = observedSplitScore(r, split)
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const bucket = byCandidate.get(r.candidateId) ?? { runs: [], scores: [] }
    bucket.runs.push(r)
    bucket.scores.push(v)
    byCandidate.set(r.candidateId, bucket)
  }

  const candidateIds = [...byCandidate.keys()].sort()
  const compRuns = comparator ? byCandidate.get(comparator) : undefined

  // First pass: per-candidate means + CIs + raw p-values.
  const tentative: Array<SummaryTableRow & { rawP: number | null }> = []
  for (const id of candidateIds) {
    const bucket = byCandidate.get(id)!
    const ci = confidenceInterval(bucket.scores, confidence)
    let rawP: number | null = null
    let d: number | null = null
    let pairedN: number | null = null
    let unpairedCandidateN: number | null = null
    let unpairedComparatorN: number | null = null
    if (comparator && compRuns && id !== comparator) {
      const paired = pairScoresByKey(bucket.runs, compRuns.runs, split)
      pairedN = paired.before.length
      unpairedCandidateN = paired.unpairedCandidateN
      unpairedComparatorN = paired.unpairedComparatorN
      if (paired.before.length >= 6) {
        rawP = wilcoxonSignedRank(paired.before, paired.after).p
      }
      d = pairedCohensDz(paired.before, paired.after)
    }
    tentative.push({
      candidateId: id,
      n: bucket.scores.length,
      mean: ci.mean,
      ciLow: ci.lower,
      ciHigh: ci.upper,
      qValue: rawP,
      cohensD: d,
      pairedN,
      unpairedCandidateN,
      unpairedComparatorN,
      rawP,
    })
  }

  // BH-adjust across the comparison set (skip NaN rows / the
  // comparator itself). Adjustment is a no-op when there are 0 or 1
  // comparators.
  if (comparator) {
    const idxs: number[] = []
    const ps: number[] = []
    for (let i = 0; i < tentative.length; i++) {
      const r = tentative[i]!
      if (r.candidateId === comparator) continue
      if (r.rawP === null || !Number.isFinite(r.rawP)) continue
      idxs.push(i)
      ps.push(r.rawP)
    }
    if (ps.length > 0) {
      const { qValues } = benjaminiHochberg(ps, fdr)
      for (let k = 0; k < idxs.length; k++) {
        tentative[idxs[k]!]!.qValue = qValues[k]!
      }
    }
  }

  const rows = tentative.map(({ rawP: _rawP, ...rest }) => rest)
  const markdown = renderSummaryTableMarkdown(rows, comparator, split)
  return { rows, comparator, split, markdown }
}

function renderSummaryTableMarkdown(
  rows: SummaryTableRow[],
  comparator: string | null,
  split: 'search' | 'holdout',
): string {
  const lines: string[] = []
  const cmpLabel = comparator ? ` (vs ${comparator})` : ''
  lines.push(`Summary Table — ${split} split${cmpLabel}`)
  lines.push('')
  lines.push("| Candidate | N | Pairs | Unpaired | Mean | 95% CI | q (BH) | Cohen's dz |")
  lines.push('|---|---:|---:|---:|---:|---|---:|---:|')
  for (const r of rows) {
    const ci = `[${fmt(r.ciLow)}, ${fmt(r.ciHigh)}]`
    const q = r.qValue !== null ? r.qValue.toFixed(4) : '—'
    const d = r.cohensD !== null ? r.cohensD.toFixed(3) : '—'
    const paired = r.pairedN ?? '—'
    const unpaired =
      r.unpairedCandidateN === null || r.unpairedComparatorN === null
        ? '—'
        : `${r.unpairedCandidateN}/${r.unpairedComparatorN}`
    lines.push(
      `| ${r.candidateId} | ${r.n} | ${paired} | ${unpaired} | ${fmt(r.mean)} | ${ci} | ${q} | ${d} |`,
    )
  }
  return lines.join('\n')
}

// ── paretoChart ─────────────────────────────────────────────────────

export interface ParetoPoint {
  candidateId: string
  /** Mean USD cost per run on the chosen split. */
  cost: number
  /** Mean score on the chosen split. */
  quality: number
  /** Number of runs that informed this point. */
  n: number
  /** Whether this candidate is on the Pareto frontier — high
   *  quality, low cost, no dominator. */
  onFrontier: boolean
  /** Optional gate verdict for this candidate, if a `GateDecision`
   *  for it was passed in. */
  gate?: 'promote' | 'reject'
}

export interface ParetoFigureSpec {
  kind: 'pareto-cost-quality'
  split: 'search' | 'holdout'
  points: ParetoPoint[]
  axes: { x: 'costUsd'; y: 'score' }
}

/**
 * Cost vs quality scatter spec. `gateDecisions` is keyed by
 * candidate id; if present, every point picks up the gate verdict
 * for overlay.
 */
export function paretoChart(
  runs: RunRecord[],
  opts: {
    split?: 'search' | 'holdout'
    gateDecisions?: Record<string, GateDecision>
  } = {},
): ParetoFigureSpec {
  const split = opts.split ?? 'holdout'

  const buckets = new Map<string, { cost: number[]; quality: number[] }>()
  for (const r of runs) {
    if (r.splitTag !== split) continue
    const v = observedSplitScore(r, split)
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (r.costUsd === null) continue
    const bucket = buckets.get(r.candidateId) ?? { cost: [], quality: [] }
    bucket.cost.push(r.costUsd)
    bucket.quality.push(v)
    buckets.set(r.candidateId, bucket)
  }

  const points: ParetoPoint[] = []
  for (const [candidateId, bucket] of buckets.entries()) {
    points.push({
      candidateId,
      cost: avg(bucket.cost),
      quality: avg(bucket.quality),
      n: bucket.cost.length,
      onFrontier: false,
      gate: opts.gateDecisions?.[candidateId]
        ? gateLabel(opts.gateDecisions[candidateId]!)
        : undefined,
    })
  }

  // Pareto: minimize cost, maximize quality. A point is dominated if
  // some other point has lower-or-equal cost AND higher-or-equal
  // quality with strict inequality somewhere.
  for (const p of points) {
    p.onFrontier = !points.some((q) => q !== p && dominates(q, p))
  }

  return {
    kind: 'pareto-cost-quality',
    split,
    axes: { x: 'costUsd', y: 'score' },
    points,
  }
}

function dominates(a: ParetoPoint, b: ParetoPoint): boolean {
  return a.cost <= b.cost && a.quality >= b.quality && (a.cost < b.cost || a.quality > b.quality)
}

export function gateLabel(d: GateDecision): ParetoPoint['gate'] {
  return d.promote ? 'promote' : 'reject'
}

// ── gainHistogram ───────────────────────────────────────────

export interface GainDistributionBin {
  /** Inclusive lower edge. */
  lo: number
  /** Exclusive upper edge (or inclusive if it's the last bin). */
  hi: number
  /** Number of pairs whose delta lands in this bin. */
  count: number
}

export interface GainDistributionFigureSpec {
  kind: 'gain-distribution'
  candidateId: string
  comparator: string
  split: 'search' | 'holdout'
  /** Number of pairs used. */
  n: number
  /** Candidate rows without a comparator match. */
  unpairedCandidateN: number
  /** Comparator rows without a candidate match. */
  unpairedComparatorN: number
  bins: GainDistributionBin[]
  median: number | null
  ci: { low: number; high: number } | null
}

export interface GainDistributionOptions {
  /** Number of histogram bins. Default 11 (so the centre is exact at 0). */
  bins?: number
  /** Which split to use. Default 'holdout'. */
  split?: 'search' | 'holdout'
  /** Confidence level for the CI. Default 0.95. */
  confidence?: number
  /** Bootstrap resamples. Default 2000. */
  resamples?: number
  /** Deterministic seed. */
  seed?: number
}

/**
 * Held-out improvement distribution: per-pair delta (candidate −
 * comparator), histogrammed. Includes the bootstrap CI on the median
 * delta — same primitive the promotion gate uses.
 */
export function gainHistogram(
  runs: RunRecord[],
  candidateId: string,
  comparator: string,
  opts: GainDistributionOptions = {},
): GainDistributionFigureSpec {
  const split = opts.split ?? 'holdout'
  const binCount = opts.bins ?? 11
  if (binCount < 1) throw new Error('gainHistogram: bins must be ≥ 1')

  const candidate = runs.filter((r) => r.candidateId === candidateId && r.splitTag === split)
  const baseline = runs.filter((r) => r.candidateId === comparator && r.splitTag === split)
  // pairScoresByKey returns before=baseline-score, after=candidate-score
  // for each canonical work-identity pair where both sides recorded a
  // valid score on this split. delta = after - before = candidate - baseline.
  const { before, after, unpairedCandidateN, unpairedComparatorN } = pairScoresByKey(
    candidate,
    baseline,
    split,
  )
  const n = before.length

  if (n === 0) {
    return {
      kind: 'gain-distribution',
      candidateId,
      comparator,
      split,
      n: 0,
      unpairedCandidateN,
      unpairedComparatorN,
      bins: [],
      median: null,
      ci: null,
    }
  }

  const deltas = before.map((b, i) => after[i]! - b)
  const sortedDeltas = [...deltas].sort((a, b) => a - b)
  const median = medianOfSorted(sortedDeltas)
  const min = sortedDeltas[0]!
  const max = sortedDeltas[sortedDeltas.length - 1]!

  // Symmetric bins around the wider of (|min|, |max|) so the chart
  // visually centres on zero without dropping outliers.
  const bound = Math.max(Math.abs(min), Math.abs(max), 1e-6)
  const lo = -bound
  const hi = bound
  const width = (hi - lo) / binCount
  const bins: GainDistributionBin[] = []
  for (let i = 0; i < binCount; i++) {
    bins.push({ lo: lo + i * width, hi: lo + (i + 1) * width, count: 0 })
  }
  for (const d of deltas) {
    let idx = Math.floor((d - lo) / width)
    if (idx < 0) idx = 0
    if (idx >= binCount) idx = binCount - 1
    bins[idx]!.count += 1
  }

  const ci = pairedBootstrap(before, after, {
    confidence: opts.confidence ?? 0.95,
    resamples: opts.resamples ?? 2000,
    statistic: 'median',
    seed: opts.seed,
  })

  return {
    kind: 'gain-distribution',
    candidateId,
    comparator,
    split,
    n,
    unpairedCandidateN,
    unpairedComparatorN,
    bins,
    median,
    ci: { low: ci.low, high: ci.high },
  }
}
