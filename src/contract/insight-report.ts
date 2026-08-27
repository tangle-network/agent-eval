/**
 * # InsightReport — the rigorous decision packet for any set of agent runs.
 *
 * Returned by `analyzeRuns()` and embedded in `SelfImproveResult.insight` +
 * the hosted-tier `EvalRunEvent.insightReport`. One shape across two surfaces:
 *
 *   - **Customer who has a closed loop** (`selfImprove`): the report ships
 *     with the loop output. Their dashboard renders ship/hold + lift CI +
 *     calibration + cluster + Pareto in one packet.
 *   - **Customer who has observed runs but no loop** (`analyzeRuns` directly):
 *     same packet from a `RunRecord[]` they already have — production traces,
 *     approve/reject corpus, CSV gold set.
 *
 * Every field is optional except the distributional summary — fields are
 * populated when the input data supports them:
 *
 *   - `lift` requires both baseline and candidate splits to be present.
 *   - `interRater` requires multi-rater feedback (≥2 raters per run).
 *   - `judges` populates per-judge stats only when the run records carry
 *     `outcome.judgeScores`.
 *   - `failureClusters` requires the optional `analystRegistry` to be wired.
 *   - `contamination` requires canary scenarios to be passed in.
 *   - `outcomeCorrelation` requires a downstream outcome signal.
 *   - `sequential` requires the run set to be ordered (treats them as a
 *     stream and emits an anytime-valid interim decision).
 *
 * Consumers read the `recommendations` array first — that's the
 * actionable layer, ranked by priority. The numeric sections back it up.
 */

import type { GainDistributionBin, ParetoFigureSpec } from '../summary-report'
import type { ContinuousAgreement } from './insight-types-fwd'

// ── Top-level report ────────────────────────────────────────────────

export interface InsightReport {
  /** Number of runs analyzed. */
  n: number

  /** Runtime facts carried by the run records. These describe execution,
   *  not task quality: duration, queueing, token categories, models, and
   *  explicitly recorded failures. */
  execution: ExecutionInsight

  /** Composite-score distribution across all runs. Always present. */
  composite: ScalarDistribution

  /** Per-dimension distributions for every dimension that appeared in any
   *  run's judge scores. Empty when no judge scores were recorded. */
  perDimension: Record<string, ScalarDistribution>

  /** Cost/quality distribution and Pareto frontier. */
  costQuality: {
    cost: ScalarDistribution
    pareto: ParetoFigureSpec
    /** Cost source coverage. `uncaptured` rows are excluded from the USD
     *  distribution and Pareto chart; observed and estimated totals remain
     *  separate so reports never present estimates as billed spend. */
    provenance?: CostProvenanceSummary
    /** Set when the cost/quality view is degraded because the input data
     *  doesn't fully support it — e.g. all `costUsd` were zero, or only a
     *  single candidate appears (so the Pareto is a single point). The
     *  named fields name the degraded sub-view, free-text the reason. */
    degraded?: { cost?: string; pareto?: string }
  }

  /** Per-judge calibration + bias detection. Populated for every judge name
   *  that appears in `outcome.judgeScores`. Bias fields require either a
   *  gold reference or multi-rater data. */
  judges: Record<string, JudgeInsight>

  /** Inter-rater agreement when multiple judges scored the same runs.
   *  Includes pairwise kappa and the specific run ids where raters
   *  disagree — the cases worth a human meeting. */
  interRater?: InterRaterInsight

  /** Pairwise lift (baseline → candidate) with bootstrap CI. Present when
   *  `RunRecord.splitTag` includes both `holdout` and search/dev splits,
   *  or when caller passes an explicit baseline/candidate split. */
  lift?: LiftInsight

  /** Failure clusters with exemplars. Populated when an AnalystRegistry
   *  is wired in `analyzeRuns({ analyst })`. */
  failureClusters?: FailureClusterInsight

  /** Canary leak count + holdout audit status. Populated when canary
   *  scenarios are passed in. */
  contamination?: ContaminationInsight

  /** Correlation between judge composite and a downstream outcome the
   *  caller supplies (engagement, revenue, downstream pass rate, etc.).
   *  When present, the optional reward model is the model that maps
   *  judge scores → predicted outcome. */
  outcomeCorrelation?: OutcomeCorrelationInsight

  /** Aggregate release-readiness summary. A consumer needing the full
   *  substrate `ReleaseConfidenceScorecard` (SLO-axis evaluation,
   *  ActionableSideInfo bag) calls `evaluateReleaseConfidence()` directly;
   *  this summary captures the analyzeRuns-derived axes. */
  release: ReleaseSummary

