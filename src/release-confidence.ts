/**
 * Release confidence gate.
 *
 * This is the production-facing composition layer over the lower-level
 * primitives:
 *   - Dataset manifests prove corpus/version coverage.
 *   - RunRecord rows prove reproducible search/holdout outcomes.
 *   - Multi-shot trace evidence carries turn counts and ASI diagnostics.
 *   - HeldOutGate decisions remain the paired promotion authority.
 *
 * The gate is intentionally pure and conservative. Missing declared evidence
 * fails closed instead of being treated as a neutral zero.
 */

import type { DatasetManifest, DatasetScenario, DatasetSplit } from './dataset'
import { VerificationError } from './errors'
import type { GateDecision } from './held-out-gate'
import type { RunRecord, RunSplitTag } from './run-record'

/** Severity of an actionable finding attached to a run/trace. */
export type AsiSeverity = 'info' | 'warning' | 'error' | 'critical'

/** Actionable side-info — a diagnosed finding the loop can act on. */
export interface ActionableSideInfo {
  /** Stable expectation/check id when available. */
  expectationId?: string
  /** Human-readable diagnosis of what happened. */
  message: string
  severity?: AsiSeverity
  /** Concrete trace excerpt, file path, tool call, screenshot id, etc. */
  evidence?: string
  /** Prompt/tool/context surface likely responsible. */
  responsibleSurface?: string
  /** Suggested fix in natural language. */
  suggestion?: string
  /** Whether this expectation was satisfied. Defaults to false for ASI rows. */
  matched?: boolean
  metadata?: Record<string, unknown>
}

export type ReleaseConfidenceStatus = 'pass' | 'warn' | 'fail'
export type ReleaseConfidenceAxisName =
  | 'corpus'
  | 'quality'
  | 'reliability'
  | 'generalization'
  | 'diagnostics'
  | 'efficiency'

export interface ReleaseTraceEvidence {
  scenarioId: string
  candidateId?: string
  split?: RunSplitTag
  score?: number
  ok?: boolean
  turnCount?: number
  costUsd?: number
  durationMs?: number
  failureMode?: string
  asi?: ActionableSideInfo[]
  metadata?: Record<string, unknown>
}

export interface ReleaseConfidenceThresholds {
  /** Require a Dataset manifest or explicit scenarios. Default true. */
  requireCorpus?: boolean
  minScenarioCount?: number
  minSearchRuns?: number
  minHoldoutRuns?: number
  /** Require at least one holdout scenario/run. Default true. */
  requireHoldout?: boolean
  minPassRate?: number
  minMeanScore?: number
  /** Search mean may exceed holdout mean by at most this much. */
  maxOverfitGap?: number
  maxMeanCostUsd?: number
  maxP95WallMs?: number
  /** Low-score/failed rows must carry ASI. Default true. */
  requireAsiForFailures?: boolean
  /** Score below this is considered a failure for ASI coverage. Default 0.5. */
  failureScoreThreshold?: number
}

export interface ReleaseConfidenceInput {
  target: string
  candidateId?: string
  baselineId?: string
  dataset?: DatasetManifest
  scenarios?: readonly DatasetScenario[]
  runs?: readonly RunRecord[]
  traces?: readonly ReleaseTraceEvidence[]
  gateDecision?: GateDecision | null
  thresholds?: ReleaseConfidenceThresholds
}

export interface ReleaseConfidenceAxis {
  name: ReleaseConfidenceAxisName
  status: ReleaseConfidenceStatus
  score: number | null
  detail: string
}

export interface ReleaseConfidenceIssue {
  axis: ReleaseConfidenceAxisName
  severity: 'critical' | 'warning'
  code: string
  detail: string
}

