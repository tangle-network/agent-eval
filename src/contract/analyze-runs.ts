/**
 * # `analyzeRuns()` — turn a set of agent runs into an actionable decision packet.
 *
 * Wires the substrate's statistical, calibration, clustering, Pareto, and
 * release-confidence primitives into one `InsightReport`. Two top-level
 * entry points use this function:
 *
 *   - `selfImprove()` calls it on the campaign output to attach a packet
 *     to every run.
 *   - Consumers with observed `RunRecord[]` (production traces, gold
 *     corpora, approve/reject tables) call it directly via `analyzeRuns()`
 *     for analysis without a closed loop.
 *
 * Every section is opt-in based on what the input data supports — the
 * function never invents signal. If runs carry no judge scores, `judges`
 * is empty. If there's no baseline/candidate split, `lift` is undefined.
 * If no `analyst` is wired, `failureClusters` is undefined.
 *
 * The `recommendations` array is the human-readable layer; everything
 * else is the evidence backing each recommendation.
 */

import type { AnalystRegistry } from '../analyst/registry'
import type { AnalystFinding } from '../analyst/types'
import { checkCanaries } from '../contamination-guard'
import type { DatasetScenario } from '../dataset'
import { summarizeBackendIntegrity } from '../integrity/backend-integrity'
import type { RunRecord } from '../run-record'
import { cohensD, pairedBootstrap, pairedMde, pairedTTest, requiredSampleSize } from '../statistics'
import { type ParetoFigureSpec, paretoChart } from '../summary-report'

import type {
  FailureClusterInsight,
  FailureModeTally,
  InsightReport,
  InterRaterInsight,
  JudgeInsight,
  LiftInsight,
  MetricDelta,
  OutcomeCorrelationInsight,
  PriorPeriodComparison,
  Recommendation,
  ScalarDistribution,
} from './insight-report'

// ── Public API ───────────────────────────────────────────────────────

export interface AnalyzeRunsOptions {
  /** The runs to analyze. */
  runs: RunRecord[]
  /** Which split to score against when reading composite from RunOutcome.
   *  Default: holdout when ANY run has a `holdoutScore`, else search. */
  split?: 'search' | 'holdout' | 'auto'
  /** Pairwise analysis configuration. When both `baselineCandidateId` and
   *  `candidateCandidateId` are present, lift is computed on paired
   *  (experimentId, seed) tuples shared between the two sides. */
  baselineCandidateId?: string
  candidateCandidateId?: string
  /** Canary scenarios — checked against every run's raw output for
   *  holdout contamination. */
  canaryScenarios?: DatasetScenario[]
  /** Analyst registry for failure clustering. When omitted, the
   *  `failureClusters` section is left undefined. */
  analyst?: AnalystRegistry
  /** Downstream outcome metric per run (e.g. engagement rate, approval
   *  rate, downstream pass rate). When present, the report includes
   *  `outcomeCorrelation` + a simple linear reward model fit. */
  outcomeSignal?: {
    metric: string
    valueByRunId: Record<string, number>
  }
  /** Multi-rater feedback for inter-rater agreement. Each entry is one
   *  rater's score for one run. Two or more raters → kappa + disagreement
   *  triage list. */
  raterScores?: Array<{ runId: string; rater: string; score: number }>
  /** Number of histogram bins for distributional summaries. Default 12. */
  histogramBins?: number
  /** Decision threshold — the smallest composite lift the caller cares
   *  about. Used by the recommendations engine to call ship vs hold.
   *  Default 0.02. */
  decisionThreshold?: number
  /** Optional prior-period runs. When set, the report includes
   *  `priorPeriodComparison` with per-metric Welch-CI deltas and
   *  recommendations fire on statistically significant regressions.
   *  The two windows do NOT have to share scenarios — the comparison
   *  is two-sample unpaired (the substrate's `lift` field uses paired
   *  bootstrap on shared (experimentId, seed) tuples; this is the
   *  shape for "this week vs last week" rather than "candidate vs
   *  baseline within a campaign"). */
  baselineRuns?: RunRecord[]
  /** Human-readable label for the baseline window, e.g. "vs prior 7
   *  days", "vs v3.1 release". Surfaces in recommendations + UI. */
  baselineLabel?: string
}

