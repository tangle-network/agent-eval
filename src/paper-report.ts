/**
 * Paper-grade reporting helpers — sit alongside `reporter.ts` rather
 * than replacing it.
 *
 * Three artefacts:
 *
 *   - `paperTable`           Markdown table of per-candidate means,
 *                            95% bootstrap CIs, BH-adjusted Wilcoxon
 *                            p-values, and Cohen's d versus a
 *                            comparator candidate.
 *   - `paretoFigure`         Abstract spec for a cost vs quality
 *                            scatter, with gate decisions overlaid.
 *                            Returns numbers + labels — caller
 *                            chooses the plotting library.
 *   - `gainDistributionFigure`
 *                            Per-item paired holdout deltas as a
 *                            histogram spec (bins + counts + median +
 *                            CI). Same "data, not images" contract.
 *
 * The figure types are PlotSpecs — JSON-friendly, library-agnostic.
 * They aren't React components and they aren't PNGs; they are
 * what you'd hand to vega-lite, plotly, matplotlib, or your own
 * Canvas renderer to draw the actual figure.
 */

import { confidenceInterval, cohensD, wilcoxonSignedRank } from './statistics'
import { benjaminiHochberg } from './power-analysis'
import { pairedBootstrap } from './paired-stats'
import type { GateDecision } from './promotion-gate'
import type { RunRecord } from './run-record'

// ── paperTable ───────────────────────────────────────────────────────

export interface PaperTableOptions {
  /** Comparator candidate id. Wilcoxon + Cohen's d are computed
   *  versus this candidate. Required for paired stats columns. */
  comparator?: string
  /** Which split to read scores from. Default 'holdout'. */
  split?: 'search' | 'holdout'
  /** Confidence level for the bootstrap CI on the mean. Default 0.95. */
  confidence?: number
  /** FDR for BH adjustment of the comparison p-values. Default 0.05. */
  fdr?: number
}

export interface PaperTableRow {
  candidateId: string
  n: number
  mean: number
  ciLow: number
  ciHigh: number
  /** BH-adjusted q-value vs comparator. NaN if no comparator. */
  qValue: number
  /** Cohen's d vs comparator. NaN if no comparator. */
  cohensD: number
}

export interface PaperTable {
  rows: PaperTableRow[]
  comparator: string | null
  split: 'search' | 'holdout'
  /** Pre-rendered markdown — drop into a paper or PR. */
  markdown: string
}

/**
 * Table 1 helper. Buckets runs by `candidateId`, computes mean +
 * bootstrap CI on the chosen split, and (when a comparator is given)
 * BH-adjusted Wilcoxon p + Cohen's d versus that comparator.
 */
