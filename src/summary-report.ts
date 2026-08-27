/**
 * Reporting helpers — production summaries and paper-quality figures — sit alongside `reporter.ts` rather
 * than replacing it.
 *
 * Three artefacts:
 *
 *   - `summaryTable`           Markdown table of per-candidate means,
 *                            95% bootstrap CIs, BH-adjusted Wilcoxon
 *                            p-values, and Cohen's d versus a
 *                            comparator candidate.
 *   - `paretoChart`         Abstract spec for a cost vs quality
 *                            scatter, with gate decisions overlaid.
 *                            Returns numbers + labels — caller
 *                            chooses the plotting library.
 *   - `gainHistogram`
 *                            Per-item paired holdout deltas as a
 *                            histogram spec (bins + counts + median +
 *                            CI). Same "data, not images" contract.
 *
 * The figure types are PlotSpecs — JSON-friendly, library-agnostic.
 * They aren't React components and they aren't PNGs; they are
 * what you'd hand to vega-lite, plotly, matplotlib, or your own
 * Canvas renderer to draw the actual figure.
 */

import type { GateDecision } from './held-out-gate'
import type { FailureClusterReport } from './pipelines/failure-cluster'
import { canonicalize, hashJson } from './pre-registration'
import type { RunRecord } from './run-record'
import {
  benjaminiHochberg,
  cohensD,
  confidenceInterval,
  pairedBootstrap,
  pairedMde,
  wilcoxonSignedRank,
} from './statistics'

// ── summaryTable ───────────────────────────────────────────────────────

