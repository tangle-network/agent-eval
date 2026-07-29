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
import { welchsTTest } from '../baseline'
import { checkCanaries } from '../contamination-guard'
import type { DatasetScenario } from '../dataset'
import { continuousAgreement } from '../judge-calibration'
import { pairRunRecords } from '../paired-arms'
import { observedSplitScore } from '../rollout/reward'
import {
  type RunRecord,
  type RunTerminalOutcome,
  type RunTokenUsage,
  validateRunRecord,
} from '../run-record'
import {
  BOOTSTRAP_GATE_MIN_N,
  pairedBootstrap,
  pairedCohensDz,
  pairedMde,
  pairedTTest,
  pearsonR,
  requiredPairedSampleSize,
  spearmanR,
} from '../statistics'
import { type ParetoFigureSpec, paretoChart } from '../summary-report'
import type { FailureClass } from '../trace/schema'

import type {
  CostProvenanceSummary,
  ExecutionInsight,
  FailureClassTally,
  FailureClusterInsight,
  InsightReport,
  InterRaterInsight,
  JudgeInsight,
  LiftInsight,
  MetricDelta,
  OutcomeCorrelationInsight,
  PriorPeriodComparison,
  Recommendation,
  ScalarDistribution,
  TokenUsageInsight,
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
   *  (experimentId, scenarioId, seed) identities shared between the two sides.
   *  Unmatched rows remain visible in the lift result. */
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
   *  bootstrap on shared (experimentId, scenarioId, seed) identities; this is the
   *  shape for "this week vs last week" rather than "candidate vs
   *  baseline within a campaign"). */
  baselineRuns?: RunRecord[]
  /** Human-readable label for the baseline window, e.g. "vs prior 7
   *  days", "vs v3.1 release". Surfaces in recommendations + UI. */
  baselineLabel?: string
}

export interface SummarizeExecutionOptions {
  runs: RunRecord[]
  histogramBins?: number
}

export interface ExecutionReport {
  execution: ExecutionInsight
  costProvenance: CostProvenanceSummary
}

/** Summarize runtime facts without interpreting task quality or promotion readiness. */
export function summarizeExecution(opts: SummarizeExecutionOptions): ExecutionReport {
  const runs = opts.runs.map(validateRunRecord)
  const bins = opts.histogramBins ?? 12
  return {
    execution: computeExecutionInsight(runs, bins),
    costProvenance: summarizeCostProvenance(runs),
  }
}

/** A bootstrap interval with no spread: every resample landed on the same
 *  value, so the interval carries no information about how far the point
 *  estimate could be wrong and cannot support a directional claim. */
function zeroWidth(ci: readonly [number, number]): boolean {
  return !Number.isFinite(ci[0]) || !Number.isFinite(ci[1]) || ci[0] === ci[1]
}

export async function analyzeRuns(opts: AnalyzeRunsOptions): Promise<InsightReport> {
  const runs = opts.runs.map(validateRunRecord)
  const bins = opts.histogramBins ?? 12
  const threshold = opts.decisionThreshold ?? 0.02
  if (!Number.isFinite(threshold)) {
    throw new Error(`analyzeRuns: decisionThreshold must be finite, got ${threshold}`)
  }
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
  const { execution, costProvenance: provenance } = summarizeExecution({
    runs,
    histogramBins: bins,
  })
  const knownCostRuns = runs.filter((run) => run.costProvenance.kind !== 'uncaptured')
  const costs = knownCostRuns.map((r) => r.costUsd).filter(isFiniteNumber)
  const costDist = distributionOf(costs, bins)
  const pareto = paretoChart(knownCostRuns, { split })
  const degraded: { cost?: string; pareto?: string } = {}
  if (provenance.uncaptured.n > 0) {
    degraded.cost = diagnoseCostCoverage(runs, provenance)
  } else if (costs.length === 0 || costs.every((c) => c === 0)) {
    degraded.cost = `all ${runs.length} explicitly observed or estimated USD values are $0`
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
    provenance,
    ...(degraded.cost || degraded.pareto ? { degraded } : {}),
  }

  const judges = computeJudgeInsights(runs)

  const interRater = opts.raterScores ? computeInterRater(opts.raterScores) : undefined

  const lift = computeLift(runs, opts.baselineCandidateId, opts.candidateCandidateId, split)

  const failureClusters = opts.analyst
    ? await computeFailureClusters(runs, opts.analyst, split)
    : undefined

  const failureClasses = computeFailureClasses(runs, split)

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
    failureClasses,
    contamination,
    outcomeCorrelation,
    priorPeriodComparison,
    threshold,
  })

  return {
    n: runs.length,
    execution,
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
    ...(failureClasses ? { failureClasses } : {}),
    ...(priorPeriodComparison ? { priorPeriodComparison } : {}),
    recommendations,
  }
}