export function paperTable(runs: RunRecord[], opts: PaperTableOptions = {}): PaperTable {
  const split = opts.split ?? 'holdout'
  const confidence = opts.confidence ?? 0.95
  const fdr = opts.fdr ?? 0.05
  const comparator = opts.comparator ?? null
  const scoreField = split === 'holdout' ? 'holdoutScore' : 'searchScore'

  const byCandidate = new Map<string, { runs: RunRecord[]; scores: number[] }>()
  for (const r of runs) {
    if (r.splitTag !== split) continue
    const v = r.outcome[scoreField]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const bucket = byCandidate.get(r.candidateId) ?? { runs: [], scores: [] }
    bucket.runs.push(r)
    bucket.scores.push(v)
    byCandidate.set(r.candidateId, bucket)
  }

  const candidateIds = [...byCandidate.keys()].sort()
  const compRuns = comparator ? byCandidate.get(comparator) : undefined

  // First pass: per-candidate means + CIs + raw p-values.
  const tentative: Array<PaperTableRow & { rawP: number }> = []
  for (const id of candidateIds) {
    const bucket = byCandidate.get(id)!
    const ci = confidenceInterval(bucket.scores, confidence)
    let rawP = Number.NaN
    let d = Number.NaN
    if (comparator && compRuns && id !== comparator) {
      const paired = pairScoresByKey(bucket.runs, compRuns.runs, scoreField)
      if (paired.before.length >= 6) {
        rawP = wilcoxonSignedRank(paired.before, paired.after).p
      }
      d = cohensD(compRuns.scores, bucket.scores)
    }
    tentative.push({
      candidateId: id,
      n: bucket.scores.length,
      mean: ci.mean,
      ciLow: ci.lower,
      ciHigh: ci.upper,
      qValue: rawP,
      cohensD: d,
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
      if (!Number.isFinite(r.rawP)) continue
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
  const markdown = renderPaperTableMarkdown(rows, comparator, split)
  return { rows, comparator, split, markdown }
}

function pairScoresByKey(
  candidate: RunRecord[],
  baseline: RunRecord[],
  scoreField: 'searchScore' | 'holdoutScore',
): { before: number[]; after: number[] } {
  const baseIdx = new Map<string, number>()
  for (const r of baseline) {
    const v = r.outcome[scoreField]
    if (typeof v === 'number' && Number.isFinite(v)) {
      baseIdx.set(`${r.experimentId}::${r.seed}`, v)
    }
  }
  const before: number[] = []
  const after: number[] = []
  for (const r of candidate) {
    const v = r.outcome[scoreField]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const key = `${r.experimentId}::${r.seed}`
    const b = baseIdx.get(key)
    if (b === undefined) continue
    before.push(b)
    after.push(v)
  }
  return { before, after }
}

function renderPaperTableMarkdown(
  rows: PaperTableRow[],
  comparator: string | null,
  split: 'search' | 'holdout',
): string {
  const lines: string[] = []
  const cmpLabel = comparator ? ` (vs ${comparator})` : ''
  lines.push(`Paper Table — ${split} split${cmpLabel}`)
  lines.push('')
  lines.push('| Candidate | N | Mean | 95% CI | q (BH) | Cohen\'s d |')
  lines.push('|---|---:|---:|---|---:|---:|')
  for (const r of rows) {
    const ci = `[${fmt(r.ciLow)}, ${fmt(r.ciHigh)}]`
    const q = Number.isFinite(r.qValue) ? r.qValue.toFixed(4) : '—'
    const d = Number.isFinite(r.cohensD) ? r.cohensD.toFixed(3) : '—'
    lines.push(`| ${r.candidateId} | ${r.n} | ${fmt(r.mean)} | ${ci} | ${q} | ${d} |`)
  }
  return lines.join('\n')
}

// ── paretoFigure ─────────────────────────────────────────────────────

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
  gate?: 'promote' | 'reject_few_runs' | 'reject_negative_delta' | 'reject_overfit_gap' | null
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
export function paretoFigure(
  runs: RunRecord[],
  opts: {
    split?: 'search' | 'holdout'
    gateDecisions?: Record<string, GateDecision>
  } = {},
): ParetoFigureSpec {
  const split = opts.split ?? 'holdout'
  const scoreField = split === 'holdout' ? 'holdoutScore' : 'searchScore'

  const buckets = new Map<string, { cost: number[]; quality: number[] }>()
  for (const r of runs) {
    if (r.splitTag !== split) continue
    const v = r.outcome[scoreField]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
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

function gateLabel(d: GateDecision): ParetoPoint['gate'] {
  if (d.promote) return 'promote'
  if (d.rejectionCode === 'few_runs') return 'reject_few_runs'
  if (d.rejectionCode === 'negative_delta') return 'reject_negative_delta'
  if (d.rejectionCode === 'overfit_gap') return 'reject_overfit_gap'
  return null
}

// ── gainDistributionFigure ───────────────────────────────────────────

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
  bins: GainDistributionBin[]
  median: number
  ci: { low: number; high: number }
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
export function gainDistributionFigure(
  runs: RunRecord[],
  candidateId: string,
  comparator: string,
  opts: GainDistributionOptions = {},
): GainDistributionFigureSpec {
  const split = opts.split ?? 'holdout'
  const scoreField = split === 'holdout' ? 'holdoutScore' : 'searchScore'
  const binCount = opts.bins ?? 11
  if (binCount < 1) throw new Error('gainDistributionFigure: bins must be ≥ 1')

  const candidate = runs.filter((r) => r.candidateId === candidateId && r.splitTag === split)
  const baseline = runs.filter((r) => r.candidateId === comparator && r.splitTag === split)
  // pairScoresByKey returns before=baseline-score, after=candidate-score
  // for each (experimentId, seed) pair where both sides recorded a
  // valid score on this split. delta = after - before = candidate - baseline.
  const { before, after } = pairScoresByKey(candidate, baseline, scoreField)
  const n = before.length

  if (n === 0) {
    return {
      kind: 'gain-distribution',
      candidateId,
      comparator,
      split,
      n: 0,
      bins: [],
      median: 0,
      ci: { low: 0, high: 0 },
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
    bins,
    median,
    ci: { low: ci.low, high: ci.high },
  }
}

// ── tiny helpers ─────────────────────────────────────────────────────

function avg(xs: number[]): number {
  if (xs.length === 0) return Number.NaN
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function medianOfSorted(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  return x.toFixed(4)
}