  /** Delta vs a prior period when `baselineRuns` is passed. Per-metric
   *  current vs baseline with Welch CI + Cohen's d + significance flag.
   *  Answers "did my last change help?" — the customer-conversion question.
   *  Surfaced metrics: composite, cost, duration, tokenUsage, plus any
   *  per-dimension judge metric present in both windows. */
  priorPeriodComparison?: PriorPeriodComparison

  /** Model-free failure-mode breakdown from `RunRecord.failureMode`, ranked
   *  by count descending. Present when any run carries a `failureMode`.
   *  Complements `failureClusters` (LLM-semantic) with the structured tags
   *  the harness already recorded — actionable with no analyst wired. */
  failureModes?: FailureModeTally[]

  /** Top-N actionable recommendations, ranked by priority. The packet's
   *  human-readable layer; the numeric sections are the evidence. */
  recommendations: Recommendation[]
}

export interface CostProvenanceSummary {
  observed: { n: number; totalUsd: number }
  estimated: { n: number; totalUsd: number }
  uncaptured: { n: number }
  knownFraction: number
}

export interface ExecutionInsight {
  /** End-to-end wall time for every run. */
  durationMs: ScalarDistribution
  /** Queue time for the subset of runs that recorded it. */
  queueMs: ScalarDistribution
  /** Token distributions plus corpus totals. Optional token categories use
   *  distribution `n` to disclose how many runs recorded that category. */
  tokenUsage: TokenUsageInsight
  /** Usage reported only by orchestration or agent aggregate spans.
   *  Kept separate because it may duplicate model-call telemetry in other traces. */
  aggregateUsage: {
    runs: number
    tokenUsage: TokenUsageInsight
    costUsd: ScalarDistribution
    totalCostUsd: number
  }
  /** Stable model counts, largest cohort first. */
  models: Array<{ model: string; runs: number }>
  /** Model-call coverage. `events` is available only from producers that
   *  record `outcome.raw.llm_span_count`; `runs` also recognizes non-zero
   *  token usage from other producers. */
  modelCalls: {
    runs: number
    events: number
    reportingRuns: number
  }
  /** Failure counts remain separate from outcome scores. `reportedErrorEvents`
   *  sums `outcome.raw.error_span_count` only where a producer supplied it. */
  failures: {
    runs: number
    fraction: number
    reportedErrorEvents: number
    reportingRuns: number
  }
}

export interface TokenUsageInsight {
  input: ScalarDistribution
  output: ScalarDistribution
  reasoning: ScalarDistribution
  cached: ScalarDistribution
  cacheWrite: ScalarDistribution
  totals: {
    input: number
    output: number
    reasoning: number
    cached: number
    cacheWrite: number
  }
}

// ── Building blocks ─────────────────────────────────────────────────

/** Distributional summary of a scalar-valued metric. */
export interface ScalarDistribution {
  /** Sample count after dropping non-finite values. */
  n: number
  mean: number
  p50: number
  p95: number
  stddev: number
  min: number
  max: number
  /** Histogram bins using `agent-eval`'s `gainHistogram` primitive. */
  histogram: GainDistributionBin[]
  /** Worst-N runs by score, ascending. Populated for the composite
   *  distribution so the report names the runs a customer should
   *  inspect first. Undefined when the distribution was computed from a
   *  raw value list with no run identity (e.g. cost). */
  tailRuns?: Array<{ runId: string; score: number }>
}

export interface JudgeInsight {
  /** Number of times this judge scored a run. */
  n: number
  /** Mean composite over this judge's runs. */
  meanScore: number
  /** Calibration against a gold reference, when provided. Cohen's κ for
   *  binary thresholding + continuous agreement metrics. */
  calibration?: ContinuousAgreement
  /** Positional bias — when the judge sees options in different orders,
   *  do its preferences track the content or the position? */
  positionalBias?: number
  /** Self-preference — when the judge sees its own model's output vs a
   *  competitor, does it over-pick its own? */
  selfPreference?: number
  /** Verbosity bias — does the judge reward longer outputs regardless of
   *  quality? */
  verbosityBias?: number
}

export interface InterRaterInsight {
  /** Number of raters whose scores were aggregated. */
  raters: number
  /** Number of runs every rater scored. */
  jointlyRated: number
  /** Multi-rater weighted kappa over the jointly rated runs. */
  kappa: number
  /** Absolute agreement across raters, using ICC(2,1). */
  icc: number
  /** Mean pairwise Pearson correlation. Correlation is not agreement. */
  pearson: number
  /** Mean pairwise Spearman rank correlation. */
  spearman: number
  /** Pairwise weighted kappa per rater pair (key = `"raterA::raterB"`). */
  perPair: Record<string, number>
  /** Run ids where raters disagree the most — the high-value triage list. */
  disagreementCases: Array<{
    runId: string
    ratings: Array<{ rater: string; score: number }>
    range: number
  }>
}