export interface ReleaseConfidenceMetrics {
  scenarioCount: number
  /** Search rows with a finite search score. */
  searchRuns: number
  /** Holdout rows with a finite holdout score. */
  holdoutRuns: number
  /** Runs with neither a split-matched score nor an explicit task failure. */
  unscoredRuns: number
  /** Run rows, or trace rows when no runs exist, with no classified terminal result. */
  unclassifiedTerminalRuns: number
  /** Run rows, or trace rows when no runs exist, that ended unsuccessfully. */
  terminalFailureRuns: number
  /** Success fraction when every run or fallback trace row has a classified result. */
  reliabilityRate: number | null
  passRate: number | null
  meanScore: number | null
  searchMeanScore: number | null
  holdoutMeanScore: number | null
  overfitGap: number | null
  meanCostUsd: number | null
  p95WallMs: number | null
  failedRows: number
  failuresWithAsi: number
  singleShotTraces: number
  multiShotTraces: number
  splitCounts: Record<DatasetSplit, number>
  domainCounts: Record<string, number>
  failureModeCounts: Record<string, number>
  responsibleSurfaceCounts: Record<string, number>
}

export interface ReleaseConfidenceScorecard {
  target: string
  candidateId: string | null
  baselineId: string | null
  status: ReleaseConfidenceStatus
  promote: boolean
  axes: ReleaseConfidenceAxis[]
  issues: ReleaseConfidenceIssue[]
  metrics: ReleaseConfidenceMetrics
  dataset: DatasetManifest | null
  gateDecision: GateDecision | null
  summary: string
}

const DEFAULT_THRESHOLDS: Required<ReleaseConfidenceThresholds> = {
  requireCorpus: true,
  minScenarioCount: 1,
  minSearchRuns: 1,
  minHoldoutRuns: 1,
  requireHoldout: true,
  minPassRate: 0.8,
  minMeanScore: 0.7,
  maxOverfitGap: 0.15,
  maxMeanCostUsd: Number.POSITIVE_INFINITY,
  maxP95WallMs: Number.POSITIVE_INFINITY,
  requireAsiForFailures: true,
  failureScoreThreshold: 0.5,
}

