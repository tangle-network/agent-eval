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

import { confidenceInterval, cohensD, wilcoxonSignedRank } from './statistics'
import { benjaminiHochberg } from './power-analysis'
import { pairedBootstrap } from './paired-stats'
import type { GateDecision } from './held-out-gate'
import type { FailureClusterReport } from './pipelines/failure-cluster'
import type { RunRecord } from './run-record'

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
  | 'needs_more_data'

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
  /** Minimum paired observations before making a promote/reject call. Default 6. */
  minPairs?: number
  /** Optional held-out gate decisions keyed by candidate id. */
  gateDecisions?: Record<string, GateDecision>
  /** Optional failure clusters from failureClusterView. */
  failureClusters?: FailureClusterReport
  /** Build gain histograms for these candidates. Defaults to all non-comparator candidates. */
  candidateIds?: string[]
  /** Deterministic bootstrap seed passed to gainHistogram. */
  seed?: number
  /** Report timestamp. Defaults to current time. */
  generatedAt?: string
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
  gainCi: { low: number; high: number } | null
  onParetoFrontier: boolean
  gate?: ParetoPoint['gate']
  decision: ResearchReportDecision
  decisionReason: string
}

export interface ResearchReport {
  kind: 'agent-eval-research-report'
  title: string
  generatedAt: string
  split: 'search' | 'holdout'
  comparator: string | null
  executiveSummary: string[]
  recommendation: ResearchReportRecommendation
  candidates: ResearchReportCandidate[]
  summary: SummaryTable
  charts: {
    pareto: ParetoFigureSpec
    gains: GainDistributionFigureSpec[]
  }
  failureClusters?: FailureClusterReport
  markdown: string
  html: string
}

/**
 * Executive research report for CPO / AI-lead review. This composes the
 * primitive table and chart specs into an opinionated decision package:
 * ranked candidates, promotion guidance, key risks, next actions, markdown,
 * and a dependency-free HTML page.
 */
export function researchReport(runs: RunRecord[], opts: ResearchReportOptions = {}): ResearchReport {
  const split = opts.split ?? 'holdout'
  const comparator = opts.comparator ?? null
  const fdr = opts.fdr ?? 0.05
  const minPairs = opts.minPairs ?? 6
  const title = opts.title ?? 'Agent Evaluation Research Report'
  const generatedAt = opts.generatedAt ?? new Date().toISOString()

  const summary = summaryTable(runs, {
    comparator: comparator ?? undefined,
    split,
    confidence: opts.confidence,
    fdr,
  })
  const pareto = paretoChart(runs, { split, gateDecisions: opts.gateDecisions })
  const candidateIds = opts.candidateIds
    ?? summary.rows.map((r) => r.candidateId).filter((id) => id !== comparator)
  const gains = comparator
    ? candidateIds.map((id) => gainHistogram(runs, id, comparator, {
      split,
      confidence: opts.confidence,
      seed: opts.seed,
    }))
    : []

  const gainByCandidate = new Map(gains.map((g) => [g.candidateId, g]))
  const paretoByCandidate = new Map(pareto.points.map((p) => [p.candidateId, p]))
  const comparatorRow = comparator ? summary.rows.find((r) => r.candidateId === comparator) : undefined

  const candidates = summary.rows
    .map((row) => {
      const gain = gainByCandidate.get(row.candidateId)
      const point = paretoByCandidate.get(row.candidateId)
      const meanDelta = comparatorRow && row.candidateId !== comparator
        ? row.mean - comparatorRow.mean
        : null
      const classified = classifyCandidate(row, {
        comparator,
        comparatorRow,
        gain,
        point,
        fdr,
        minPairs,
      })
      return {
        candidateId: row.candidateId,
        n: row.n,
        mean: row.mean,
        ciLow: row.ciLow,
        ciHigh: row.ciHigh,
        qValue: row.qValue,
        cohensD: row.cohensD,
        meanDeltaVsComparator: meanDelta,
        pairedN: gain?.n ?? 0,
        medianGain: gain ? gain.median : null,
        gainCi: gain ? gain.ci : null,
        onParetoFrontier: point?.onFrontier ?? false,
        gate: point?.gate,
        decision: classified.decision,
        decisionReason: classified.reason,
      }
    })
    .sort((a, b) => {
      const decisionRank = decisionWeight(b.decision) - decisionWeight(a.decision)
      if (decisionRank !== 0) return decisionRank
      return b.mean - a.mean
    })

  const recommendation = buildRecommendation(candidates, {
    comparator,
    failureClusters: opts.failureClusters,
  })
  const executiveSummary = buildExecutiveSummary(candidates, recommendation, {
    comparator,
    split,
    failureClusters: opts.failureClusters,
  })
  const markdown = renderResearchMarkdown({
    title,
    generatedAt,
    split,
    comparator,
    executiveSummary,
    recommendation,
    candidates,
    summary,
    pareto,
    gains,
    failureClusters: opts.failureClusters,
  })
  const html = renderResearchHtml(markdown, title)

  return {
    kind: 'agent-eval-research-report',
    title,
    generatedAt,
    split,
    comparator,
    executiveSummary,
    recommendation,
    candidates,
    summary,
    charts: { pareto, gains },
    failureClusters: opts.failureClusters,
    markdown,
    html,
  }
}