export async function analyzeRuns(opts: AnalyzeRunsOptions): Promise<InsightReport> {
  const runs = opts.runs
  const bins = opts.histogramBins ?? 12
  const threshold = opts.decisionThreshold ?? 0.02
  const split = resolveSplit(runs, opts.split ?? 'auto')

  const compositeWithIds = runs
    .map((r) => ({ runId: r.runId, score: compositeOf(r, split) }))
    .filter((p) => Number.isFinite(p.score))
  const composite = distributionOf(
    compositeWithIds.map((p) => p.score),
    bins,
    compositeWithIds,
  )

  const perDimension = computePerDimension(runs, bins)

  const costs = runs.map((r) => r.costUsd).filter(Number.isFinite)
  const costDist = distributionOf(costs, bins)
  const pareto = paretoChart(runs, { split })
  const degraded: { cost?: string; pareto?: string } = {}
  if (costs.length === 0 || costs.every((c) => c === 0)) {
    degraded.cost = diagnoseZeroCost(runs)
  }
  if (pareto.points.length < 2) {
    degraded.pareto =
      pareto.points.length === 0
        ? 'no candidates — Pareto unavailable'
        : 'single candidate — Pareto is a single point, not a frontier'
  }
  const costQuality = {
    cost: costDist,
    pareto,
    ...(degraded.cost || degraded.pareto ? { degraded } : {}),
  }

  const judges = computeJudgeInsights(runs)

  const interRater = opts.raterScores ? computeInterRater(opts.raterScores) : undefined

  const lift = computeLift(runs, opts.baselineCandidateId, opts.candidateCandidateId, split)

  const failureClusters = opts.analyst
    ? await computeFailureClusters(runs, opts.analyst, split)
    : undefined

  const failureModes = computeFailureModes(runs)

  const contamination = opts.canaryScenarios
    ? computeContamination(runs, opts.canaryScenarios)
    : undefined

  const outcomeCorrelation = opts.outcomeSignal
    ? computeOutcomeCorrelation(runs, opts.outcomeSignal, split)
    : undefined

  const release = buildReleaseScorecard(composite, lift, contamination)

  const priorPeriodComparison = opts.baselineRuns
    ? computePriorPeriodComparison(runs, opts.baselineRuns, split, opts.baselineLabel)
    : undefined

  const recommendations = buildRecommendations({
    composite,
    judges,
    interRater,
    lift,
    failureClusters,
    failureModes,
    contamination,
    outcomeCorrelation,
    priorPeriodComparison,
    threshold,
  })

  return {
    n: runs.length,
    composite,
    perDimension,
    costQuality,
    judges,
    interRater,
    lift,
    failureClusters,
    contamination,
    outcomeCorrelation,
    release,
    ...(failureModes ? { failureModes } : {}),
    ...(priorPeriodComparison ? { priorPeriodComparison } : {}),
    recommendations,
  }
}

/** Model-free failure tally. Keys on the canonical cross-agent
 *  `failureClass` when present, falling back to the free-form `failureMode`
 *  for un-migrated producers — so the cross-fleet vocabulary is used the
 *  moment a producer adopts it, without breaking legacy corpora. Returns
 *  undefined when no run carries either tag. */
/** Explain a zero-valued cost axis by its root cause, not just "no signal".
 *  Two distinct causes blank the axis and need opposite fixes:
 *    - stub-mode (tokenUsage 0/0): the backend never reported real LLM
 *      activity, so cost is unknowable — the fix is upstream (capture usage).
 *    - uncosted (output>0 but costUsd 0): tokens flowed but the model id was
 *      unpriced — the fix is pricing (isModelPriced / resolveModelPricing).
 *  Reuses the backend-integrity summary so the diagnosis stays in lockstep
 *  with the stub/uncosted detectors that gate canonical runs. */
function diagnoseZeroCost(runs: RunRecord[]): string {
  const integrity = summarizeBackendIntegrity(runs)
  const { totalRecords, stubRecords, uncostedRecords } = integrity
  if (totalRecords > 0 && stubRecords === totalRecords) {
    return `no costUsd values recorded — all ${totalRecords} records are stub-mode (zero token usage). The backend never reported real LLM activity, so cost cannot be computed; verify the backend actually ran before trusting this corpus.`
  }
  if (uncostedRecords > 0) {
    return `no costUsd values recorded — ${uncostedRecords}/${totalRecords} records have token usage but $0 cost (unpriced model). Check isModelPriced(model) for the run's model id and add it to FAMILY_PRICING.`
  }
  if (stubRecords > 0) {
    return `no costUsd values recorded — ${stubRecords}/${totalRecords} records are stub-mode (zero token usage); the remainder reported neither tokens nor cost. Cost axis carries no signal.`
  }
  return 'no costUsd values recorded — cost axis carries no signal'
}