export function evaluateReleaseConfidence(
  input: ReleaseConfidenceInput,
): ReleaseConfidenceScorecard {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds }
  const candidateId = input.candidateId ?? null
  const runs = filterCandidate(input.runs ?? [], candidateId, input.baselineId)
  const traces = filterTraceCandidate(input.traces ?? [], candidateId, input.baselineId)
  const scenarios = input.scenarios ?? []
  const scenarioCount = input.dataset?.scenarioCount ?? scenarios.length
  const splitCounts = input.dataset?.splitCounts ?? countScenarioSplits(scenarios)
  const searchScores = scoresFor(runs, 'search')
  const holdoutScores = scoresFor(runs, 'holdout')
  const runScores = runs.map(runSplitScore).filter(isFiniteNumber)
  const traceScores = traces.map((t) => t.score).filter(isFiniteNumber)
  const scoreUniverse = runs.length > 0 ? runScores : traceScores
  const qualityRuns = runs.filter((run) => runSplitScore(run) !== undefined)
  const unscoredRuns = runs.filter(
    (run) =>
      runSplitScore(run) === undefined &&
      !hasExplicitTaskFailure(run) &&
      !isFailedTerminalOutcome(run.terminalOutcome),
  ).length
  const passOutcomes =
    runs.length > 0
      ? runs.map((run) => runPassOutcome(run, thresholds.failureScoreThreshold))
      : traces.map((trace) => tracePassOutcome(trace, thresholds.failureScoreThreshold))
  const reliabilityRows =
    runs.length > 0
      ? runs.map((run) => terminalSuccess(run.terminalOutcome))
      : traces.map((trace) => trace.ok)
  const unclassifiedTerminalRuns = reliabilityRows.filter((outcome) => outcome === undefined).length
  const terminalFailureRuns = reliabilityRows.filter((outcome) => outcome === false).length
  const reliabilityRate =
    reliabilityRows.length === 0 || unclassifiedTerminalRuns > 0
      ? null
      : (reliabilityRows.length - terminalFailureRuns) / reliabilityRows.length
  const searchRuns = qualityRuns.filter((r) => r.splitTag === 'search').length
  const holdoutRuns = qualityRuns.filter((r) => r.splitTag === 'holdout').length
  const failed = failedRows(runs, traces, thresholds.failureScoreThreshold)
  const searchMeanScore = meanOrNull(searchScores)
  const holdoutMeanScore = meanOrNull(holdoutScores)
  const runCosts = runs.flatMap((run) =>
    run.costProvenance.kind === 'uncaptured' ? [] : [run.costProvenance.usd],
  )
  const traceCosts = traces.map((trace) => trace.costUsd).filter(isFiniteNumber)
  const meanCostUsd =
    runs.length > 0
      ? runCosts.length === runs.length
        ? meanOrNull(runCosts)
        : null
      : meanOrNull(traceCosts)
  const wallTimes =
    runs.length > 0
      ? runs.map((run) => run.wallMs)
      : traces.map((trace) => trace.durationMs).filter(isFiniteNumber)
  const metrics: ReleaseConfidenceMetrics = {
    scenarioCount,
    searchRuns,
    holdoutRuns,
    unscoredRuns,
    unclassifiedTerminalRuns,
    terminalFailureRuns,
    reliabilityRate,
    passRate: passOutcomeRate(passOutcomes),
    meanScore: meanOrNull(scoreUniverse),
    searchMeanScore,
    holdoutMeanScore,
    overfitGap: diffOrNull(searchMeanScore, holdoutMeanScore),
    meanCostUsd,
    p95WallMs: percentileOrNull(wallTimes, 0.95),
    failedRows: failed.length,
    failuresWithAsi: failed.filter((row) => row.hasAsi).length,
    singleShotTraces: traces.filter((t) => t.turnCount === 1).length,
    multiShotTraces: traces.filter((t) => (t.turnCount ?? 0) > 1).length,
    splitCounts,
    domainCounts: countDomains(scenarios),
    failureModeCounts: countFailureModes(runs, traces, thresholds.failureScoreThreshold),
    responsibleSurfaceCounts: countResponsibleSurfaces(traces),
  }

  const issues: ReleaseConfidenceIssue[] = []
  checkCorpus(input, thresholds, metrics, issues)
  checkQuality(thresholds, metrics, issues)
  checkReliability(metrics, issues)
  checkGeneralization(input.gateDecision ?? null, thresholds, metrics, issues)
  checkDiagnostics(thresholds, metrics, issues)
  checkEfficiency(thresholds, metrics, issues)

  const axes = buildAxes(metrics, thresholds, issues)
  const status = issues.some((i) => i.severity === 'critical')
    ? 'fail'
    : issues.length > 0
      ? 'warn'
      : 'pass'

  return {
    target: input.target,
    candidateId,
    baselineId: input.baselineId ?? null,
    status,
    promote: status === 'pass' && (input.gateDecision ? input.gateDecision.promote : true),
    axes,
    issues,
    metrics,
    dataset: input.dataset ?? null,
    gateDecision: input.gateDecision ?? null,
    summary: renderSummary(input.target, status, metrics, issues),
  }
}

export function assertReleaseConfidence(input: ReleaseConfidenceInput): ReleaseConfidenceScorecard {
  const scorecard = evaluateReleaseConfidence(input)
  if (scorecard.status === 'fail') {
    throw new VerificationError(scorecard.summary)
  }
  return scorecard
}

function filterCandidate(
  runs: readonly RunRecord[],
  candidateId: string | null,
  baselineId?: string,
): RunRecord[] {
  if (candidateId) return runs.filter((r) => r.candidateId === candidateId)
  if (baselineId) return runs.filter((r) => r.candidateId !== baselineId)
  return [...runs]
}