function computeExecutionInsight(runs: RunRecord[], bins: number): ExecutionInsight {
  const aggregateRows = runs.flatMap((run) => {
    const usage = aggregateTokenUsage(run)
    return usage ? [{ usage, costUsd: finiteRaw(run, 'aggregate_cost_usd') }] : []
  })
  const aggregateCosts = aggregateRows.flatMap((row) =>
    row.costUsd !== undefined ? [row.costUsd] : [],
  )
  const modelCounts = new Map<string, number>()
  let executionErrorRuns = 0
  let executionErrorEvents = 0
  let errorReportingRuns = 0
  let errorSpanEvents = 0
  let errorSpanReportingRuns = 0
  const terminalOutcomes: Record<RunTerminalOutcome, number> = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    incomplete: 0,
    unknown: 0,
  }
  const errorsByTerminalOutcome: ExecutionInsight['executionErrors']['byTerminalOutcome'] = {
    succeeded: { withErrors: 0, withoutErrors: 0, unreported: 0 },
    failed: { withErrors: 0, withoutErrors: 0, unreported: 0 },
    cancelled: { withErrors: 0, withoutErrors: 0, unreported: 0 },
    incomplete: { withErrors: 0, withoutErrors: 0, unreported: 0 },
    unknown: { withErrors: 0, withoutErrors: 0, unreported: 0 },
  }
  let modelCallRuns = 0
  let modelCallEvents = 0
  let modelCallReportingRuns = 0

  for (const run of runs) {
    modelCounts.set(run.model, (modelCounts.get(run.model) ?? 0) + 1)
    const terminalOutcome = run.terminalOutcome
    terminalOutcomes[terminalOutcome] += 1
    const modelCalls = nonNegativeCountRaw(run, 'llm_span_count')
    if (modelCalls !== undefined) {
      modelCallEvents += modelCalls
      modelCallReportingRuns += 1
    }
    const usage = run.tokenUsage
    if (
      (modelCalls ?? 0) > 0 ||
      usage.input > 0 ||
      usage.output > 0 ||
      (usage.cached ?? 0) > 0 ||
      (usage.cacheWrite ?? 0) > 0
    ) {
      modelCallRuns += 1
    }
    const errorEvents = reportedExecutionErrorEvents(run)
    if (errorEvents !== undefined) {
      executionErrorEvents += errorEvents
      errorReportingRuns += 1
      if (errorEvents > 0) {
        executionErrorRuns += 1
        errorsByTerminalOutcome[terminalOutcome].withErrors += 1
      } else errorsByTerminalOutcome[terminalOutcome].withoutErrors += 1
    } else errorsByTerminalOutcome[terminalOutcome].unreported += 1
    const reportedErrorSpans = nonNegativeCountRaw(run, 'error_span_count')
    if (reportedErrorSpans !== undefined) {
      errorSpanEvents += reportedErrorSpans
      errorSpanReportingRuns += 1
    }
  }

  return {
    durationMs: distributionOf(
      runs.map((run) => run.wallMs),
      bins,
    ),
    queueMs: distributionOf(
      runs.filter((run) => run.queueMs !== undefined).map((run) => run.queueMs!),
      bins,
    ),
    tokenUsage: summarizeTokenUsage(
      runs.map((run) => run.tokenUsage),
      bins,
    ),
    aggregateUsage: {
      runs: aggregateRows.length,
      tokenUsage: summarizeTokenUsage(
        aggregateRows.map((row) => row.usage),
        bins,
      ),
      costUsd: distributionOf(aggregateCosts, bins),
      totalCostUsd: aggregateCosts.reduce((total, value) => total + value, 0),
    },
    models: [...modelCounts.entries()]
      .map(([model, count]) => ({ model, runs: count }))
      .sort((left, right) => right.runs - left.runs || left.model.localeCompare(right.model)),
    modelCalls: {
      runs: modelCallRuns,
      events: modelCallEvents,
      reportingRuns: modelCallReportingRuns,
    },
    executionErrors: {
      runs: executionErrorRuns,
      fraction: errorReportingRuns > 0 ? executionErrorRuns / errorReportingRuns : null,
      events: executionErrorEvents,
      reportingRuns: errorReportingRuns,
      errorSpanEvents,
      errorSpanReportingRuns,
      byTerminalOutcome: errorsByTerminalOutcome,
    },
    terminalOutcomes,
  }
}