export interface SummaryTableOptions {
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

export interface SummaryTableRow {
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
 * BH-adjusted Wilcoxon p + Cohen's d versus that comparator.
 */
export function summaryTable(runs: RunRecord[], opts: SummaryTableOptions = {}): SummaryTable {
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
  const tentative: Array<SummaryTableRow & { rawP: number }> = []
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
  const markdown = renderSummaryTableMarkdown(rows, comparator, split)
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

function renderSummaryTableMarkdown(
  rows: SummaryTableRow[],
  comparator: string | null,
  split: 'search' | 'holdout',
): string {
  const lines: string[] = []
  const cmpLabel = comparator ? ` (vs ${comparator})` : ''
  lines.push(`Summary Table — ${split} split${cmpLabel}`)
  lines.push('')
  lines.push("| Candidate | N | Mean | 95% CI | q (BH) | Cohen's d |")
  lines.push('|---|---:|---:|---|---:|---:|')
  for (const r of rows) {
    const ci = `[${fmt(r.ciLow)}, ${fmt(r.ciHigh)}]`
    const q = Number.isFinite(r.qValue) ? r.qValue.toFixed(4) : '—'
    const d = Number.isFinite(r.cohensD) ? r.cohensD.toFixed(3) : '—'
    lines.push(`| ${r.candidateId} | ${r.n} | ${fmt(r.mean)} | ${ci} | ${q} | ${d} |`)
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
export function paretoChart(
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
export function gainHistogram(
  runs: RunRecord[],
  candidateId: string,
  comparator: string,
  opts: GainDistributionOptions = {},
): GainDistributionFigureSpec {
  const split = opts.split ?? 'holdout'
  const scoreField = split === 'holdout' ? 'holdoutScore' : 'searchScore'
  const binCount = opts.bins ?? 11
  if (binCount < 1) throw new Error('gainHistogram: bins must be ≥ 1')

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

// ── researchReport ───────────────────────────────────────────────────

export type ResearchReportDecision =
  | 'promote'
  | 'hold'
  | 'reject'
  | 'equivalent'
  | 'needs_more_data'

/**
 * Hard floor below which a paired comparison is treated as uninformative
 * regardless of `minPairs`. Mirrors the lower limit on Wilcoxon signed-rank
 * exact tables; below this the test has no power to separate effect sizes.
 */
export const RESEARCH_REPORT_HARD_PAIR_FLOOR = 6

export interface ResearchReportOptions {
  /** Human-readable report title. */
  title?: string
  /** Comparator candidate id. Required for statistical decision guidance. */
  comparator?: string
  /** Which split to use for the primary decision. Default 'holdout'. */
  split?: 'search' | 'holdout'
  /** Confidence level used by lower-level report helpers. Default 0.95. */
  confidence?: number
  /** FDR threshold for q-values. Default 0.05. */
  fdr?: number
  /**
   * Soft floor on paired observations before issuing a directional
   * promote / reject. Below this we report `needs_more_data` and surface the
   * minimum detectable effect at the current N. Default 20 — chosen so the
   * Wilcoxon signed-rank approximation is reasonable and so the paired
   * bootstrap CI has non-degenerate coverage. Hard floor is enforced at
   * `RESEARCH_REPORT_HARD_PAIR_FLOOR` (6) regardless of this value.
   */
  minPairs?: number
  /**
   * Region of Practical Equivalence on the paired delta. When a candidate's
   * paired-delta CI is fully contained in `[low, high]`, the decision is
   * `equivalent` rather than `hold`. Sourced from the domain owner — there is
   * no statistically-defensible default.
   */
  rope?: { low: number; high: number }
  /**
   * Power for the minimum detectable effect (MDE) reported on each candidate.
   * Default 0.8.
   */
  mdePower?: number
  /**
   * Two-sided alpha for the MDE. Default matches `fdr` so the reported MDE
   * lines up with the test the report actually runs.
   */
  mdeAlpha?: number
  /** Optional held-out gate decisions keyed by candidate id. */
  gateDecisions?: Record<string, GateDecision>
  /** Optional failure clusters from failureClusterView. */
  failureClusters?: FailureClusterReport
  /** Build gain histograms for these candidates. Defaults to all non-comparator candidates. */
  candidateIds?: string[]
  /** Deterministic bootstrap seed passed to gainHistogram and the posterior helper. */
  seed?: number
  /** Report timestamp. Defaults to current time. */
  generatedAt?: string
  /**
   * Hash of a preregistered protocol (e.g. `signManifest({...}).contentHash`).
   * Embedded verbatim in the report so the analysis can be cited as the
   * preregistered one rather than a post-hoc fishing expedition.
   */
  preregistrationHash?: string
}

export interface ResearchReportRecommendation {
  decision: ResearchReportDecision
  candidateId: string | null
  rationale: string[]
  risks: string[]
  nextActions: string[]
}

export interface ResearchReportCandidate {
  candidateId: string
  n: number
  mean: number
  ciLow: number
  ciHigh: number
  qValue: number
  cohensD: number
  meanDeltaVsComparator: number | null
  pairedN: number
  medianGain: number | null
  meanGain: number | null
  gainCi: { low: number; high: number } | null
  /**
   * Bayesian-bootstrap-style posterior summaries on the paired delta. Computed
   * from the same resamples that produce the gain CI; interpretable as
   * "fraction of resamples in which the candidate beats the comparator on
   * matched pairs."
   */
  prGreaterThanZero: number | null
  prInRope: number | null
  /**
   * Minimum detectable effect (in score units) at the candidate's paired N,
   * the configured power, and the configured alpha. Standardised by the
   * observed paired-delta SD and inverted via `requiredSampleSize`. Reported
   * for every candidate so a `needs_more_data` verdict is actionable.
   */
  mde: number | null
  onParetoFrontier: boolean
  gate?: ParetoPoint['gate']
  decision: ResearchReportDecision
  decisionReason: string
}

export interface ResearchReportMethodology {
  /**
   * Plain-language assumptions the report depends on. Read these first when
   * deciding whether the verdict is load-bearing for a launch decision.
   */
  assumptions: string[]
  /** Tests and estimators the verdict was computed from. */
  methods: string[]
  /** Alternatives the author considered and why this report didn't take them. */
  alternatives: string[]
  /** Failure modes — when this report should NOT drive a decision. */
  whenNotToApply: string[]
  /** Citations for the methodological choices above. */
  citations: string[]
}

export interface ResearchReport {
  kind: 'agent-eval-research-report'
  title: string
  generatedAt: string
  split: 'search' | 'holdout'
  comparator: string | null
  /**
   * SHA-256 over the canonicalised set of `(runId, candidateId, split)` triples
   * the report was computed from, plus the comparator and split. Stable across
   * key insertion order; recomputable by the reader to verify provenance.
   */
  runFingerprint: string
  preregistrationHash: string | null
  rope: { low: number; high: number } | null
  executiveSummary: string[]
  recommendation: ResearchReportRecommendation
  candidates: ResearchReportCandidate[]
  summary: SummaryTable
  charts: {
    pareto: ParetoFigureSpec
    gains: GainDistributionFigureSpec[]
  }
  methodology: ResearchReportMethodology
  failureClusters?: FailureClusterReport
  markdown: string
  html: string
}

/**
 * Internal: paired posterior summary on (candidate − comparator) deltas.
 *
 * Returns the bootstrap CI on the median (matching `gainHistogram`) plus
 * Bayesian-flavoured posterior summaries Pr(Δ>0) and Pr(Δ∈ROPE) computed
 * from a Bayesian-bootstrap-flavoured resample distribution on the mean
 * (Rubin 1981 — non-informative bootstrap-prior duality), and the
 * minimum detectable paired effect at the configured power and α.
 *
 * `null` is returned when no paired observations exist; callers must
 * gate on `n` before consuming the bootstrap statistics.
 */
function pairedPosterior(
  runs: RunRecord[],
  candidateId: string,
  comparator: string,
  opts: {
    split: 'search' | 'holdout'
    confidence: number
    seed?: number
    rope: { low: number; high: number } | null
    mdePower: number
    mdeAlpha: number
  },
): {
  n: number
  meanDelta: number
  medianDelta: number
  sdDelta: number
  ci: { low: number; high: number }
  prGreaterThanZero: number
  prInRope: number | null
  mde: number
} | null {
  const scoreField = opts.split === 'holdout' ? 'holdoutScore' : 'searchScore'
  const candidate = runs.filter((r) => r.candidateId === candidateId && r.splitTag === opts.split)
  const baseline = runs.filter((r) => r.candidateId === comparator && r.splitTag === opts.split)
  const { before, after } = pairScoresByKey(candidate, baseline, scoreField)
  const n = before.length
  if (n === 0) return null

  const deltas = before.map((b, i) => after[i]! - b)
  const meanDelta = deltas.reduce((s, x) => s + x, 0) / n
  const sortedDeltas = [...deltas].sort((a, b) => a - b)
  const medianDelta = medianOfSorted(sortedDeltas)
  const sdDelta = stdev(deltas, meanDelta)

  const ci = pairedBootstrap(before, after, {
    confidence: opts.confidence,
    resamples: 2000,
    statistic: 'median',
    seed: opts.seed,
  })

  // Enumerate bootstrap-mean samples to derive posterior summaries on the
  // mean delta. Same RNG family as `pairedBootstrap` but kept local so we can
  // examine the full sample distribution rather than just quantiles.
  const meanSamples = bootstrapMeanSamples(deltas, 2000, opts.seed)
  const prGreaterThanZero =
    meanSamples.length === 0 ? 0 : meanSamples.filter((s) => s > 0).length / meanSamples.length
  const prInRope =
    opts.rope === null || meanSamples.length === 0
      ? null
      : meanSamples.filter((s) => s >= opts.rope!.low && s <= opts.rope!.high).length /
        meanSamples.length

  const dStandardised = pairedMde({ nPaired: n, alpha: opts.mdeAlpha, power: opts.mdePower })
  const mde = sdDelta === 0 ? 0 : dStandardised * sdDelta

  return {
    n,
    meanDelta,
    medianDelta,
    sdDelta,
    ci: { low: ci.low, high: ci.high },
    prGreaterThanZero,
    prInRope,
    mde,
  }
}

function bootstrapMeanSamples(deltas: number[], resamples: number, seed?: number): number[] {
  const n = deltas.length
  if (n === 0) return []
  if (n === 1) return new Array<number>(resamples).fill(deltas[0]!)
  const rng = seedRng(seed)
  const samples = new Array<number>(resamples)
  for (let b = 0; b < resamples; b++) {
    let sum = 0
    for (let k = 0; k < n; k++) sum += deltas[Math.floor(rng() * n)]!
    samples[b] = sum / n
  }
  return samples
}

function seedRng(seed?: number): () => number {
  if (seed === undefined) return Math.random
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function stdev(xs: number[], mean: number): number {
  if (xs.length < 2) return 0
  let sse = 0
  for (const x of xs) sse += (x - mean) ** 2
  return Math.sqrt(sse / (xs.length - 1))
}

/**
 * Executive research report for CPO / AI-lead / launch-review consumption.
 *
 * Composes:
 *   - `summaryTable`         marginal stats with BH-FDR-adjusted q-values
 *   - `paretoChart`           cost-vs-quality frontier with gate overlay
 *   - `gainHistogram`         per-candidate paired-delta distribution
 *   - paired posterior (this file): bootstrap CI on median, Pr(Δ>0),
 *                              Pr(Δ∈ROPE), MDE at the configured power
 *
 * Decisions are made on paired evidence — never on marginal means alone —
 * and respect any held-out gate decision the caller passes through. The
 * report embeds a SHA-256 fingerprint of the input run set and, optionally,
 * the hash of a preregistered protocol so a downstream reader can verify
 * provenance and that the analysis was the preregistered one.
 *
 * Async because the fingerprint uses Web Crypto via `hashJson`; deterministic
 * for any fixed `runs`, `seed`, and ROPE.
 */
export async function researchReport(
  runs: RunRecord[],
  opts: ResearchReportOptions = {},
): Promise<ResearchReport> {
  const split = opts.split ?? 'holdout'
  const comparator = opts.comparator ?? null
  const confidence = opts.confidence ?? 0.95
  const fdr = opts.fdr ?? 0.05
  const minPairs = Math.max(opts.minPairs ?? 20, RESEARCH_REPORT_HARD_PAIR_FLOOR)
  const rope = opts.rope ?? null
  const mdePower = opts.mdePower ?? 0.8
  const mdeAlpha = opts.mdeAlpha ?? fdr
  const title = opts.title ?? 'Agent Evaluation Research Report'
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const preregistrationHash = opts.preregistrationHash ?? null

  if (rope && !(Number.isFinite(rope.low) && Number.isFinite(rope.high) && rope.low <= rope.high)) {
    throw new Error(
      `researchReport: rope must satisfy low ≤ high with finite bounds, got ${JSON.stringify(rope)}`,
    )
  }

  const summary = summaryTable(runs, {
    comparator: comparator ?? undefined,
    split,
    confidence,
    fdr,
  })
  const pareto = paretoChart(runs, { split, gateDecisions: opts.gateDecisions })
  const candidateIds =
    opts.candidateIds ?? summary.rows.map((r) => r.candidateId).filter((id) => id !== comparator)
  const gains = comparator
    ? candidateIds.map((id) =>
        gainHistogram(runs, id, comparator, {
          split,
          confidence,
          seed: opts.seed,
        }),
      )
    : []

  const gainByCandidate = new Map(gains.map((g) => [g.candidateId, g]))
  const paretoByCandidate = new Map(pareto.points.map((p) => [p.candidateId, p]))
  const posteriorByCandidate = new Map<string, ReturnType<typeof pairedPosterior>>()
  if (comparator) {
    for (const id of candidateIds) {
      posteriorByCandidate.set(
        id,
        pairedPosterior(runs, id, comparator, {
          split,
          confidence,
          seed: opts.seed,
          rope,
          mdePower,
          mdeAlpha,
        }),
      )
    }
  }

  const candidates = summary.rows
    .map((row) => {
      const gain = gainByCandidate.get(row.candidateId)
      const point = paretoByCandidate.get(row.candidateId)
      const posterior = posteriorByCandidate.get(row.candidateId) ?? null
      const classified = classifyCandidate(row, {
        comparator,
        posterior,
        point,
        fdr,
        minPairs,
        rope,
      })
      return {
        candidateId: row.candidateId,
        n: row.n,
        mean: row.mean,
        ciLow: row.ciLow,
        ciHigh: row.ciHigh,
        qValue: row.qValue,
        cohensD: row.cohensD,
        meanDeltaVsComparator: posterior ? posterior.meanDelta : null,
        pairedN: posterior?.n ?? gain?.n ?? 0,
        medianGain: posterior ? posterior.medianDelta : gain ? gain.median : null,
        meanGain: posterior ? posterior.meanDelta : null,
        gainCi: posterior ? posterior.ci : gain ? gain.ci : null,
        prGreaterThanZero: posterior ? posterior.prGreaterThanZero : null,
        prInRope: posterior ? posterior.prInRope : null,
        mde: posterior ? posterior.mde : null,
        onParetoFrontier: point?.onFrontier ?? false,
        gate: point?.gate,
        decision: classified.decision,
        decisionReason: classified.reason,
      } satisfies ResearchReportCandidate
    })
    .sort((a, b) => {
      const decisionRank = decisionWeight(b.decision) - decisionWeight(a.decision)
      if (decisionRank !== 0) return decisionRank
      return b.mean - a.mean
    })

  const recommendation = buildRecommendation(candidates, {
    comparator,
    failureClusters: opts.failureClusters,
    rope,
    minPairs,
    preregistrationHash,
  })
  const executiveSummary = buildExecutiveSummary(candidates, recommendation, {
    comparator,
    split,
    failureClusters: opts.failureClusters,
    preregistrationHash,
  })
  const methodology = buildMethodology({
    split,
    comparator,
    fdr,
    minPairs,
    rope,
    confidence,
    mdePower,
    mdeAlpha,
  })

  const runFingerprint = await hashJson(
    canonicalize({
      triples: runs
        .filter((r) => r.splitTag === split)
        .map((r) => ({ runId: r.runId, candidateId: r.candidateId, splitTag: r.splitTag }))
        .sort((a, b) => a.runId.localeCompare(b.runId)),
      comparator,
      split,
    }),
  )

  const markdown = renderResearchMarkdown({
    title,
    generatedAt,
    split,
    comparator,
    rope,
    runFingerprint,
    preregistrationHash,
    executiveSummary,
    recommendation,
    candidates,
    summary,
    pareto,
    gains,
    methodology,
    failureClusters: opts.failureClusters,
  })
  const html = renderResearchHtml(markdown, title)

  return {
    kind: 'agent-eval-research-report',
    title,
    generatedAt,
    split,
    comparator,
    runFingerprint,
    preregistrationHash,
    rope,
    executiveSummary,
    recommendation,
    candidates,
    summary,
    charts: { pareto, gains },
    methodology,
    failureClusters: opts.failureClusters,
    markdown,
    html,
  }
}

function buildMethodology(ctx: {
  split: 'search' | 'holdout'
  comparator: string | null
  fdr: number
  minPairs: number
  rope: { low: number; high: number } | null
  confidence: number
  mdePower: number
  mdeAlpha: number
}): ResearchReportMethodology {
  const assumptions: string[] = [
    'Pairs are matched by (experimentId, seed); the candidate and comparator see the same scenarios in the same order.',
    'Paired deltas are exchangeable conditional on the matched scenario — no mid-run distribution shift.',
    `Decisions are pre-specified at fdr=${ctx.fdr}, minPairs=${ctx.minPairs}, confidence=${ctx.confidence}; deviating from these post-hoc invalidates the false-discovery control.`,
  ]
  if (ctx.rope) {
    assumptions.push(
      `The Region of Practical Equivalence ${formatRope(ctx.rope)} is supplied by the domain owner; equivalent verdicts are only meaningful if that range is treated as the standing definition of "no material difference."`,
    )
  }
  if (ctx.comparator === null) {
    assumptions.push('No comparator was configured; this run is descriptive, not causal.')
  }
  const methods: string[] = [
    "Marginal scores summarised with BH-FDR-adjusted Wilcoxon signed-rank q-values and Cohen's d via summaryTable.",
    'Paired evidence summarised with bootstrap CI on the median delta and Bayesian-bootstrap-style Pr(Δ>0) and Pr(Δ∈ROPE) on the mean delta.',
    `Minimum detectable effect reported per candidate at α=${ctx.mdeAlpha} (two-sided), power=${ctx.mdePower}, standardised by the observed paired-delta SD.`,
    'Pareto frontier flagged as a separate axis (cost vs quality); a candidate can be on-frontier without winning the paired test.',
    'Held-out gate decisions, when supplied, override the statistical verdict in the reject direction.',
  ]
  const alternatives: string[] = [
    'Paired t-test rejected: not robust to the heavy-tailed score distributions common in agent benchmarks.',
    'Unpaired Mann–Whitney rejected: matched scenarios make pairing free; unpaired throws away that variance reduction.',
    'Sequential / always-valid inference (e-values, mSPRT) is the right tool for iterative sweeps and is out of scope for this single-look report — preregister and run once, or wrap this report in an alpha-spending schedule.',
    'Hierarchical Bayesian shrinkage across many candidates is future work; the current ranking uses raw paired statistics.',
  ]
  const whenNotToApply: string[] = [
    `Paired N below ${RESEARCH_REPORT_HARD_PAIR_FLOOR} on any candidate — the bootstrap CI is degenerate.`,
    'Comparator chosen post-hoc by inspecting the same data; q-values are no longer false-discovery-controlled.',
    'Scenarios not drawn under a stable preregistered protocol; the report can describe the data but cannot anchor a launch decision.',
    'Score distributions with mid-run shift (judge model swap, rubric change, infra outage) — pair exchangeability is violated.',
  ]
  const citations: string[] = [
    'Benjamini, Y. & Hochberg, Y. (1995). Controlling the false discovery rate: a practical and powerful approach to multiple testing. JRSS B, 57(1), 289–300.',
    'Wilcoxon, F. (1945). Individual comparisons by ranking methods. Biometrics Bulletin, 1(6), 80–83.',
    'Efron, B. (1979). Bootstrap methods: another look at the jackknife. Annals of Statistics, 7(1), 1–26.',
    'Rubin, D. B. (1981). The Bayesian bootstrap. Annals of Statistics, 9(1), 130–134.',
    'Kruschke, J. K. (2018). Rejecting or accepting parameter values in Bayesian estimation. Advances in Methods and Practices in Psychological Science, 1(2), 270–280. (ROPE.)',
  ]
  return { assumptions, methods, alternatives, whenNotToApply, citations }
}

function formatRope(rope: { low: number; high: number }): string {
  return `[${fmt(rope.low)}, ${fmt(rope.high)}]`
}

function classifyCandidate(
  row: SummaryTableRow,
  ctx: {
    comparator: string | null
    posterior: ReturnType<typeof pairedPosterior> | null
    point?: ParetoPoint
    fdr: number
    minPairs: number
    rope: { low: number; high: number } | null
  },
): { decision: ResearchReportDecision; reason: string } {
  if (ctx.comparator && row.candidateId === ctx.comparator) {
    return { decision: 'hold', reason: 'Comparator baseline.' }
  }
  if (!ctx.comparator) {
    return {
      decision: ctx.point?.onFrontier ? 'hold' : 'needs_more_data',
      reason:
        'No comparator configured; report ranks candidates but cannot anchor a promotion call.',
    }
  }
  // Held-out gate is authoritative against — promote requires statistical
  // evidence even if the gate said `promote` (gate is necessary, not sufficient).
  if (ctx.point?.gate && ctx.point.gate !== 'promote') {
    return { decision: 'reject', reason: `Held-out gate returned ${ctx.point.gate}.` }
  }
  if (!ctx.posterior || ctx.posterior.n < RESEARCH_REPORT_HARD_PAIR_FLOOR) {
    return {
      decision: 'needs_more_data',
      reason: `Only ${ctx.posterior?.n ?? 0} paired observations; below hard floor of ${RESEARCH_REPORT_HARD_PAIR_FLOOR} for any paired inference.`,
    }
  }
  const ci = ctx.posterior.ci
  if (ctx.rope && ci.low >= ctx.rope.low && ci.high <= ctx.rope.high) {
    return {
      decision: 'equivalent',
      reason: `Paired-delta CI [${fmt(ci.low)}, ${fmt(ci.high)}] is fully inside ROPE ${formatRope(ctx.rope)}; candidate is practically equivalent to comparator.`,
    }
  }
  const significant = Number.isFinite(row.qValue) && row.qValue <= ctx.fdr
  const gainPositive = ci.low > 0
  const gainNegative = ci.high < 0
  if (gainNegative) {
    return {
      decision: 'reject',
      reason: `Paired-delta CI [${fmt(ci.low)}, ${fmt(ci.high)}] lies entirely below zero.`,
    }
  }
  if (ctx.posterior.n < ctx.minPairs) {
    return {
      decision: 'needs_more_data',
      reason: `Only ${ctx.posterior.n} paired observations; minimum detectable effect at this N is ${fmt(ctx.posterior.mde)} score units (need ≥ ${ctx.minPairs} pairs to issue a directional verdict).`,
    }
  }
  if (significant && gainPositive) {
    return {
      decision: 'promote',
      reason: `BH-adjusted q=${fmt(row.qValue)} ≤ ${ctx.fdr} and paired-delta CI [${fmt(ci.low)}, ${fmt(ci.high)}] excludes zero; Pr(Δ>0)=${fmt(ctx.posterior.prGreaterThanZero)}.`,
    }
  }
  return {
    decision: 'hold',
    reason: `Pr(Δ>0)=${fmt(ctx.posterior.prGreaterThanZero)} but CI [${fmt(ci.low)}, ${fmt(ci.high)}] crosses zero; effect not decisive at fdr=${ctx.fdr}.`,
  }
}

function buildRecommendation(
  candidates: ResearchReportCandidate[],
  ctx: {
    comparator: string | null
    failureClusters?: FailureClusterReport
    rope: { low: number; high: number } | null
    minPairs: number
    preregistrationHash: string | null
  },
): ResearchReportRecommendation {
  const nonComparator = candidates.filter((c) => c.candidateId !== ctx.comparator)
  const bestPromote = nonComparator.find((c) => c.decision === 'promote')
  const bestEquivalent = nonComparator.find((c) => c.decision === 'equivalent')
  const chosen = bestPromote ?? bestEquivalent ?? nonComparator[0] ?? null
  const decision: ResearchReportDecision = bestPromote
    ? 'promote'
    : nonComparator.some((c) => c.decision === 'needs_more_data')
      ? 'needs_more_data'
      : bestEquivalent
        ? 'equivalent'
        : nonComparator.some((c) => c.decision === 'hold')
          ? 'hold'
          : 'reject'

  const rationale: string[] = []
  const risks: string[] = []
  const nextActions: string[] = []

  if (chosen) {
    rationale.push(`${chosen.candidateId}: ${chosen.decisionReason}`)
    if (chosen.gainCi) {
      const probSummary =
        chosen.prGreaterThanZero !== null ? `, Pr(Δ>0)=${fmt(chosen.prGreaterThanZero)}` : ''
      rationale.push(
        `Median paired gain CI: [${fmt(chosen.gainCi.low)}, ${fmt(chosen.gainCi.high)}]${probSummary}.`,
      )
    }
    if (chosen.mde !== null && Number.isFinite(chosen.mde)) {
      rationale.push(`MDE at current paired N=${chosen.pairedN}: ${fmt(chosen.mde)} score units.`)
    }
  }
  if (!ctx.comparator) {
    risks.push('No comparator was configured; verdict is descriptive, not causal.')
    nextActions.push('Re-run with a stable comparator candidate for paired inference.')
  }
  if (!ctx.preregistrationHash) {
    risks.push(
      'No preregistration hash supplied; readers cannot verify the analysis was specified before data inspection.',
    )
    nextActions.push(
      'Sign a HypothesisManifest before the next sweep and pass `preregistrationHash` so the report cites it.',
    )
  }
  if (ctx.rope === null && nonComparator.length > 0) {
    risks.push(
      'No ROPE configured; the report cannot distinguish "equivalent" from "inconclusive".',
    )
    nextActions.push(
      'Define a domain-specific Region of Practical Equivalence and pass it to lock in the equivalence threshold.',
    )
  }
  const inconclusive = nonComparator.filter((c) => c.decision === 'needs_more_data')
  if (inconclusive.length > 0) {
    const worst = inconclusive.reduce((a, b) => (b.pairedN < a.pairedN ? b : a))
    risks.push(
      `${inconclusive.length} candidate(s) below soft floor (${ctx.minPairs} pairs); thinnest is ${worst.candidateId} with ${worst.pairedN}.`,
    )
    nextActions.push(
      `Collect at least ${ctx.minPairs - worst.pairedN} more matched holdout runs for ${worst.candidateId}.`,
    )
  }
  const rejected = nonComparator.filter((c) => c.decision === 'reject')
  if (rejected.length > 0) {
    risks.push(
      `${rejected.length} candidate(s) failed the paired test or held-out gate; do not ship those variants.`,
    )
  }
  if (ctx.failureClusters && ctx.failureClusters.clusters.length > 0) {
    const top = ctx.failureClusters.clusters[0]!
    risks.push(`Top failure cluster: ${top.failureClass} across ${top.runCount} run(s).`)
    nextActions.push('Prioritize the largest failure cluster before broad rollout.')
  }
  if (decision === 'promote') {
    nextActions.push('Ship behind the existing promotion gate and monitor canaries.')
  } else if (decision === 'hold') {
    nextActions.push('Keep current production candidate while expanding holdout evidence.')
  } else if (decision === 'equivalent') {
    nextActions.push(
      'Either keep the comparator (no quality regression) or promote on cost/latency grounds — equivalence does not justify either; the choice is a product decision, not a stats one.',
    )
  } else if (decision === 'reject') {
    nextActions.push(
      'Do not promote this sweep; inspect failures and generate a revised candidate.',
    )
  }

  return {
    decision,
    candidateId: chosen?.candidateId ?? null,
    rationale,
    risks,
    nextActions,
  }
}

function buildExecutiveSummary(
  candidates: ResearchReportCandidate[],
  recommendation: ResearchReportRecommendation,
  ctx: {
    comparator: string | null
    split: 'search' | 'holdout'
    failureClusters?: FailureClusterReport
    preregistrationHash: string | null
  },
): string[] {
  const lines: string[] = []
  const nonComparator = candidates.filter((c) => c.candidateId !== ctx.comparator)
  lines.push(
    `Evaluated ${nonComparator.length} candidate(s) on the ${ctx.split} split${ctx.comparator ? ` against ${ctx.comparator}` : ''}.`,
  )
  lines.push(
    `Recommendation: ${recommendation.decision}${recommendation.candidateId ? ` ${recommendation.candidateId}` : ''}.`,
  )
  const promoted = nonComparator.filter((c) => c.decision === 'promote').length
  const held = nonComparator.filter((c) => c.decision === 'hold').length
  const equivalent = nonComparator.filter((c) => c.decision === 'equivalent').length
  const rejected = nonComparator.filter((c) => c.decision === 'reject').length
  const more = nonComparator.filter((c) => c.decision === 'needs_more_data').length
  lines.push(
    `Decision mix: ${promoted} promote, ${equivalent} equivalent, ${held} hold, ${rejected} reject, ${more} need more data.`,
  )
  const frontier = nonComparator.filter((c) => c.onParetoFrontier).map((c) => c.candidateId)
  if (frontier.length > 0) lines.push(`Pareto-frontier candidates: ${frontier.join(', ')}.`)
  if (ctx.failureClusters) {
    lines.push(
      `Failure clustering found ${ctx.failureClusters.totalFailures}/${ctx.failureClusters.totalRuns} failed runs across ${ctx.failureClusters.clusters.length} reportable cluster(s).`,
    )
  }
  lines.push(
    ctx.preregistrationHash
      ? `Preregistered analysis: ${ctx.preregistrationHash.slice(0, 12)}…`
      : 'Analysis is post-hoc — no preregistration hash supplied.',
  )
  return lines
}

function renderResearchMarkdown(report: {
  title: string
  generatedAt: string
  split: 'search' | 'holdout'
  comparator: string | null
  executiveSummary: string[]
  recommendation: ResearchReportRecommendation
  candidates: ResearchReportCandidate[]
  summary: SummaryTable
  pareto: ParetoFigureSpec
  gains: GainDistributionFigureSpec[]
  rope: { low: number; high: number } | null
  runFingerprint: string
  preregistrationHash: string | null
  methodology: ResearchReportMethodology
  failureClusters?: FailureClusterReport
}): string {
  const lines: string[] = []
  lines.push(`# ${report.title}`)
  lines.push('')
  lines.push(`**Generated:** ${report.generatedAt}`)
  lines.push(`**Primary split:** ${report.split}`)
  lines.push(`**Comparator:** ${report.comparator ?? 'not configured'}`)
  lines.push(`**ROPE:** ${report.rope ? formatRope(report.rope) : 'not configured'}`)
  lines.push(`**Run fingerprint:** \`${report.runFingerprint}\``)
  lines.push(
    `**Preregistration:** ${report.preregistrationHash ? `\`${report.preregistrationHash}\`` : 'none'}`,
  )
  lines.push('')
  lines.push('## Executive Summary')
  lines.push('')
  for (const item of report.executiveSummary) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Recommendation')
  lines.push('')
  lines.push(`**Decision:** ${report.recommendation.decision}`)
  lines.push(`**Candidate:** ${report.recommendation.candidateId ?? 'N/A'}`)
  lines.push('')
  lines.push('### Rationale')
  lines.push('')
  for (const item of report.recommendation.rationale) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Risks')
  lines.push('')
  for (const item of report.recommendation.risks.length
    ? report.recommendation.risks
    : ['No material report-level risks detected.']) {
    lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('### Next Actions')
  lines.push('')
  for (const item of report.recommendation.nextActions) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Candidate Decision Table')
  lines.push('')
  lines.push(
    '| Candidate | Decision | Mean | Δ̄ | Pr(Δ>0) | q | d | Paired N | Median Gain CI | MDE | Pareto | Gate |',
  )
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|---:|---|---|')
  for (const c of report.candidates) {
    const delta = c.meanDeltaVsComparator === null ? '-' : signed(c.meanDeltaVsComparator)
    const prGt = c.prGreaterThanZero === null ? '-' : c.prGreaterThanZero.toFixed(3)
    const q = Number.isFinite(c.qValue) ? c.qValue.toFixed(4) : '-'
    const d = Number.isFinite(c.cohensD) ? c.cohensD.toFixed(3) : '-'
    const gain = c.gainCi ? `[${fmt(c.gainCi.low)}, ${fmt(c.gainCi.high)}]` : '-'
    const mde = c.mde === null || !Number.isFinite(c.mde) ? '-' : fmt(c.mde)
    lines.push(
      `| ${c.candidateId} | ${c.decision} | ${fmt(c.mean)} | ${delta} | ${prGt} | ${q} | ${d} | ${c.pairedN} | ${gain} | ${mde} | ${c.onParetoFrontier ? 'yes' : 'no'} | ${c.gate ?? '-'} |`,
    )
  }
  lines.push('')
  lines.push('## Statistical Summary')
  lines.push('')
  lines.push(report.summary.markdown)
  lines.push('')
  lines.push('## Methodology')
  lines.push('')
  lines.push('### Assumptions')
  lines.push('')
  for (const item of report.methodology.assumptions) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Methods')
  lines.push('')
  for (const item of report.methodology.methods) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Alternatives Considered')
  lines.push('')
  for (const item of report.methodology.alternatives) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### When NOT To Apply')
  lines.push('')
  for (const item of report.methodology.whenNotToApply) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### Citations')
  lines.push('')
  for (const item of report.methodology.citations) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Chart Specs')
  lines.push('')
  lines.push(
    'The report carries JSON chart specs for Pareto cost/quality and paired gain histograms.',
  )
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({ pareto: report.pareto, gains: report.gains }, null, 2))
  lines.push('```')
  if (report.failureClusters) {
    lines.push('')
    lines.push('## Failure Clusters')
    lines.push('')
    lines.push('| Failure Class | Runs | Scenarios | Tool | Example |')
    lines.push('|---|---:|---:|---|---|')
    for (const c of report.failureClusters.clusters.slice(0, 10)) {
      lines.push(
        `| ${c.failureClass} | ${c.runCount} | ${c.scenarioIds.length} | ${c.toolName ?? '-'} | ${escapePipes(c.exampleError ?? c.exampleRunId)} |`,
      )
    }
  }
  return lines.join('\n')
}

function renderResearchHtml(markdown: string, title: string): string {
  const body = markdownToHtml(markdown)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#172026;background:#f7f8f8;}',
    'main{max-width:1080px;margin:0 auto;padding:40px 24px 64px;background:#fff;min-height:100vh;}',
    'h1{font-size:34px;line-height:1.15;margin:0 0 20px;}h2{margin-top:34px;border-top:1px solid #d9dfdf;padding-top:22px;}h3{margin-top:22px;}',
    'p,li{line-height:1.55;}table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;}th,td{border:1px solid #d9dfdf;padding:8px;text-align:left;}th{background:#eef2f2;}',
    'code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}pre{overflow:auto;background:#111827;color:#f9fafb;padding:16px;border-radius:6px;}',
    '</style>',
    '</head>',
    '<body><main>',
    body,
    '</main></body></html>',
  ].join('\n')
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n')
  const html: string[] = []
  let inList = false
  let inCode = false
  let code: string[] = []
  let table: string[] = []

  const flushList = () => {
    if (inList) {
      html.push('</ul>')
      inList = false
    }
  }
  const flushTable = () => {
    if (table.length === 0) return
    html.push(renderMarkdownTable(table))
    table = []
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        code = []
        inCode = false
      } else {
        flushList()
        flushTable()
        inCode = true
      }
      continue
    }
    if (inCode) {
      code.push(line)
      continue
    }
    if (line.startsWith('|')) {
      flushList()
      table.push(line)
      continue
    }
    flushTable()
    if (line.startsWith('- ')) {
      if (!inList) {
        html.push('<ul>')
        inList = true
      }
      html.push(`<li>${inlineMarkdown(line.slice(2))}</li>`)
      continue
    }
    flushList()
    if (line.startsWith('# ')) html.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`)
    else if (line.startsWith('## ')) html.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`)
    else if (line.startsWith('### ')) html.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`)
    else if (line.trim() === '') html.push('')
    else html.push(`<p>${inlineMarkdown(line)}</p>`)
  }
  flushList()
  flushTable()
  return html.join('\n')
}

function renderMarkdownTable(lines: string[]): string {
  const rows = lines
    .filter((line) => !/^\|[-:\s|]+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => inlineMarkdown(cell.trim())),
    )
  if (rows.length === 0) return ''
  const [head, ...body] = rows
  const th = head!.map((cell) => `<th>${cell}</th>`).join('')
  const trs = body
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('\n')
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`
}

function inlineMarkdown(s: string): string {
  return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|')
}

function decisionWeight(decision: ResearchReportDecision): number {
  if (decision === 'promote') return 5
  if (decision === 'equivalent') return 4
  if (decision === 'hold') return 3
  if (decision === 'needs_more_data') return 2
  return 1
}

function signed(x: number): string {
  return `${x >= 0 ? '+' : ''}${fmt(x)}`
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