function filterTraceCandidate(
  traces: readonly ReleaseTraceEvidence[],
  candidateId: string | null,
  baselineId?: string,
): ReleaseTraceEvidence[] {
  if (candidateId)
    return traces.filter((t) => t.candidateId === undefined || t.candidateId === candidateId)
  if (baselineId)
    return traces.filter((t) => t.candidateId === undefined || t.candidateId !== baselineId)
  return [...traces]
}

function checkCorpus(
  input: ReleaseConfidenceInput,
  thresholds: Required<ReleaseConfidenceThresholds>,
  metrics: ReleaseConfidenceMetrics,
  issues: ReleaseConfidenceIssue[],
): void {
  if (thresholds.requireCorpus && !input.dataset && (input.scenarios?.length ?? 0) === 0) {
    issues.push({
      axis: 'corpus',
      severity: 'critical',
      code: 'missing_corpus',
      detail: 'No Dataset manifest or scenarios supplied.',
    })
  }
  if (metrics.scenarioCount < thresholds.minScenarioCount) {
    issues.push({
      axis: 'corpus',
      severity: 'critical',
      code: 'few_scenarios',
      detail: `${metrics.scenarioCount} scenario(s) < min ${thresholds.minScenarioCount}.`,
    })
  }
  if (thresholds.requireHoldout && metrics.splitCounts.holdout === 0) {
    issues.push({
      axis: 'corpus',
      severity: 'critical',
      code: 'missing_holdout_split',
      detail: 'Corpus has no holdout scenarios.',
    })
  }
}

function checkQuality(
  thresholds: Required<ReleaseConfidenceThresholds>,
  metrics: ReleaseConfidenceMetrics,
  issues: ReleaseConfidenceIssue[],
): void {
  if (metrics.searchRuns < thresholds.minSearchRuns) {
    issues.push({
      axis: 'quality',
      severity: 'critical',
      code: 'few_search_runs',
      detail: `${metrics.searchRuns} search run(s) < min ${thresholds.minSearchRuns}.`,
    })
  }
  if (metrics.unscoredRuns > 0) {
    issues.push({
      axis: 'quality',
      severity: 'critical',
      code: 'unscored_runs',
      detail: `${metrics.unscoredRuns} supplied run(s) have no task result.`,
    })
  }
  if (metrics.passRate === null || metrics.meanScore === null) {
    issues.push({
      axis: 'quality',
      severity: 'critical',
      code: 'missing_quality_scores',
      detail: 'No task-quality scores are available for pass-rate and mean-score checks.',
    })
  }
  if (metrics.passRate !== null && metrics.passRate < thresholds.minPassRate) {
    issues.push({
      axis: 'quality',
      severity: 'critical',
      code: 'low_pass_rate',
      detail: `passRate ${fmt(metrics.passRate)} < ${fmt(thresholds.minPassRate)}.`,
    })
  }
  if (metrics.meanScore !== null && metrics.meanScore < thresholds.minMeanScore) {
    issues.push({
      axis: 'quality',
      severity: 'critical',
      code: 'low_mean_score',
      detail: `meanScore ${fmt(metrics.meanScore)} < ${fmt(thresholds.minMeanScore)}.`,
    })
  }
}

function checkReliability(
  metrics: ReleaseConfidenceMetrics,
  issues: ReleaseConfidenceIssue[],
): void {
  if (metrics.reliabilityRate === null) {
    issues.push({
      axis: 'reliability',
      severity: 'critical',
      code: 'missing_reliability_evidence',
      detail:
        metrics.unclassifiedTerminalRuns > 0
          ? `${metrics.unclassifiedTerminalRuns} supplied run(s) have no classified terminal result.`
          : 'No classified terminal results are available.',
    })
  }
  if (metrics.terminalFailureRuns > 0) {
    issues.push({
      axis: 'reliability',
      severity: 'critical',
      code: 'terminal_run_failures',
      detail: `${metrics.terminalFailureRuns} run(s) ended failed, cancelled, or incomplete.`,
    })
  }
}