function classifyCandidate(
  row: SummaryTableRow,
  ctx: {
    comparator: string | null
    comparatorRow?: SummaryTableRow
    gain?: GainDistributionFigureSpec
    point?: ParetoPoint
    fdr: number
    minPairs: number
  },
): { decision: ResearchReportDecision; reason: string } {
  if (ctx.comparator && row.candidateId === ctx.comparator) {
    return { decision: 'hold', reason: 'Comparator baseline.' }
  }
  if (!ctx.comparator || !ctx.comparatorRow) {
    return {
      decision: ctx.point?.onFrontier ? 'hold' : 'needs_more_data',
      reason: 'No comparator configured, so the report ranks candidates but does not make a promotion call.',
    }
  }
  if (!ctx.gain || ctx.gain.n < ctx.minPairs || !Number.isFinite(row.qValue)) {
    return {
      decision: 'needs_more_data',
      reason: `Only ${ctx.gain?.n ?? 0} paired observations; need at least ${ctx.minPairs}.`,
    }
  }
  if (ctx.point?.gate && ctx.point.gate !== 'promote') {
    return { decision: 'reject', reason: `Held-out gate returned ${ctx.point.gate}.` }
  }
  const significant = row.qValue <= ctx.fdr
  const gainPositive = ctx.gain.ci.low > 0
  const gainNegative = ctx.gain.ci.high < 0
  if (significant && gainPositive && row.mean > ctx.comparatorRow.mean) {
    return { decision: 'promote', reason: 'Positive paired gain with significant BH-adjusted Wilcoxon result.' }
  }
  if (gainNegative || (significant && row.mean < ctx.comparatorRow.mean)) {
    return { decision: 'reject', reason: 'Held-out paired evidence is worse than comparator.' }
  }
  return { decision: 'hold', reason: 'Effect is directionally useful but not decisive at the configured threshold.' }
}