function computeFailureModes(runs: RunRecord[]): FailureModeTally[] | undefined {
  const counts = new Map<string, number>()
  for (const r of runs) {
    const key = r.failureClass ?? r.failureMode
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  const n = runs.length
  return [...counts.entries()]
    .map(([mode, count]) => ({ mode, count, share: n > 0 ? count / n : 0 }))
    .sort((a, b) => b.count - a.count || a.mode.localeCompare(b.mode))
}

// ── Prior-period comparison ─────────────────────────────────────────

/** Direction of the metric — does "higher current" mean better or worse?
 *  Composite + judge dimensions: higher is better. Cost + duration: lower
 *  is better. The recommendations engine flips the sign before judging
 *  regressed vs improved. */
type MetricDirection = 'higher-is-better' | 'lower-is-better'

function computePriorPeriodComparison(
  current: RunRecord[],
  baseline: RunRecord[],
  split: 'search' | 'holdout',
  windowLabel: string | undefined,
): PriorPeriodComparison | undefined {
  if (current.length === 0 || baseline.length === 0) return undefined

  const metrics: Record<string, MetricDelta> = {}
  const directions: Record<string, MetricDirection> = {}

  const compositeCurrent = current
    .map((r) => compositeOf(r, split))
    .filter(Number.isFinite) as number[]
  const compositeBaseline = baseline
    .map((r) => compositeOf(r, split))
    .filter(Number.isFinite) as number[]
  if (compositeCurrent.length > 0 && compositeBaseline.length > 0) {
    metrics.composite = welchCompare(compositeBaseline, compositeCurrent)
    directions.composite = 'higher-is-better'
  }

  const costCurrent = current.map((r) => r.costUsd).filter(Number.isFinite)
  const costBaseline = baseline.map((r) => r.costUsd).filter(Number.isFinite)
  if (costCurrent.length > 0 && costBaseline.length > 0) {
    metrics.cost = welchCompare(costBaseline, costCurrent)
    directions.cost = 'lower-is-better'
  }

  const durCurrent = current.map((r) => r.wallMs).filter(Number.isFinite)
  const durBaseline = baseline.map((r) => r.wallMs).filter(Number.isFinite)
  if (durCurrent.length > 0 && durBaseline.length > 0) {
    metrics.duration = welchCompare(durBaseline, durCurrent)
    directions.duration = 'lower-is-better'
  }

  const tokCurrent = current
    .map((r) => (r.tokenUsage.input ?? 0) + (r.tokenUsage.output ?? 0))
    .filter(Number.isFinite)
  const tokBaseline = baseline
    .map((r) => (r.tokenUsage.input ?? 0) + (r.tokenUsage.output ?? 0))
    .filter(Number.isFinite)
  if (tokCurrent.length > 0 && tokBaseline.length > 0) {
    metrics.tokenUsage = welchCompare(tokBaseline, tokCurrent)
    directions.tokenUsage = 'lower-is-better'
  }

  // Per-dimension judge comparisons — only for dimensions present in BOTH
  // windows. We use perDimMean since per-judge nesting is finicky for
  // two-sample comparisons across different judge configurations.
  const dimsCurrent = collectPerDimension(current)
  const dimsBaseline = collectPerDimension(baseline)
  for (const dim of Object.keys(dimsCurrent)) {
    const b = dimsBaseline[dim]
    const c = dimsCurrent[dim]
    if (!b || b.length === 0 || !c || c.length === 0) continue
    metrics[`dim.${dim}`] = welchCompare(b, c)
    directions[`dim.${dim}`] = 'higher-is-better'
  }

  const regressedMetrics: string[] = []
  const improvedMetrics: string[] = []
  for (const [name, delta] of Object.entries(metrics)) {
    if (!delta.significant) continue
    const dir = directions[name] ?? 'higher-is-better'
    const better = dir === 'higher-is-better' ? delta.delta > 0 : delta.delta < 0
    if (better) improvedMetrics.push(name)
    else regressedMetrics.push(name)
  }

  return {
    baselineN: baseline.length,
    currentN: current.length,
    ...(windowLabel ? { windowLabel } : {}),
    metrics,
    regressedMetrics,
    improvedMetrics,
  }
}

/** Collect per-dimension values across runs (from outcome.judgeScores.perDimMean). */
function collectPerDimension(runs: RunRecord[]): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const r of runs) {
    const perDim = r.outcome.judgeScores?.perDimMean
    if (!perDim) continue
    for (const [dim, value] of Object.entries(perDim)) {
      if (!Number.isFinite(value)) continue
      if (!out[dim]) out[dim] = []
      out[dim].push(value as number)
    }
  }
  return out
}

/** Two-sample Welch comparison: unequal-variance t-test + CI on the delta
 *  + Cohen's d (pooled stddev). Significance = p < 0.05 AND |d| >= 0.2. */
function welchCompare(baseline: number[], current: number[]): MetricDelta {
  const baselineMean = mean(baseline)
  const currentMean = mean(current)
  const baselineVar = sampleVariance(baseline, baselineMean)
  const currentVar = sampleVariance(current, currentMean)
  const baselineN = baseline.length
  const currentN = current.length
  const delta = currentMean - baselineMean

  // Welch standard error
  const se = Math.sqrt(baselineVar / baselineN + currentVar / currentN)
  // For 95% CI we use z=1.96 (large-n approximation). Customers running
  // analyzeRuns will typically have n >= 30; the t-correction is
  // negligible vs the practical noise floor.
  const halfWidth = 1.96 * (se > 0 ? se : 0)
  const ci95: [number, number] = [delta - halfWidth, delta + halfWidth]

  // p-value via normal approximation to the t-statistic.
  const t = se > 0 ? delta / se : 0
  const pValue = se > 0 ? 2 * (1 - standardNormalCdf(Math.abs(t))) : 1

  // Cohen's d — pooled stddev.
  const pooledStddev = Math.sqrt(
    ((baselineN - 1) * baselineVar + (currentN - 1) * currentVar) /
      Math.max(1, baselineN + currentN - 2),
  )
  const cohensD = pooledStddev > 0 ? delta / pooledStddev : 0

  // Significance: BOTH p < 0.05 AND |d| >= 0.2 (small-effect threshold).
  const significant = pValue < 0.05 && Math.abs(cohensD) >= 0.2

  return {
    current: currentMean,
    baseline: baselineMean,
    delta,
    ci95,
    pValue,
    cohensD,
    baselineN,
    currentN,
    significant,
  }
}

function sampleVariance(xs: number[], xsMean: number): number {
  if (xs.length < 2) return 0
  let s = 0
  for (const x of xs) s += (x - xsMean) ** 2
  return s / (xs.length - 1)
}

/** Abramowitz & Stegun approximation to Φ(z). Maximum error ~7.5e-8. */
function standardNormalCdf(z: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + p * x)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

// ── Composite + split selection ─────────────────────────────────────

function resolveSplit(
  runs: RunRecord[],
  pref: 'search' | 'holdout' | 'auto',
): 'search' | 'holdout' {
  if (pref !== 'auto') return pref
  const hasHoldout = runs.some((r) => Number.isFinite(r.outcome.holdoutScore))
  return hasHoldout ? 'holdout' : 'search'
}