function reportedExecutionErrorEvents(run: RunRecord): number | undefined {
  return nonNegativeCountRaw(run, 'execution_error_count')
}

function nonNegativeCountRaw(run: RunRecord, key: string): number | undefined {
  const value = finiteRaw(run, key)
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined
}

function summarizeTokenUsage(usages: RunTokenUsage[], bins: number): TokenUsageInsight {
  const reasoning = usages.flatMap((usage) =>
    usage.reasoning !== undefined ? [usage.reasoning] : [],
  )
  const cached = usages.flatMap((usage) => (usage.cached !== undefined ? [usage.cached] : []))
  const cacheWrite = usages.flatMap((usage) =>
    usage.cacheWrite !== undefined ? [usage.cacheWrite] : [],
  )
  return {
    input: distributionOf(
      usages.map((usage) => usage.input),
      bins,
    ),
    output: distributionOf(
      usages.map((usage) => usage.output),
      bins,
    ),
    reasoning: distributionOf(reasoning, bins),
    cached: distributionOf(cached, bins),
    cacheWrite: distributionOf(cacheWrite, bins),
    totals: {
      input: usages.reduce((total, usage) => total + usage.input, 0),
      output: usages.reduce((total, usage) => total + usage.output, 0),
      reasoning: reasoning.reduce((total, value) => total + value, 0),
      cached: cached.reduce((total, value) => total + value, 0),
      cacheWrite: cacheWrite.reduce((total, value) => total + value, 0),
    },
  }
}

function aggregateTokenUsage(run: RunRecord): RunTokenUsage | undefined {
  const input = finiteRaw(run, 'aggregate_prompt_tokens')
  const output = finiteRaw(run, 'aggregate_completion_tokens')
  const reasoning = finiteRaw(run, 'aggregate_reasoning_tokens')
  const cached = finiteRaw(run, 'aggregate_cached_tokens')
  const cacheWrite = finiteRaw(run, 'aggregate_cache_write_tokens')
  if (
    input === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cached === undefined &&
    cacheWrite === undefined
  )
    return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cached !== undefined ? { cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  }
}