function checkGeneralization(
  gateDecision: GateDecision | null,
  thresholds: Required<ReleaseConfidenceThresholds>,
  metrics: ReleaseConfidenceMetrics,
  issues: ReleaseConfidenceIssue[],
): void {
  if (thresholds.requireHoldout && metrics.holdoutRuns < thresholds.minHoldoutRuns) {
    issues.push({
      axis: 'generalization',
      severity: 'critical',
      code: 'few_holdout_runs',
      detail: `${metrics.holdoutRuns} holdout run(s) < min ${thresholds.minHoldoutRuns}.`,
    })
  }
  if (metrics.overfitGap !== null && metrics.overfitGap > thresholds.maxOverfitGap) {
    issues.push({
      axis: 'generalization',
      severity: 'critical',
      code: 'overfit_gap',
      detail: `search-holdout gap ${fmt(metrics.overfitGap)} > ${fmt(thresholds.maxOverfitGap)}.`,
    })
  }
  if (gateDecision && !gateDecision.promote) {
    issues.push({
      axis: 'generalization',
      severity: 'critical',
      code: `gate_${gateDecision.rejectionCode ?? 'reject'}`,
      detail: gateDecision.reason,
    })
  }
}

function checkDiagnostics(
  thresholds: Required<ReleaseConfidenceThresholds>,
  metrics: ReleaseConfidenceMetrics,
  issues: ReleaseConfidenceIssue[],
): void {
  if (!thresholds.requireAsiForFailures) return
  if (metrics.failedRows > metrics.failuresWithAsi) {
    issues.push({
      axis: 'diagnostics',
      severity: 'critical',
      code: 'missing_failure_asi',
      detail: `${metrics.failedRows - metrics.failuresWithAsi} failed row(s) have no actionable side information.`,
    })
  }
}

function checkEfficiency(
  thresholds: Required<ReleaseConfidenceThresholds>,
  metrics: ReleaseConfidenceMetrics,
  issues: ReleaseConfidenceIssue[],
): void {
  if (Number.isFinite(thresholds.maxMeanCostUsd) && metrics.meanCostUsd === null) {
    issues.push({
      axis: 'efficiency',
      severity: 'critical',
      code: 'missing_cost',
      detail: 'A finite cost limit was configured but no cost evidence is available.',
    })
  } else if (metrics.meanCostUsd !== null && metrics.meanCostUsd > thresholds.maxMeanCostUsd) {
    issues.push({
      axis: 'efficiency',
      severity: 'critical',
      code: 'cost_budget',
      detail: `meanCostUsd ${fmt(metrics.meanCostUsd)} > ${fmt(thresholds.maxMeanCostUsd)}.`,
    })
  }
  if (Number.isFinite(thresholds.maxP95WallMs) && metrics.p95WallMs === null) {
    issues.push({
      axis: 'efficiency',
      severity: 'critical',
      code: 'missing_latency',
      detail: 'A finite latency limit was configured but no latency evidence is available.',
    })
  } else if (metrics.p95WallMs !== null && metrics.p95WallMs > thresholds.maxP95WallMs) {
    issues.push({
      axis: 'efficiency',
      severity: 'critical',
      code: 'latency_budget',
      detail: `p95WallMs ${fmt(metrics.p95WallMs)} > ${fmt(thresholds.maxP95WallMs)}.`,
    })
  }
}