function compositeOf(run: RunRecord, split: 'search' | 'holdout'): number {
  const primary = split === 'holdout' ? run.outcome.holdoutScore : run.outcome.searchScore
  if (Number.isFinite(primary)) return primary as number
  // Fall through to the other split if the preferred one is missing —
  // analyzeRuns shouldn't refuse to summarise a run just because the
  // caller asked for the split that wasn't recorded.
  const alt = split === 'holdout' ? run.outcome.searchScore : run.outcome.holdoutScore
  return Number.isFinite(alt) ? (alt as number) : Number.NaN
}

// ── Distribution helpers ────────────────────────────────────────────

function distributionOf(
  values: number[],
  bins: number,
  withIds?: Array<{ runId: string; score: number }>,
): ScalarDistribution {
  if (values.length === 0) {
    return {
      n: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      stddev: 0,
      min: 0,
      max: 0,
      histogram: [],
    }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, v) => s + v, 0) / n
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)
  const tailRuns = withIds
    ? [...withIds].sort((a, b) => a.score - b.score).slice(0, Math.min(5, withIds.length))
    : undefined
  return {
    n,
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    stddev,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    histogram: histogram(sorted, bins),
    ...(tailRuns ? { tailRuns } : {}),
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const idx = (sorted.length - 1) * q
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  const w = idx - lo
  return sorted[lo]! * (1 - w) + sorted[hi]! * w
}

/** Even-width histogram over the value range. Returns inclusive-lo /
 *  exclusive-hi bins (closed on right for the last bin) compatible with
 *  the substrate's `GainDistributionBin` shape. */
function histogram(sorted: number[], bins: number): ScalarDistribution['histogram'] {
  if (sorted.length === 0 || bins < 1) return []
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!
  if (min === max) return [{ lo: min, hi: max, count: sorted.length }]
  const width = (max - min) / bins
  const out: ScalarDistribution['histogram'] = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * width
    const hi = i === bins - 1 ? max : lo + width
    out.push({ lo, hi, count: 0 })
  }
  for (const v of sorted) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / width))
    out[idx]!.count++
  }
  return out
}

function computePerDimension(runs: RunRecord[], bins: number): Record<string, ScalarDistribution> {
  // JudgeScoresRecord pre-aggregates `perDimMean` (mean across judges per
  // dimension). We collect those means across runs to produce a per-dim
  // distribution at the corpus level. Consumers who want per-judge
  // dimension values reach into `perJudge[judgeId][dim]` themselves.
  const byDim = new Map<string, number[]>()
  for (const run of runs) {
    const scores = run.outcome.judgeScores
    if (!scores) continue
    for (const [dim, value] of Object.entries(scores.perDimMean ?? {})) {
      if (!Number.isFinite(value)) continue
      const arr = byDim.get(dim) ?? []
      arr.push(value)
      byDim.set(dim, arr)
    }
  }
  const out: Record<string, ScalarDistribution> = {}
  for (const [dim, values] of byDim) out[dim] = distributionOf(values, bins)
  return out
}

// ── Judge insights ──────────────────────────────────────────────────

function computeJudgeInsights(runs: RunRecord[]): Record<string, JudgeInsight> {
  // Each judge's per-run mean is the average of its per-dimension scores
  // for that run. We aggregate those means across all runs each judge
  // scored — giving consumers a "this judge's typical verdict" reading.
  const out: Record<string, JudgeInsight> = {}
  const byJudge = new Map<string, number[]>()
  for (const run of runs) {
    const scores = run.outcome.judgeScores
    if (!scores?.perJudge) continue
    for (const [judgeId, dims] of Object.entries(scores.perJudge)) {
      const dimValues = Object.values(dims).filter(Number.isFinite) as number[]
      if (dimValues.length === 0) continue
      const judgeMean = dimValues.reduce((s, v) => s + v, 0) / dimValues.length
      const arr = byJudge.get(judgeId) ?? []
      arr.push(judgeMean)
      byJudge.set(judgeId, arr)
    }
  }
  for (const [judgeId, values] of byJudge) {
    out[judgeId] = {
      n: values.length,
      meanScore: values.reduce((s, v) => s + v, 0) / values.length,
    }
  }
  return out
}

// ── Inter-rater agreement ───────────────────────────────────────────

function computeInterRater(
  ratings: Array<{ runId: string; rater: string; score: number }>,
): InterRaterInsight | undefined {
  const byRun = new Map<string, Array<{ rater: string; score: number }>>()
  for (const r of ratings) {
    if (!Number.isFinite(r.score)) continue
    const list = byRun.get(r.runId) ?? []
    list.push({ rater: r.rater, score: r.score })
    byRun.set(r.runId, list)
  }
  const raters = new Set(ratings.map((r) => r.rater))
  const jointlyRated: string[] = []
  for (const [runId, ratersForRun] of byRun) {
    const seen = new Set(ratersForRun.map((r) => r.rater))
    let all = true
    for (const r of raters) if (!seen.has(r)) all = false
    if (all) jointlyRated.push(runId)
  }
  if (raters.size < 2 || jointlyRated.length === 0) return undefined

  const raterList = [...raters].sort()
  const perPair: Record<string, number> = {}
  for (let i = 0; i < raterList.length; i++) {
    for (let j = i + 1; j < raterList.length; j++) {
      const a = raterList[i]!
      const b = raterList[j]!
      const aScores: number[] = []
      const bScores: number[] = []
      for (const runId of jointlyRated) {
        const ratersForRun = byRun.get(runId)!
        const sa = ratersForRun.find((r) => r.rater === a)?.score
        const sb = ratersForRun.find((r) => r.rater === b)?.score
        if (sa !== undefined && sb !== undefined) {
          aScores.push(sa)
          bScores.push(sb)
        }
      }
      perPair[`${a}::${b}`] = pearson(aScores, bScores)
    }
  }
  const pairKappas = Object.values(perPair)
  const kappa =
    pairKappas.length === 0 ? 0 : pairKappas.reduce((s, v) => s + v, 0) / pairKappas.length

  const disagreementCases = jointlyRated
    .map((runId) => {
      const ratersForRun = byRun.get(runId)!
      const scores = ratersForRun.map((r) => r.score)
      const range = Math.max(...scores) - Math.min(...scores)
      return { runId, ratings: ratersForRun, range }
    })
    .sort((a, b) => b.range - a.range)
    .slice(0, 20)

  return {
    raters: raters.size,
    jointlyRated: jointlyRated.length,
    kappa,
    perPair,
    disagreementCases,
  }
}