function finiteRaw(run: RunRecord, key: string): number | undefined {
  const value = run.outcome.raw[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function summarizeCostProvenance(runs: RunRecord[]): CostProvenanceSummary {
  const summary: CostProvenanceSummary = {
    observed: { n: 0, totalUsd: 0 },
    estimated: { n: 0, totalUsd: 0 },
    uncaptured: { n: 0 },
    knownFraction: 0,
  }
  for (const run of runs) {
    const cost = run.costProvenance
    if (cost.kind === 'uncaptured') {
      summary.uncaptured.n += 1
    } else {
      summary[cost.kind].n += 1
      summary[cost.kind].totalUsd += cost.usd
    }
  }
  const known = summary.observed.n + summary.estimated.n
  summary.knownFraction = runs.length > 0 ? known / runs.length : 0
  return summary
}

function diagnoseCostCoverage(runs: RunRecord[], provenance: CostProvenanceSummary): string {
  const uncaptured = provenance.uncaptured.n
  const known = provenance.observed.n + provenance.estimated.n
  if (uncaptured === runs.length) {
    return `USD cost uncaptured for all ${runs.length} runs — no observed or estimated USD values; token and wall-time metrics remain available.`
  }
  return `USD cost uncaptured for ${uncaptured}/${runs.length} runs; excluded those rows from cost statistics (${known}/${runs.length} retained: ${provenance.observed.n} observed, ${provenance.estimated.n} estimated).`
}

/**
 * Model-free task-failure tally.
 *
 * Explicit non-success classes are task-failure evidence.
 * A low task score without a class is counted as `unknown`.
 */
function computeFailureClasses(
  runs: RunRecord[],
  split: 'search' | 'holdout',
): FailureClassTally[] | undefined {
  const counts = new Map<FailureClass, number>()
  for (const r of runs) {
    if (!isTaskFailure(r, split)) continue
    const key =
      r.failureClass !== undefined && r.failureClass !== 'success' ? r.failureClass : 'unknown'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  const n = runs.length
  return [...counts.entries()]
    .map(([failureClass, count]) => ({
      failureClass,
      count,
      share: n > 0 ? count / n : 0,
    }))
    .sort((a, b) => b.count - a.count || a.failureClass.localeCompare(b.failureClass))
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

  const costCurrent = knownCostValues(current)
  const costBaseline = knownCostValues(baseline)
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
  const inconclusiveMetrics: string[] = []
  for (const [name, delta] of Object.entries(metrics)) {
    if (delta.status !== 'ok') {
      inconclusiveMetrics.push(name)
      continue
    }
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
    inconclusiveMetrics,
  }
}

function knownCostValues(runs: RunRecord[]): number[] {
  return runs
    .filter((run) => run.costProvenance.kind !== 'uncaptured')
    .map((run) => run.costUsd)
    .filter(isFiniteNumber)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
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

/** Adapt the shared two-sample Welch result to the report contract. */
function welchCompare(baseline: number[], current: number[]): MetricDelta {
  const result = welchsTTest(baseline, current)
  const base = {
    current: result.meanB,
    baseline: result.meanA,
    delta: result.delta,
    baselineN: baseline.length,
    currentN: current.length,
  }
  if (result.status !== 'ok') {
    return {
      ...base,
      status: result.status,
      ci95: null,
      pValue: null,
      cohensD: null,
      significant: false,
    }
  }
  return {
    ...base,
    status: 'ok',
    ci95: result.ci95,
    pValue: result.p,
    cohensD: result.cohensD,
    significant: result.p < 0.05 && Math.abs(result.cohensD) >= 0.2,
  }
}

// ── Composite + split selection ─────────────────────────────────────

function resolveSplit(
  runs: RunRecord[],
  pref: 'search' | 'holdout' | 'auto',
): 'search' | 'holdout' {
  if (pref !== 'auto') return pref
  const hasHoldout = runs.some((r) => Number.isFinite(observedSplitScore(r, 'holdout')))
  return hasHoldout ? 'holdout' : 'search'
}

/**
 * RAW (`observedSplitScore`): `analyzeRuns` describes what a set of runs
 * reported, and every downstream reader of this composite — distributions,
 * per-candidate summaries, the reward-hacking correlation — needs the ungated
 * number to see an inflated run at all.
 */
function compositeOf(run: RunRecord, split: 'search' | 'holdout'): number {
  // Split-exact, no cross-split fallthrough: answering "what did this run
  // score on the split I am summarising" with the other split's number
  // silently mixes populations.
  const score = observedSplitScore(run, split)
  return Number.isFinite(score) ? (score as number) : Number.NaN
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
      mean: null,
      p50: null,
      p95: null,
      stddev: null,
      min: null,
      max: null,
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
      const agreement = continuousAgreement(
        aScores.map((score, index) => [score, bScores[index]!]),
        { bootstrap: 0 },
      )
      perPair[`${a}::${b}`] = agreement.weightedKappa
    }
  }
  const matrix = jointlyRated.map((runId) => {
    const ratingsByRater = new Map(byRun.get(runId)!.map((rating) => [rating.rater, rating.score]))
    return raterList.map((rater) => ratingsByRater.get(rater)!)
  })
  const agreement = continuousAgreement(matrix, { bootstrap: 0 })

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
    kappa: Number.isFinite(agreement.weightedKappa) ? agreement.weightedKappa : 0,
    icc: agreement.icc,
    pearson: agreement.pearson,
    spearman: agreement.spearman,
    perPair,
    disagreementCases,
  }
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
    const scoresA = finiteCompositeScores(
      runs.filter((run) => run.candidateId === idA),
      split,
    )
    const scoresB = finiteCompositeScores(
      runs.filter((run) => run.candidateId === idB),
      split,
    )
    if (scoresA.length === 0 || scoresB.length === 0) return undefined
    const meanA = mean(scoresA)
    const meanB = mean(scoresB)
    bId = meanA <= meanB ? idA : idB
    cId = meanA <= meanB ? idB : idA
  }

  const baseline = runs.filter((r) => r.candidateId === bId)
  const candidate = runs.filter((r) => r.candidateId === cId)
  if (baseline.length === 0 || candidate.length === 0) return undefined

  const scoredBaseline = baseline.filter((run) => Number.isFinite(compositeOf(run, split)))
  const scoredCandidate = candidate.filter((run) => Number.isFinite(compositeOf(run, split)))
  const pairing = pairRunRecords(scoredBaseline, scoredCandidate)
  const pairedBaseline = pairing.pairs.map((pair) => compositeOf(pair.baseline, split))
  const pairedCandidate = pairing.pairs.map((pair) => compositeOf(pair.treatment, split))
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
  const d = pairedCohensDz(pairedBaseline, pairedCandidate)
  const mde = pairedMde({ nPaired: pairedBaseline.length, power: 0.8, alpha: 0.05 })
  const requiredN =
    d === null || d === 0
      ? null
      : requiredPairedSampleSize({
          effect: Math.abs(d),
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
    minimumRequired: BOOTSTRAP_GATE_MIN_N,
    decisionEligible: bootstrap.gateEligible,
    unpairedBaseline: pairing.unpairedBaseline.length,
    unpairedCandidate: pairing.unpairedTreatment.length,
    cohensD: d,
    mde,
    requiredN,
  }
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
  const failed = runs.filter((run) => isTaskFailure(run, split))
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

function finiteCompositeScores(runs: readonly RunRecord[], split: 'search' | 'holdout'): number[] {
  return runs.map((run) => compositeOf(run, split)).filter(Number.isFinite)
}

function isTaskFailure(run: RunRecord, split: 'search' | 'holdout'): boolean {
  if (run.failureClass !== undefined && run.failureClass !== 'success') return true
  const score = compositeOf(run, split)
  return Number.isFinite(score) && score < 0.5
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

  const p = pearsonR(xs, ys)
  const s = spearmanR(xs, ys)
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
    lift === undefined
      ? ('not_evaluated' as const)
      : !lift.decisionEligible
        ? ('not_evaluated' as const)
        : lift.ci95[0] > 0 && !zeroWidth(lift.ci95)
          ? ('pass' as const)
          : lift.delta > 0
            ? ('warn' as const)
            : ('fail' as const)
  axes.push({
    name: 'quality-lift',
    status: liftPass,
    detail: lift
      ? `delta=${lift.delta.toFixed(3)}, CI95=[${lift.ci95[0].toFixed(3)}, ${lift.ci95[1].toFixed(3)}], n=${lift.n}${lift.decisionEligible ? '' : ` (descriptive only; ${lift.minimumRequired} required)`}`
      : 'no baseline/candidate pair available',
  })
  const contamPass =
    contamination === undefined
      ? ('not_evaluated' as const)
      : contamination.leaks === 0
        ? ('pass' as const)
        : ('fail' as const)
  axes.push({
    name: 'contamination',
    status: contamPass,
    detail: contamination ? `${contamination.leaks} canary leak(s)` : 'no canaries supplied',
  })
  axes.push(
    composite.n === 0
      ? {
          name: 'composite-distribution',
          status: 'not_evaluated',
          detail: 'no task-quality scores available',
        }
      : {
          name: 'composite-distribution',
          status:
            composite.mean !== null && composite.mean >= 0.5
              ? 'pass'
              : composite.mean !== null && composite.mean >= 0.3
                ? 'warn'
                : 'fail',
          detail:
            composite.mean === null || composite.p50 === null || composite.p95 === null
              ? 'task-quality distribution is internally incomplete'
              : `mean=${composite.mean.toFixed(3)}, p50=${composite.p50.toFixed(3)}, p95=${composite.p95.toFixed(3)} over n=${composite.n}`,
        },
  )
  const status = axes.some((a) => a.status === 'fail')
    ? 'fail'
    : axes.some((a) => a.status === 'warn' || a.status === 'not_evaluated')
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
  failureClasses?: FailureClassTally[]
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
      if (d?.status !== 'ok') continue
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
      if (d?.status !== 'ok') continue
      out.push({
        priority: 'low',
        kind: 'ship',
        title: `${name} improved from ${d.baseline.toFixed(3)} → ${d.current.toFixed(3)} vs ${label}`,
        detail: `Welch CI95 = [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}], p=${d.pValue.toFixed(4)}, Cohen's d=${d.cohensD.toFixed(2)} (n_current=${d.currentN}, n_baseline=${d.baselineN}). Statistically significant improvement worth flagging.`,
        evidencePath: `priorPeriodComparison.metrics.${name}`,
      })
    }
    for (const name of ppc.inconclusiveMetrics) {
      const d = ppc.metrics[name]
      if (!d || d.status === 'ok' || d.delta === 0) continue
      const reason =
        d.status === 'zero-variance'
          ? 'both periods have zero observed variance'
          : 'one or both periods have fewer than two observations'
      out.push({
        priority: 'high',
        kind: 'investigate',
        title: `${name} changed from ${d.baseline.toFixed(3)} → ${d.current.toFixed(3)} vs ${label}; inference unavailable`,
        detail: `Observed delta ${d.delta.toFixed(3)} across n_current=${d.currentN} and n_baseline=${d.baselineN}, but ${reason}. The report does not fabricate a p-value, confidence interval, or effect size; inspect independence and data capture before acting.`,
        evidencePath: `priorPeriodComparison.metrics.${name}`,
      })
    }
  }

  // Composite-distribution branch. Fires when the overall quality signal is
  // poor regardless of lift / contamination / clusters — the customer needs
  // to know they have a problem AND which specific runs to inspect.
  if (
    ctx.composite.n > 0 &&
    ctx.composite.mean !== null &&
    ctx.composite.p50 !== null &&
    ctx.composite.p95 !== null
  ) {
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

  // A healthy-looking mean can hide a group of failed tasks sharing one
  // producer-reported cause. This path does not require an analyst.
  if (ctx.failureClasses && ctx.failureClasses.length > 0) {
    const top = ctx.failureClasses[0]!
    if (top.count >= 3 && top.share >= 0.15) {
      out.push({
        priority: top.share >= 0.25 ? 'high' : 'medium',
        kind: 'investigate',
        title: `'${top.failureClass}' is the dominant failure class — ${top.count} runs (${(top.share * 100).toFixed(0)}% of the corpus)`,
        detail: `The mean composite can look acceptable while one failure class dominates the lower tail. ${top.count} of ${ctx.composite.n} runs failed with '${top.failureClass}'${ctx.failureClasses.length > 1 ? ` (next: '${ctx.failureClasses[1]!.failureClass}' ×${ctx.failureClasses[1]!.count})` : ''}. Fix this cause first.`,
        evidencePath: 'failureClasses',
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
    if (!ctx.lift.decisionEligible) {
      out.push({
        priority: 'high',
        kind: 'expand-corpus',
        title: `Inconclusive — ${ctx.lift.n} paired runs; ${ctx.lift.minimumRequired} required`,
        detail: `The bootstrap interval is descriptive below ${ctx.lift.minimumRequired} paired observations and cannot support a ship decision.`,
        evidencePath: 'lift',
      })
    } else {
      const pairedEffect =
        ctx.lift.cohensD === null ? 'undefined (zero delta variance)' : ctx.lift.cohensD.toFixed(2)
      const pairedP =
        ctx.lift.pValue === null ? 'undefined (zero delta variance)' : ctx.lift.pValue.toFixed(4)
      const requiredRuns =
        ctx.lift.requiredN === null ? 'not estimable' : `~${ctx.lift.requiredN} paired runs`
      // A ZERO-WIDTH interval never reads as "ship": n identical paired deltas
      // make every resample identical, so `[g, g]` clears any threshold below g
      // and `[0, 0]` clears any negative `decisionThreshold`, on no spread at
      // all. It falls through to the inconclusive/hold arms, which is where a
      // sample carrying no information about its own error belongs.
      const decisive = !zeroWidth(ctx.lift.ci95) && ctx.lift.ci95[0] > ctx.threshold
      const inconclusive = ctx.lift.ci95[0] <= ctx.threshold && ctx.lift.ci95[1] > ctx.threshold
      if (decisive) {
        out.push({
          priority: 'critical',
          kind: 'ship',
          title: `Ship — lift ${ctx.lift.delta.toFixed(3)} (95% CI ${ctx.lift.ci95[0].toFixed(3)}..${ctx.lift.ci95[1].toFixed(3)})`,
          detail: `Holdout lift exceeds threshold ${ctx.threshold} with 95% bootstrap confidence (n=${ctx.lift.n}, p=${pairedP}, paired d=${pairedEffect}).`,
          evidencePath: 'lift',
        })
      } else if (inconclusive) {
        out.push({
          priority: 'high',
          kind: 'expand-corpus',
          title: `Inconclusive — required sample is ${requiredRuns} (have ${ctx.lift.n}) at current effect size`,
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
      title: `Inter-rater weighted kappa ${ctx.interRater.kappa.toFixed(2)} is below 0.5`,
      detail:
        'Raters disagree on what good looks like. Review the largest disagreement cases and refine the rubric before automating these decisions.',
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