export interface LiftInsight {
  baselineMean: number
  candidateMean: number
  /** Candidate − baseline. */
  delta: number
  /** Lower / upper bound of bootstrap CI on the delta. */
  ci95: [number, number]
  /** Paired-t-test p-value. */
  pValue: number
  /** Number of paired observations. */
  n: number
  /** Cohen's d for the delta. */
  cohensD: number
  /** Minimum detectable effect at current n, 80% power. */
  mde: number
  /** Sample size needed to detect the observed delta at 80% power. */
  requiredN: number
}

export interface FailureClusterInsight {
  /** All clusters identified by the registry, ranked by share descending. */
  clusters: Array<{
    id: string
    name: string
    /** Fraction of failed runs in this cluster, 0..1. */
    share: number
    /** Exemplar `runId`s (≤ 5) the consumer can drill into. */
    exemplars: string[]
    /** Short LLM-generated suggested fix when the registry supports it. */
    suggestedFix?: string
  }>
  totalFailures: number
}

/** Model-free failure breakdown over the structured `RunRecord.failureMode`
 *  enum. Unlike `failureClusters` (semantic, requires an LLM analyst), this
 *  is computed directly from the tags the harness already recorded — so a
 *  customer ingesting one batch with no judge/analyst still learns which
 *  named failure dominates. */
export interface FailureModeTally {
  /** The `failureMode` tag. */
  mode: string
  /** Number of runs carrying this tag. */
  count: number
  /** Share of the whole corpus, 0..1. */
  share: number
}

export interface ContaminationInsight {
  /** Canary phrases that leaked into outputs. */
  leaks: number
  /** Holdout audit verdict — did any holdout-tagged run end up in the
   *  search/dev pool, or vice versa? */
  holdoutAuditPassed: boolean
  details?: Array<{ runId: string; canary: string; matched: string }>
}

export interface OutcomeCorrelationInsight {
  /** What outcome the consumer is correlating against (e.g.
   *  `'engagement_rate'`, `'approval_rate'`, `'downstream_pass'`). */
  metric: string
  /** Number of (run, outcome) pairs used. */
  n: number
  /** Pearson correlation between composite score and outcome. */
  pearson: number
  /** Spearman rank correlation — robust to monotonic non-linearity. */
  spearman: number
  /** When present, the simple linear reward model fit to the data. */
  rewardModel?: {
    intercept: number
    slope: number
    r2: number
  }
}

export interface ReleaseSummary {
  /** Overall verdict across axes — fail if any axis fails, else warn if any
   *  warns, else pass. */
  status: 'pass' | 'warn' | 'fail'
  axes: Array<{
    name: 'quality-lift' | 'contamination' | 'composite-distribution'
    status: 'pass' | 'warn' | 'fail'
    detail: string
  }>
  /** Free-form issues surfaced beyond the standard axes. Empty by default;
   *  consumers can post-process to populate. */
  issues: string[]
}

export interface MetricDelta {
  /** Current-period mean. */
  current: number
  /** Baseline-period mean. */
  baseline: number
  /** current - baseline. Positive means improved (or, for cost/duration,
   *  the consumer-side interpretation: "higher current" — semantic
   *  direction depends on the metric). */
  delta: number
  /** Welch 95% confidence interval on the delta. Two-sample, unpaired —
   *  the baseline and current run sets may have different scenarios. */
  ci95: [number, number]
  /** Welch t-test p-value (two-sided). */
  pValue: number
  /** Cohen's d (pooled stddev). Effect size, signed. */
  cohensD: number
  /** Sample sizes. */
  baselineN: number
  currentN: number
  /** True when p < 0.05 AND |d| >= 0.2 (small-effect threshold). The
   *  conjunction prevents large-effect-but-noisy and significant-but-
   *  tiny from triggering recommendations. */
  significant: boolean
}

export interface PriorPeriodComparison {
  /** Sample counts. */
  baselineN: number
  currentN: number
  /** Optional human-readable label — "vs prior 7 days", "vs v3 release". */
  windowLabel?: string
  /** Every metric we could compare. Keys: 'composite', 'cost', 'duration',
   *  'tokenUsage' for always-present ones; per-dimension keys when both
   *  windows have judge scores on the same dimension. */
  metrics: Record<string, MetricDelta>
  /** Metric names where current is significantly WORSE than baseline.
   *  Direction-aware: for cost/duration, higher current = worse. */
  regressedMetrics: string[]
  /** Metric names where current is significantly BETTER than baseline. */
  improvedMetrics: string[]
}

export interface Recommendation {
  priority: 'critical' | 'high' | 'medium' | 'low'
  kind: 'ship' | 'hold' | 'investigate' | 'fix' | 'recalibrate' | 'expand-corpus'
  title: string
  detail: string
  /** Optional pointer back into the report for the evidence. */
  evidencePath?: string
}