function pearson(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  const n = a.length
  const meanA = a.reduce((s, v) => s + v, 0) / n
  const meanB = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let denomA = 0
  let denomB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA
    const db = b[i]! - meanB
    num += da * db
    denomA += da * da
    denomB += db * db
  }
  const denom = Math.sqrt(denomA * denomB)
  return denom === 0 ? 0 : num / denom
}

// ── Lift ────────────────────────────────────────────────────────────

function computeLift(
  runs: RunRecord[],
  baselineId: string | undefined,
  candidateId: string | undefined,
  split: 'search' | 'holdout',
): LiftInsight | undefined {
  let bId = baselineId
  let cId = candidateId
  if (!bId || !cId) {
    // Auto-detect: when exactly two distinct candidateIds appear, treat the
    // lower-mean side as baseline.
    const ids = [...new Set(runs.map((r) => r.candidateId))]
    if (ids.length !== 2) return undefined
    const [idA, idB] = ids as [string, string]
    const meanA = mean(runs.filter((r) => r.candidateId === idA).map((r) => compositeOf(r, split)))
    const meanB = mean(runs.filter((r) => r.candidateId === idB).map((r) => compositeOf(r, split)))
    bId = meanA <= meanB ? idA : idB
    cId = meanA <= meanB ? idB : idA
  }

  const baseline = runs.filter((r) => r.candidateId === bId)
  const candidate = runs.filter((r) => r.candidateId === cId)
  if (baseline.length === 0 || candidate.length === 0) return undefined

  // Pair on (experimentId, seed). When that key doesn't match, fall back
  // to ordinal pairing — common for fresh runs from the same scenario list.
  const baselineByKey = new Map(baseline.map((r) => [pairingKey(r), r]))
  const pairedBaseline: number[] = []
  const pairedCandidate: number[] = []
  let usedKeyPairing = false
  for (const cand of candidate) {
    const b = baselineByKey.get(pairingKey(cand))
    if (b) {
      const bC = compositeOf(b, split)
      const cC = compositeOf(cand, split)
      if (Number.isFinite(bC) && Number.isFinite(cC)) {
        pairedBaseline.push(bC)
        pairedCandidate.push(cC)
        usedKeyPairing = true
      }
    }
  }
  if (!usedKeyPairing) {
    const n = Math.min(baseline.length, candidate.length)
    for (let i = 0; i < n; i++) {
      const bC = compositeOf(baseline[i]!, split)
      const cC = compositeOf(candidate[i]!, split)
      if (Number.isFinite(bC) && Number.isFinite(cC)) {
        pairedBaseline.push(bC)
        pairedCandidate.push(cC)
      }
    }
  }
  if (pairedBaseline.length === 0) return undefined

  const baselineMean = mean(pairedBaseline)
  const candidateMean = mean(pairedCandidate)
  const delta = candidateMean - baselineMean

  const bootstrap = pairedBootstrap(pairedBaseline, pairedCandidate, {
    confidence: 0.95,
    resamples: 2000,
    statistic: 'mean',
  })
  const tTest = pairedTTest(pairedBaseline, pairedCandidate)
  const d = cohensD(pairedBaseline, pairedCandidate)
  const mde = pairedMde({ nPaired: pairedBaseline.length, power: 0.8, alpha: 0.05 })
  const requiredN = requiredSampleSize({
    effect: Math.max(Math.abs(delta), 1e-6),
    power: 0.8,
    alpha: 0.05,
  })

  return {
    baselineMean,
    candidateMean,
    delta,
    ci95: [bootstrap.low, bootstrap.high],
    pValue: tTest.p,
    n: pairedBaseline.length,
    cohensD: d,
    mde,
    requiredN,
  }
}

function pairingKey(r: RunRecord): string {
  return `${r.experimentId}::${r.seed}`
}

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length
}

// ── Failure clustering ──────────────────────────────────────────────

