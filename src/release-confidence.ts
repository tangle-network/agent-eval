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
import type { ActionableSideInfo, MultiShotTrialResult } from './multi-shot-optimization'
import type { RunRecord, RunSplitTag } from './run-record'

export type ReleaseConfidenceStatus = 'pass' | 'warn' | 'fail'
export type ReleaseConfidenceAxisName =
  | 'corpus'
  | 'quality'
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
  score: number
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
  searchRuns: number
  holdoutRuns: number
  passRate: number
  meanScore: number
  searchMeanScore: number
  holdoutMeanScore: number
  overfitGap: number
  meanCostUsd: number
  p95WallMs: number
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

export function releaseTraceEvidenceFromMultiShotTrials(
  trials: readonly MultiShotTrialResult[],
): ReleaseTraceEvidence[] {
  return trials.map((trial) => ({
    scenarioId: trial.scenarioId,
    candidateId: trial.variantId,
    split: trial.split === 'holdout' ? 'holdout' : trial.split === 'dev' ? 'dev' : 'search',
    score: trial.score,
    ok: trial.ok,
    turnCount: Array.isArray(trial.trace?.turns) ? trial.trace.turns.length : undefined,
    costUsd: trial.cost,
    durationMs: trial.durationMs,
    failureMode: trial.error ? 'runtime_error' : undefined,
    asi: trial.asi,
    metadata: trial.metadata,
  }))
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
  const allScores = [...searchScores, ...holdoutScores]
  const traceScores = traces.map((t) => t.score).filter(isFiniteNumber)
  const scoreUniverse = allScores.length > 0 ? allScores : traceScores
  const searchRuns = runs.filter((r) => r.splitTag === 'search').length
  const holdoutRuns = runs.filter((r) => r.splitTag === 'holdout').length
  const searchMeanScore = mean(searchScores)
  const holdoutMeanScore = mean(holdoutScores)
  const metrics: ReleaseConfidenceMetrics = {
    scenarioCount,
    searchRuns,
    holdoutRuns,
    passRate: passRate(runs, traces, thresholds.failureScoreThreshold),
    meanScore: mean(scoreUniverse),
    searchMeanScore,
    holdoutMeanScore,
    overfitGap: safeDiff(searchMeanScore, holdoutMeanScore),
    meanCostUsd: mean([
      ...runs.map((r) => r.costUsd),
      ...traces.map((t) => t.costUsd).filter(isFiniteNumber),
    ]),
    p95WallMs: percentile(
      [...runs.map((r) => r.wallMs), ...traces.map((t) => t.durationMs).filter(isFiniteNumber)],
      0.95,
    ),
    failedRows: failedRows(runs, traces, thresholds.failureScoreThreshold).length,
    failuresWithAsi: failedRows(runs, traces, thresholds.failureScoreThreshold).filter(
      (row) => row.hasAsi,
    ).length,
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
  checkGeneralization(input.gateDecision ?? null, thresholds, metrics, issues)
  checkDiagnostics(thresholds, metrics, issues)
  checkEfficiency(thresholds, metrics, issues)

  const axes = buildAxes(metrics, thresholds, input.gateDecision ?? null, issues)
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
  if (metrics.passRate < thresholds.minPassRate) {
    issues.push({
      axis: 'quality',
      severity: 'critical',
      code: 'low_pass_rate',
      detail: `passRate ${fmt(metrics.passRate)} < ${fmt(thresholds.minPassRate)}.`,
    })
  }
  if (metrics.meanScore < thresholds.minMeanScore) {
    issues.push({
      axis: 'quality',
      severity: 'critical',
      code: 'low_mean_score',
      detail: `meanScore ${fmt(metrics.meanScore)} < ${fmt(thresholds.minMeanScore)}.`,
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
  if (Number.isFinite(metrics.overfitGap) && metrics.overfitGap > thresholds.maxOverfitGap) {
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
  if (metrics.meanCostUsd > thresholds.maxMeanCostUsd) {
    issues.push({
      axis: 'efficiency',
      severity: 'critical',
      code: 'cost_budget',
      detail: `meanCostUsd ${fmt(metrics.meanCostUsd)} > ${fmt(thresholds.maxMeanCostUsd)}.`,
    })
  }
  if (metrics.p95WallMs > thresholds.maxP95WallMs) {
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
  gateDecision: GateDecision | null,
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
      Math.min(metrics.passRate, metrics.meanScore),
      `passRate=${fmt(metrics.passRate)} meanScore=${fmt(metrics.meanScore)}`,
    ),
    axis(
      'generalization',
      issues,
      gateDecision && !gateDecision.promote
        ? 0
        : gapScore(metrics.overfitGap, thresholds.maxOverfitGap),
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
  score: number,
  detail: string,
): ReleaseConfidenceAxis {
  const own = issues.filter((i) => i.axis === name)
  const status = own.some((i) => i.severity === 'critical')
    ? 'fail'
    : own.length > 0
      ? 'warn'
      : 'pass'
  return { name, status, score: bounded(score), detail }
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
    const score = run.outcome.holdoutScore ?? run.outcome.searchScore
    if (run.failureMode || (score !== undefined && score < threshold)) {
      const mode = run.failureMode ?? 'low_score'
      out[mode] = (out[mode] ?? 0) + 1
    }
  }
  for (const trace of traces) {
    if (
      trace.failureMode ||
      trace.ok === false ||
      (trace.score !== undefined && trace.score < threshold)
    ) {
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
    const score = run.outcome.holdoutScore ?? run.outcome.searchScore
    if (run.failureMode || (score !== undefined && score < threshold)) {
      const asiMetric = run.outcome.raw.asi
      out.push({ hasAsi: typeof asiMetric === 'number' && asiMetric > 0 })
    }
  }
  for (const trace of traces) {
    if (
      trace.failureMode ||
      trace.ok === false ||
      (trace.score !== undefined && trace.score < threshold)
    ) {
      out.push({ hasAsi: (trace.asi?.length ?? 0) > 0 })
    }
  }
  return out
}

function passRate(
  runs: readonly RunRecord[],
  traces: readonly ReleaseTraceEvidence[],
  threshold: number,
): number {
  const outcomes = [
    ...runs.map((run) => {
      const score = run.outcome.holdoutScore ?? run.outcome.searchScore
      return !run.failureMode && score !== undefined && score >= threshold
    }),
    ...traces.map(
      (trace) => trace.ok !== false && (trace.score === undefined || trace.score >= threshold),
    ),
  ]
  if (outcomes.length === 0) return 0
  return outcomes.filter(Boolean).length / outcomes.length
}

function scoresFor(runs: readonly RunRecord[], split: RunSplitTag): number[] {
  return runs
    .filter((run) => run.splitTag === split)
    .map((run) => (split === 'holdout' ? run.outcome.holdoutScore : run.outcome.searchScore))
    .filter(isFiniteNumber)
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN
  return xs.reduce((sum, x) => sum + x, 0) / xs.length
}

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function safeDiff(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN
  return a - b
}

function gapScore(gap: number, maxGap: number): number {
  if (!Number.isFinite(gap)) return 0
  if (maxGap <= 0) return gap <= 0 ? 1 : 0
  return bounded(1 - Math.max(0, gap) / maxGap)
}

function efficiencyScore(
  metrics: ReleaseConfidenceMetrics,
  thresholds: Required<ReleaseConfidenceThresholds>,
): number {
  const cost =
    Number.isFinite(thresholds.maxMeanCostUsd) && Number.isFinite(metrics.meanCostUsd)
      ? bounded(thresholds.maxMeanCostUsd / Math.max(metrics.meanCostUsd, 1e-12))
      : 1
  const latency =
    Number.isFinite(thresholds.maxP95WallMs) && Number.isFinite(metrics.p95WallMs)
      ? bounded(thresholds.maxP95WallMs / Math.max(metrics.p95WallMs, 1e-12))
      : 1
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

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  return x.toFixed(4)
}