function buildAxes(
  metrics: ReleaseConfidenceMetrics,
  thresholds: Required<ReleaseConfidenceThresholds>,
  issues: ReleaseConfidenceIssue[],
): ReleaseConfidenceAxis[] {
  return [
    axis(
      'corpus',
      issues,
      bounded(metrics.scenarioCount / Math.max(1, thresholds.minScenarioCount)),
      `${metrics.scenarioCount} scenarios; holdout=${metrics.splitCounts.holdout}`,
    ),
    axis(
      'quality',
      issues,
      metrics.passRate === null || metrics.meanScore === null
        ? null
        : Math.min(metrics.passRate, metrics.meanScore),
      `passRate=${fmt(metrics.passRate)} meanScore=${fmt(metrics.meanScore)}`,
    ),
    axis(
      'reliability',
      issues,
      metrics.reliabilityRate,
      `successRate=${fmt(metrics.reliabilityRate)} terminalFailures=${metrics.terminalFailureRuns} unclassified=${metrics.unclassifiedTerminalRuns}`,
    ),
    axis(
      'generalization',
      issues,
      gapScore(metrics.overfitGap, thresholds.maxOverfitGap),
      `holdoutRuns=${metrics.holdoutRuns} overfitGap=${fmt(metrics.overfitGap)}`,
    ),
    axis(
      'diagnostics',
      issues,
      metrics.failedRows === 0 ? 1 : metrics.failuresWithAsi / metrics.failedRows,
      `failuresWithAsi=${metrics.failuresWithAsi}/${metrics.failedRows}`,
    ),
    axis(
      'efficiency',
      issues,
      efficiencyScore(metrics, thresholds),
      `meanCostUsd=${fmt(metrics.meanCostUsd)} p95WallMs=${fmt(metrics.p95WallMs)}`,
    ),
  ]
}

function axis(
  name: ReleaseConfidenceAxisName,
  issues: ReleaseConfidenceIssue[],
  score: number | null,
  detail: string,
): ReleaseConfidenceAxis {
  const own = issues.filter((i) => i.axis === name)
  const status = own.some((i) => i.severity === 'critical')
    ? 'fail'
    : own.length > 0
      ? 'warn'
      : 'pass'
  return { name, status, score: score === null ? null : bounded(score), detail }
}

function countScenarioSplits(scenarios: readonly DatasetScenario[]): Record<DatasetSplit, number> {
  const counts: Record<DatasetSplit, number> = { train: 0, dev: 0, test: 0, holdout: 0 }
  for (const scenario of scenarios) counts[scenario.split ?? 'train']++
  return counts
}

function countDomains(scenarios: readonly DatasetScenario[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const scenario of scenarios) {
    const domain = scenario.tags?.domain ?? scenario.tags?.category ?? 'uncategorized'
    out[domain] = (out[domain] ?? 0) + 1
  }
  return out
}

function countFailureModes(
  runs: readonly RunRecord[],
  traces: readonly ReleaseTraceEvidence[],
  threshold: number,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const run of runs) {
    if (runPassOutcome(run, threshold) === false) {
      const mode = run.failureMode ?? run.failureClass ?? 'low_score'
      out[mode] = (out[mode] ?? 0) + 1
    }
  }
  for (const trace of traces) {
    if (tracePassOutcome(trace, threshold) === false) {
      const mode = trace.failureMode ?? (trace.ok === false ? 'not_ok' : 'low_score')
      out[mode] = (out[mode] ?? 0) + 1
    }
  }
  return out
}

function countResponsibleSurfaces(traces: readonly ReleaseTraceEvidence[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const trace of traces) {
    for (const asi of trace.asi ?? []) {
      const surface = asi.responsibleSurface ?? 'unknown'
      out[surface] = (out[surface] ?? 0) + 1
    }
  }
  return out
}

function failedRows(
  runs: readonly RunRecord[],
  traces: readonly ReleaseTraceEvidence[],
  threshold: number,
): Array<{ hasAsi: boolean }> {
  const out: Array<{ hasAsi: boolean }> = []
  for (const run of runs) {
    if (runPassOutcome(run, threshold) === false) {
      const asiMetric = run.outcome.raw.asi
      out.push({ hasAsi: typeof asiMetric === 'number' && asiMetric > 0 })
    }
  }
  for (const trace of traces) {
    if (tracePassOutcome(trace, threshold) === false) {
      out.push({ hasAsi: (trace.asi?.length ?? 0) > 0 })
    }
  }
  return out
}