async function computeFailureClusters(
  runs: RunRecord[],
  analyst: AnalystRegistry,
  split: 'search' | 'holdout',
): Promise<FailureClusterInsight | undefined> {
  const failed = runs.filter((r) => compositeOf(r, split) < 0.5 || r.failureMode !== undefined)
  if (failed.length === 0) return { clusters: [], totalFailures: 0 }

  const clusters = new Map<string, { exemplars: string[]; share: number }>()
  for (const run of failed) {
    try {
      // AnalystRunInputs routes by field name: run-record analysts read
      // `runRecord`. Any other shape makes every analyst skip with
      // "missing input" and the clusters come back silently empty.
      const result = await analyst.run(run.runId, { runRecord: run })
      for (const finding of result.findings as AnalystFinding[]) {
        const key = finding.area || finding.analyst_id || 'unclassified'
        const c = clusters.get(key) ?? { exemplars: [], share: 0 }
        if (c.exemplars.length < 5) c.exemplars.push(run.runId)
        clusters.set(key, c)
      }
    } catch {
      const c = clusters.get('analyst-error') ?? { exemplars: [], share: 0 }
      if (c.exemplars.length < 5) c.exemplars.push(run.runId)
      clusters.set('analyst-error', c)
    }
  }
  const clusterList = [...clusters.entries()].map(([id, c]) => ({
    id,
    name: id,
    share: c.exemplars.length / failed.length,
    exemplars: c.exemplars,
  }))
  clusterList.sort((a, b) => b.share - a.share)
  return { clusters: clusterList, totalFailures: failed.length }
}

// ── Contamination ──────────────────────────────────────────────────

function computeContamination(
  runs: RunRecord[],
  canaries: DatasetScenario[],
): InsightReport['contamination'] {
  let leaks = 0
  const details: Array<{ runId: string; canary: string; matched: string }> = []
  for (const run of runs) {
    const output = stringifyOutput(run)
    if (!output) continue
    const leaksHere = checkCanaries(output, canaries)
    for (const leak of leaksHere) {
      leaks++
      details.push({ runId: run.runId, canary: leak.canary, matched: leak.evidence })
    }
  }
  return { leaks, holdoutAuditPassed: leaks === 0, details }
}

function stringifyOutput(run: RunRecord): string | undefined {
  // RunRecord doesn't fix where "the agent's output" lives — different
  // consumers stash it differently. We probe the common shapes: the
  // outcome.raw map (numeric only by design — unlikely to contain text),
  // and any string-valued fields tucked under metadata via type casting.
  // Consumers with bespoke shapes pass canaryScenarios only when they
  // know their runs carry a stringifiable surface.
  const metadata = (run as unknown as { metadata?: Record<string, unknown> }).metadata
  if (typeof metadata?.output === 'string') return metadata.output
  if (typeof metadata?.text === 'string') return metadata.text
  return undefined
}

// ── Outcome correlation + linear reward model ──────────────────────

function computeOutcomeCorrelation(
  runs: RunRecord[],
  outcome: { metric: string; valueByRunId: Record<string, number> },
  split: 'search' | 'holdout',
): OutcomeCorrelationInsight | undefined {
  const xs: number[] = []
  const ys: number[] = []
  for (const run of runs) {
    const y = outcome.valueByRunId[run.runId]
    if (y === undefined || !Number.isFinite(y)) continue
    const x = compositeOf(run, split)
    if (!Number.isFinite(x)) continue
    xs.push(x)
    ys.push(y)
  }
  if (xs.length < 3) return undefined

  const p = pearson(xs, ys)
  const s = spearman(xs, ys)
  const meanX = mean(xs)
  const meanY = mean(ys)
  let num = 0
  let denom = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY)
    denom += (xs[i]! - meanX) ** 2
  }
  const slope = denom === 0 ? 0 : num / denom
  const intercept = meanY - slope * meanX
  const ssTot = ys.reduce((a, y) => a + (y - meanY) ** 2, 0)
  const ssRes = ys.reduce((a, y, i) => a + (y - (intercept + slope * xs[i]!)) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot

  return {
    metric: outcome.metric,
    n: xs.length,
    pearson: p,
    spearman: s,
    rewardModel: { intercept, slope, r2 },
  }
}

function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  return pearson(rank(a), rank(b))
}

function rank(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }))
  indexed.sort((x, y) => x.v - y.v)
  const ranks = new Array(arr.length).fill(0)
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++
    const avg = (i + j + 2) / 2
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avg
    i = j + 1
  }
  return ranks
}

// ── Release confidence scorecard ───────────────────────────────────

function buildReleaseScorecard(
  composite: ScalarDistribution,
  lift: LiftInsight | undefined,
  contamination: InsightReport['contamination'],
): InsightReport['release'] {
  // Synthesise a minimal scorecard from the rolled-up signal. The
  // substrate's `evaluateReleaseConfidence` primitive consumes a richer
  // input shape that callers can produce by wiring SLO definitions; the
  // shape here is the contract `selfImprove`/`analyzeRuns` consumers
  // receive automatically. They can call `evaluateReleaseConfidence`
  // directly when they want SLO-based axis evaluation.
  const axes: InsightReport['release']['axes'] = []
  const liftPass =
    lift === undefined || lift.ci95[0] > 0
      ? ('pass' as const)
      : lift.delta > 0
        ? ('warn' as const)
        : ('fail' as const)
  axes.push({
    name: 'quality-lift',
    status: liftPass,
    detail: lift
      ? `delta=${lift.delta.toFixed(3)}, CI95=[${lift.ci95[0].toFixed(3)}, ${lift.ci95[1].toFixed(3)}], n=${lift.n}`
      : 'no baseline/candidate pair available',
  })
  const contamPass =
    contamination === undefined || contamination.leaks === 0 ? ('pass' as const) : ('fail' as const)
  axes.push({
    name: 'contamination',
    status: contamPass,
    detail: contamination ? `${contamination.leaks} canary leak(s)` : 'no canaries supplied',
  })
  axes.push({
    name: 'composite-distribution',
    status: composite.mean >= 0.5 ? 'pass' : composite.mean >= 0.3 ? 'warn' : 'fail',
    detail: `mean=${composite.mean.toFixed(3)}, p50=${composite.p50.toFixed(3)}, p95=${composite.p95.toFixed(3)} over n=${composite.n}`,
  })
  const status = axes.some((a) => a.status === 'fail')
    ? 'fail'
    : axes.some((a) => a.status === 'warn')
      ? 'warn'
      : 'pass'
  return {
    status,
    axes,
    issues: [],
  }
}