function buildRecommendation(
  candidates: ResearchReportCandidate[],
  ctx: { comparator: string | null; failureClusters?: FailureClusterReport },
): ResearchReportRecommendation {
  const bestPromote = candidates.find((c) => c.decision === 'promote')
  const bestHold = candidates.find((c) => c.candidateId !== ctx.comparator)
  const chosen = bestPromote ?? bestHold ?? null
  const decision: ResearchReportDecision = bestPromote
    ? 'promote'
    : candidates.some((c) => c.decision === 'needs_more_data')
      ? 'needs_more_data'
      : candidates.some((c) => c.decision === 'hold')
        ? 'hold'
        : 'reject'

  const rationale: string[] = []
  const risks: string[] = []
  const nextActions: string[] = []

  if (chosen) {
    rationale.push(`${chosen.candidateId} has the strongest decision posture: ${chosen.decisionReason}`)
    if (chosen.meanDeltaVsComparator !== null) {
      rationale.push(`Mean delta vs ${ctx.comparator}: ${signed(chosen.meanDeltaVsComparator)}.`)
    }
    if (chosen.gainCi) {
      rationale.push(`Median paired gain CI: [${fmt(chosen.gainCi.low)}, ${fmt(chosen.gainCi.high)}].`)
    }
  }
  if (!ctx.comparator) {
    risks.push('No comparator was configured, so causal promotion guidance is limited.')
    nextActions.push('Re-run with a stable comparator candidate for paired inference.')
  }
  const inconclusive = candidates.filter((c) => c.decision === 'needs_more_data')
  if (inconclusive.length > 0) {
    risks.push(`${inconclusive.length} candidate(s) do not have enough paired evidence for a final call.`)
    nextActions.push('Collect more matched holdout runs for inconclusive candidates.')
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
  } else if (decision === 'reject') {
    nextActions.push('Do not promote this sweep; inspect failures and generate a revised candidate.')
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
  ctx: { comparator: string | null; split: 'search' | 'holdout'; failureClusters?: FailureClusterReport },
): string[] {
  const lines: string[] = []
  const candidateCount = candidates.filter((c) => c.candidateId !== ctx.comparator).length
  lines.push(`Evaluated ${candidateCount} candidate(s) on the ${ctx.split} split${ctx.comparator ? ` against ${ctx.comparator}` : ''}.`)
  lines.push(`Recommendation: ${recommendation.decision}${recommendation.candidateId ? ` ${recommendation.candidateId}` : ''}.`)
  const promoted = candidates.filter((c) => c.decision === 'promote').length
  const held = candidates.filter((c) => c.decision === 'hold' && c.candidateId !== ctx.comparator).length
  const rejected = candidates.filter((c) => c.decision === 'reject').length
  const more = candidates.filter((c) => c.decision === 'needs_more_data').length
  lines.push(`Decision mix: ${promoted} promote, ${held} hold, ${rejected} reject, ${more} need more data.`)
  const frontier = candidates.filter((c) => c.onParetoFrontier && c.candidateId !== ctx.comparator).map((c) => c.candidateId)
  if (frontier.length > 0) lines.push(`Pareto-frontier candidates: ${frontier.join(', ')}.`)
  if (ctx.failureClusters) {
    lines.push(`Failure clustering found ${ctx.failureClusters.totalFailures}/${ctx.failureClusters.totalRuns} failed runs across ${ctx.failureClusters.clusters.length} reportable cluster(s).`)
  }
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
  failureClusters?: FailureClusterReport
}): string {
  const lines: string[] = []
  lines.push(`# ${report.title}`)
  lines.push('')
  lines.push(`**Generated:** ${report.generatedAt}`)
  lines.push(`**Primary split:** ${report.split}`)
  lines.push(`**Comparator:** ${report.comparator ?? 'not configured'}`)
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
  for (const item of report.recommendation.risks.length ? report.recommendation.risks : ['No material report-level risks detected.']) {
    lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('### Next Actions')
  lines.push('')
  for (const item of report.recommendation.nextActions) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Candidate Decision Table')
  lines.push('')
  lines.push('| Candidate | Decision | Mean | Delta | q | d | Paired N | Median Gain CI | Pareto | Gate |')
  lines.push('|---|---|---:|---:|---:|---:|---:|---|---|---|')
  for (const c of report.candidates) {
    const delta = c.meanDeltaVsComparator === null ? '-' : signed(c.meanDeltaVsComparator)
    const q = Number.isFinite(c.qValue) ? c.qValue.toFixed(4) : '-'
    const d = Number.isFinite(c.cohensD) ? c.cohensD.toFixed(3) : '-'
    const gain = c.gainCi ? `[${fmt(c.gainCi.low)}, ${fmt(c.gainCi.high)}]` : '-'
    lines.push(`| ${c.candidateId} | ${c.decision} | ${fmt(c.mean)} | ${delta} | ${q} | ${d} | ${c.pairedN} | ${gain} | ${c.onParetoFrontier ? 'yes' : 'no'} | ${c.gate ?? '-'} |`)
  }
  lines.push('')
  lines.push('## Statistical Summary')
  lines.push('')
  lines.push(report.summary.markdown)
  lines.push('')
  lines.push('## Chart Specs')
  lines.push('')
  lines.push('The report carries JSON chart specs for Pareto cost/quality and paired gain histograms.')
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
      lines.push(`| ${c.failureClass} | ${c.runCount} | ${c.scenarioIds.length} | ${c.toolName ?? '-'} | ${escapePipes(c.exampleError ?? c.exampleRunId)} |`)
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
    .map((line) => line.slice(1, -1).split('|').map((cell) => inlineMarkdown(cell.trim())))
  if (rows.length === 0) return ''
  const [head, ...body] = rows
  const th = head!.map((cell) => `<th>${cell}</th>`).join('')
  const trs = body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('\n')
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
  if (decision === 'promote') return 4
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