function passOutcomeRate(outcomes: readonly (boolean | null)[]): number | null {
  const classified = outcomes.filter((outcome): outcome is boolean => outcome !== null)
  if (classified.length === 0) return null
  return classified.filter(Boolean).length / classified.length
}

function runPassOutcome(run: RunRecord, threshold: number): boolean | null {
  if (hasExplicitTaskFailure(run)) return false
  const score = runSplitScore(run)
  return score === undefined ? null : score >= threshold
}

function hasExplicitTaskFailure(run: RunRecord): boolean {
  return (
    (run.failureClass !== undefined && run.failureClass !== 'success') ||
    run.failureMode !== undefined
  )
}

function tracePassOutcome(trace: ReleaseTraceEvidence, threshold: number): boolean | null {
  if (trace.failureMode !== undefined) return false
  if (trace.ok === false) return false
  if (isFiniteNumber(trace.score)) return trace.score >= threshold
  return trace.ok === true ? true : null
}

function isFailedTerminalOutcome(
  outcome: RunRecord['terminalOutcome'],
): outcome is 'failed' | 'cancelled' | 'incomplete' {
  return outcome === 'failed' || outcome === 'cancelled' || outcome === 'incomplete'
}

function terminalSuccess(outcome: RunRecord['terminalOutcome']): boolean | undefined {
  if (outcome === 'succeeded') return true
  if (isFailedTerminalOutcome(outcome)) return false
  return undefined
}

function scoresFor(runs: readonly RunRecord[], split: RunSplitTag): number[] {
  return runs
    .filter((run) => run.splitTag === split)
    .map(runSplitScore)
    .filter(isFiniteNumber)
}

function runSplitScore(run: RunRecord): number | undefined {
  const score = run.splitTag === 'holdout' ? run.outcome.holdoutScore : run.outcome.searchScore
  return isFiniteNumber(score) ? score : undefined
}

function meanOrNull(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((sum, x) => sum + x, 0) / xs.length
}

function percentileOrNull(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function diffOrNull(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a - b
}

function gapScore(gap: number | null, maxGap: number): number | null {
  if (gap === null) return null
  if (maxGap <= 0) return gap <= 0 ? 1 : 0
  return bounded(1 - Math.max(0, gap) / maxGap)
}

function efficiencyScore(
  metrics: ReleaseConfidenceMetrics,
  thresholds: Required<ReleaseConfidenceThresholds>,
): number | null {
  const cost = Number.isFinite(thresholds.maxMeanCostUsd)
    ? metrics.meanCostUsd === null
      ? null
      : bounded(thresholds.maxMeanCostUsd / Math.max(metrics.meanCostUsd, 1e-12))
    : 1
  const latency = Number.isFinite(thresholds.maxP95WallMs)
    ? metrics.p95WallMs === null
      ? null
      : bounded(thresholds.maxP95WallMs / Math.max(metrics.p95WallMs, 1e-12))
    : 1
  if (cost === null || latency === null) return null
  return Math.min(cost, latency)
}

function bounded(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

function renderSummary(
  target: string,
  status: ReleaseConfidenceStatus,
  metrics: ReleaseConfidenceMetrics,
  issues: ReleaseConfidenceIssue[],
): string {
  const prefix = `release confidence ${status}: ${target}`
  const metricText = `scenarios=${metrics.scenarioCount} searchRuns=${metrics.searchRuns} holdoutRuns=${metrics.holdoutRuns} passRate=${fmt(metrics.passRate)} meanScore=${fmt(metrics.meanScore)}`
  if (issues.length === 0) return `${prefix}; ${metricText}`
  return `${prefix}; ${metricText}; issues=${issues.map((i) => i.code).join(',')}`
}

function fmt(x: number | null): string {
  if (x === null) return 'n/a'
  return x.toFixed(4)
}