// ── Recommendations engine ─────────────────────────────────────────

interface RecommendationContext {
  composite: ScalarDistribution
  judges: Record<string, JudgeInsight>
  interRater?: InterRaterInsight
  lift?: LiftInsight
  failureClusters?: FailureClusterInsight
  failureModes?: FailureModeTally[]
  contamination?: InsightReport['contamination']
  outcomeCorrelation?: OutcomeCorrelationInsight
  priorPeriodComparison?: PriorPeriodComparison
  threshold: number
}

function buildRecommendations(ctx: RecommendationContext): Recommendation[] {
  const out: Recommendation[] = []

  // Prior-period regressions — highest customer-impact signal when present.
  // "Did my last change help?" with a falsifiable answer.
  if (ctx.priorPeriodComparison) {
    const ppc = ctx.priorPeriodComparison
    const label = ppc.windowLabel ?? 'baseline period'
    for (const name of ppc.regressedMetrics) {
      const d = ppc.metrics[name]
      if (!d) continue
      out.push({
        priority: 'critical',
        kind: 'investigate',
        title: `${name} regressed from ${d.baseline.toFixed(3)} → ${d.current.toFixed(3)} vs ${label}`,
        detail: `Welch CI95 = [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}], p=${d.pValue.toFixed(4)}, Cohen's d=${d.cohensD.toFixed(2)} (n_current=${d.currentN}, n_baseline=${d.baselineN}). The regression is statistically significant at p<0.05 with at-least-small effect size.`,
        evidencePath: `priorPeriodComparison.metrics.${name}`,
      })
    }
    for (const name of ppc.improvedMetrics) {
      const d = ppc.metrics[name]
      if (!d) continue
      out.push({
        priority: 'low',
        kind: 'ship',
        title: `${name} improved from ${d.baseline.toFixed(3)} → ${d.current.toFixed(3)} vs ${label}`,
        detail: `Welch CI95 = [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}], p=${d.pValue.toFixed(4)}, Cohen's d=${d.cohensD.toFixed(2)} (n_current=${d.currentN}, n_baseline=${d.baselineN}). Statistically significant improvement worth flagging.`,
        evidencePath: `priorPeriodComparison.metrics.${name}`,
      })
    }
  }

  // Composite-distribution branch. Fires when the overall quality signal is
  // poor regardless of lift / contamination / clusters — the customer needs
  // to know they have a problem AND which specific runs to inspect.
  if (ctx.composite.n > 0) {
    if (ctx.composite.mean < 0.3) {
      const tail = ctx.composite.tailRuns ?? []
      const names = tail
        .slice(0, 5)
        .map((t) => `${t.runId}=${t.score.toFixed(3)}`)
        .join(', ')
      out.push({
        priority: 'critical',
        kind: 'investigate',
        title: `Composite mean ${ctx.composite.mean.toFixed(3)} is below the 0.3 floor — the agent is broken on this corpus`,
        detail:
          tail.length > 0
            ? `Worst ${tail.length} run${tail.length === 1 ? '' : 's'} to inspect first: ${names}. Histogram p50=${ctx.composite.p50.toFixed(3)}, p95=${ctx.composite.p95.toFixed(3)}.`
            : `Histogram p50=${ctx.composite.p50.toFixed(3)}, p95=${ctx.composite.p95.toFixed(3)}.`,
        evidencePath: 'composite.tailRuns',
      })
    } else if (ctx.composite.mean < 0.5) {
      const tail = ctx.composite.tailRuns ?? []
      const names = tail
        .slice(0, 3)
        .map((t) => `${t.runId}=${t.score.toFixed(3)}`)
        .join(', ')
      out.push({
        priority: 'high',
        kind: 'investigate',
        title: `Composite mean ${ctx.composite.mean.toFixed(3)} is below 0.5 — investigate the lower tail before claiming the agent is healthy`,
        detail:
          tail.length > 0
            ? `Worst ${tail.length} run${tail.length === 1 ? '' : 's'}: ${names}. Histogram p50=${ctx.composite.p50.toFixed(3)}, p95=${ctx.composite.p95.toFixed(3)}.`
            : `Histogram p50=${ctx.composite.p50.toFixed(3)}, p95=${ctx.composite.p95.toFixed(3)}.`,
        evidencePath: 'composite.tailRuns',
      })
    }
  }

  // Dominant-failure-mode branch (model-free). A healthy-looking mean can
  // hide a bimodal corpus — many perfect runs + a cluster of total failures
  // sharing one named cause. Fires off the structured `failureMode` tags the
  // harness already recorded, so a single batch with no analyst/baseline
  // still gets a "go fix this" pointer.
  if (ctx.failureModes && ctx.failureModes.length > 0) {
    const top = ctx.failureModes[0]!
    if (top.count >= 3 && top.share >= 0.15) {
      out.push({
        priority: top.share >= 0.25 ? 'high' : 'medium',
        kind: 'investigate',
        title: `'${top.mode}' is the dominant failure mode — ${top.count} runs (${(top.share * 100).toFixed(0)}% of the corpus)`,
        detail: `The mean composite can look acceptable while one named failure dominates the lower tail. ${top.count} of ${ctx.composite.n} runs failed with '${top.mode}'${ctx.failureModes.length > 1 ? ` (next: '${ctx.failureModes[1]!.mode}' ×${ctx.failureModes[1]!.count})` : ''}. Fix this cause first.`,
        evidencePath: 'failureModes',
      })
    }
  }

  // Missing-judges branch. The report can't surface per-dimension or
  // calibration signal when `outcome.judgeScores` is empty across the
  // corpus. Tell the customer how to enrich.
  if (Object.keys(ctx.judges).length === 0 && ctx.composite.n > 0) {
    out.push({
      priority: 'medium',
      kind: 'expand-corpus',
      title: 'No judge scores recorded — per-dimension + calibration insights unavailable',
      detail:
        'Records have no `outcome.judgeScores`. To unlock perDimension, judges, and calibration, attach a Judge run during your eval pass and populate `outcome.judgeScores.perJudge[judgeName][dimension] = score`. See `docs/insight-report.md` for the expected shape.',
      evidencePath: 'judges',
    })
  }

  if (ctx.lift) {
    const decisive = ctx.lift.ci95[0] > ctx.threshold
    const inconclusive = ctx.lift.ci95[0] <= ctx.threshold && ctx.lift.ci95[1] > ctx.threshold
    if (decisive) {
      out.push({
        priority: 'critical',
        kind: 'ship',
        title: `Ship — lift ${ctx.lift.delta.toFixed(3)} (95% CI ${ctx.lift.ci95[0].toFixed(3)}..${ctx.lift.ci95[1].toFixed(3)})`,
        detail: `Holdout lift exceeds threshold ${ctx.threshold} with 95% bootstrap confidence (n=${ctx.lift.n}, p=${ctx.lift.pValue.toFixed(4)}, d=${ctx.lift.cohensD.toFixed(2)}).`,
        evidencePath: 'lift',
      })
    } else if (inconclusive) {
      out.push({
        priority: 'high',
        kind: 'expand-corpus',
        title: `Inconclusive — need ~${ctx.lift.requiredN} paired runs (have ${ctx.lift.n}) at current effect size`,
        detail: `CI straddles threshold. Current MDE at 80% power is ${ctx.lift.mde.toFixed(3)}; observed delta is ${ctx.lift.delta.toFixed(3)}.`,
        evidencePath: 'lift',
      })
    } else {
      out.push({
        priority: 'critical',
        kind: 'hold',
        title: `Hold — lift CI lower bound ${ctx.lift.ci95[0].toFixed(3)} is at or below threshold ${ctx.threshold}`,
        detail: `Bootstrap CI provides no statistical evidence the candidate is better. Consider tightening the mutation or expanding the holdout.`,
        evidencePath: 'lift',
      })
    }
  }

  if (ctx.contamination && ctx.contamination.leaks > 0) {
    out.push({
      priority: 'critical',
      kind: 'fix',
      title: `${ctx.contamination.leaks} canary leak${ctx.contamination.leaks === 1 ? '' : 's'} detected`,
      detail: `Holdout integrity is compromised. The lift number is unreliable until you investigate.`,
      evidencePath: 'contamination',
    })
  }

  if (ctx.interRater && ctx.interRater.kappa < 0.5) {
    out.push({
      priority: 'high',
      kind: 'recalibrate',
      title: `Inter-rater agreement κ=${ctx.interRater.kappa.toFixed(2)} is below 0.5`,
      detail: `Raters disagree on what 'good' looks like. Top disagreement cases listed in interRater.disagreementCases — consider a triage meeting or refining the rubric.`,
      evidencePath: 'interRater',
    })
  }

  if (ctx.failureClusters && ctx.failureClusters.clusters.length > 0) {
    const top = ctx.failureClusters.clusters[0]!
    out.push({
      priority: 'high',
      kind: 'investigate',
      title: `Top failure cluster: ${top.name} (${(top.share * 100).toFixed(0)}% of failures)`,
      detail: `${ctx.failureClusters.totalFailures} runs failed. The largest cluster groups ${top.exemplars.length} exemplars under '${top.name}'.`,
      evidencePath: 'failureClusters.clusters[0]',
    })
  }

  if (ctx.outcomeCorrelation && Math.abs(ctx.outcomeCorrelation.spearman) < 0.3) {
    out.push({
      priority: 'medium',
      kind: 'recalibrate',
      title: `Judge scores decoupled from ${ctx.outcomeCorrelation.metric} (Spearman ρ=${ctx.outcomeCorrelation.spearman.toFixed(2)})`,
      detail: `Your judges score what they were trained to score, but it isn't predicting downstream ${ctx.outcomeCorrelation.metric}. Consider retraining the judge against ${ctx.outcomeCorrelation.metric} as the gold signal.`,
      evidencePath: 'outcomeCorrelation',
    })
  }

  return out
}

// ── Re-export pareto figure spec for hosted-side rendering ─────────

export type { ParetoFigureSpec }
