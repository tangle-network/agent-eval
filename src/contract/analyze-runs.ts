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
import type { DatasetScenario } from '../dataset'
import { type RunRecord, validateRunRecord } from '../run-record'
import { paretoChart } from '../summary-report'
import { computeLift, computePriorPeriodComparison } from './comparison-insight'
import { diagnoseCostCoverage, summarizeExecution } from './execution-insight'
import {
  computeContamination,
  computeFailureClasses,
  computeFailureClusters,
} from './failure-insight'
import { buildRecommendations, buildReleaseScorecard } from './insight-recommendations'
import type { InsightReport } from './insight-report'
import {
  compositeOf,
  computeInterRater,
  computeJudgeInsights,
  computeOutcomeCorrelation,
  computePerDimension,
  distributionOf,
  isFiniteNumber,
  resolveSplit,
} from './quality-insight'

export type { ParetoFigureSpec } from '../summary-report'
export type { ExecutionReport, SummarizeExecutionOptions } from './execution-insight'
export { summarizeExecution } from './execution-insight'

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
  /** Average matched run scores within these units before estimating lift.
   *  Raw run distributions and unmatched-run counts remain unchanged. */
  independentUnitByScenarioId?: ReadonlyMap<string, string>
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
  const knownCostRuns = runs.filter((run) => run.costProvenance.usd !== null)
  const costs = knownCostRuns.map((r) => r.costUsd).filter(isFiniteNumber)
  const costDist = distributionOf(costs, bins)
  const pareto = paretoChart(knownCostRuns, { split })
  const degraded: { cost?: string; pareto?: string } = {}
  if (provenance.uncaptured.n + provenance.lowerBound.n > 0) {
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

  const lift = computeLift(
    runs,
    opts.baselineCandidateId,
    opts.candidateCandidateId,
    split,
    opts.independentUnitByScenarioId,
  )

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
