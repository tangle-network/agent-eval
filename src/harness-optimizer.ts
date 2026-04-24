import { paretoFrontier, type Objective, type ParetoResult } from './pareto'
import { aggregateRunScore, type RunScore, type RunScoreWeights } from './run-score'
import { RunCritic, type RunTrace } from './run-critic'
import type { SteeringBundle } from './steering'

export type HarnessIntervention =
  | 'continue'
  | 'plan'
  | 'audit'
  | 'recover'
  | 'repair'
  | 'verify'
  | 'final_gate'
  | 'wait_for_measurement'
  | 'abort'

export interface WorkflowTopology {
  id: string
  interventions: HarnessIntervention[]
  maxParallelBranches?: number
  metadata?: Record<string, unknown>
}

export interface MeasurementPolicy {
  required: string[]
  optional?: string[]
  promoteOn?: Array<keyof RunScore | 'aggregate'>
}

export interface HarnessVariant {
  id: string
  steering?: SteeringBundle
  topology?: WorkflowTopology
  measurement?: MeasurementPolicy
  budgets?: Record<string, number>
  models?: Record<string, string>
  reviewers?: Record<string, string>
  metadata?: Record<string, unknown>
}

export interface HarnessScenario {
  id: string
  task: string
  split?: 'train' | 'validation' | 'test' | string
  metadata?: Record<string, unknown>
}

export interface HarnessRunRequest {
  variant: HarnessVariant
  scenario: HarnessScenario
  trialIndex: number
}

export interface HarnessAdapter {
  run(request: HarnessRunRequest): Promise<RunTrace>
}

export interface HarnessRunResult {
  variant: HarnessVariant
  scenario: HarnessScenario
  trialIndex: number
  trace: RunTrace
  score: RunScore
  aggregate: number
}

export interface HarnessVariantReport {
  variant: HarnessVariant
  runs: HarnessRunResult[]
  aggregateMean: number
  passRate: number
  costUsdMean: number
  wallSecondsMean: number
  scoreMean: RunScore
}

export interface HarnessSelection {
  winner: HarnessVariantReport
  frontier: ParetoResult<HarnessVariantReport>
  reports: HarnessVariantReport[]
}

export interface HarnessExperimentResult {
  results: HarnessRunResult[]
  selection: HarnessSelection
}

export interface HarnessExperimentConfig {
  adapter: HarnessAdapter
  variants: HarnessVariant[]
  scenarios: HarnessScenario[]
  trialsPerScenario?: number
  parallelism?: number
  weights?: Partial<RunScoreWeights>
  objectives?: Array<Objective<HarnessVariantReport>>
  score?: (trace: RunTrace, request: HarnessRunRequest) => RunScore | Promise<RunScore>
  onResult?: (result: HarnessRunResult) => void | Promise<void>
}

export const DEFAULT_HARNESS_OBJECTIVES: Array<Objective<HarnessVariantReport>> = [
  { name: 'aggregate', direction: 'maximize', value: (r) => r.aggregateMean },
  { name: 'pass_rate', direction: 'maximize', value: (r) => r.passRate },
  { name: 'cost', direction: 'minimize', value: (r) => r.costUsdMean },
  { name: 'wall', direction: 'minimize', value: (r) => r.wallSecondsMean },
]

export async function runHarnessExperiment(config: HarnessExperimentConfig): Promise<HarnessExperimentResult> {
  const jobs = buildJobs(config)
  const critic = new RunCritic({ weights: config.weights })
  const score = config.score ?? ((trace: RunTrace) => critic.scoreTrace(trace))
  const results = await mapLimit(jobs, config.parallelism ?? 1, async (request) => {
    const trace = await config.adapter.run(request)
    const runScore = await score(trace, request)
    const result: HarnessRunResult = {
      variant: request.variant,
      scenario: request.scenario,
      trialIndex: request.trialIndex,
      trace,
      score: runScore,
      aggregate: aggregateRunScore(runScore, config.weights),
    }
    await config.onResult?.(result)
    return result
  })
  return { results, selection: selectHarnessVariant(results, config.objectives) }
}

export function selectHarnessVariant(
  results: HarnessRunResult[],
  objectives: Array<Objective<HarnessVariantReport>> = DEFAULT_HARNESS_OBJECTIVES,
): HarnessSelection {
  const reports = summarizeHarnessResults(results)
  if (reports.length === 0) throw new Error('selectHarnessVariant: no results')
  const frontier = paretoFrontier(reports, objectives)
  const candidates = frontier.frontier.length ? frontier.frontier : reports
  const winner = [...candidates].sort((a, b) => b.aggregateMean - a.aggregateMean)[0]
  if (!winner) throw new Error('selectHarnessVariant: no winner')
  return { winner, frontier, reports }
}

export function summarizeHarnessResults(results: HarnessRunResult[]): HarnessVariantReport[] {
  const byVariant = new Map<string, HarnessRunResult[]>()
  for (const result of results) {
    byVariant.set(result.variant.id, [...(byVariant.get(result.variant.id) ?? []), result])
  }
  return [...byVariant.values()]
    .map((runs) => {
      const variant = runs[0]?.variant
      if (!variant) throw new Error('summarizeHarnessResults: empty variant bucket')
      return {
        variant,
        runs,
        aggregateMean: mean(runs.map((r) => r.aggregate)),
        passRate: mean(runs.map((r) => r.score.success)),
        costUsdMean: mean(runs.map((r) => r.score.costUsd)),
        wallSecondsMean: mean(runs.map((r) => r.score.wallSeconds)),
        scoreMean: meanRunScore(runs.map((r) => r.score)),
      }
    })
    .sort((a, b) => b.aggregateMean - a.aggregateMean)
}

function buildJobs(config: HarnessExperimentConfig): HarnessRunRequest[] {
  if (config.variants.length === 0) throw new Error('runHarnessExperiment: at least one variant required')
  if (config.scenarios.length === 0) throw new Error('runHarnessExperiment: at least one scenario required')
  const trials = Math.max(1, Math.floor(config.trialsPerScenario ?? 1))
  const jobs: HarnessRunRequest[] = []
  for (const variant of config.variants) {
    for (const scenario of config.scenarios) {
      for (let trialIndex = 0; trialIndex < trials; trialIndex++) {
        jobs.push({ variant, scenario, trialIndex })
      }
    }
  }
  return jobs
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length))
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  }))
  return results
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function meanRunScore(scores: RunScore[]): RunScore {
  return {
    success: mean(scores.map((s) => s.success)),
    goalProgress: mean(scores.map((s) => s.goalProgress)),
    repoGroundedness: mean(scores.map((s) => s.repoGroundedness)),
    driftPenalty: mean(scores.map((s) => s.driftPenalty)),
    toolUseQuality: mean(scores.map((s) => s.toolUseQuality)),
    patchQuality: mean(scores.map((s) => s.patchQuality)),
    testReality: mean(scores.map((s) => s.testReality)),
    finalGate: mean(scores.map((s) => s.finalGate)),
    reviewerBlockers: mean(scores.map((s) => s.reviewerBlockers)),
    costUsd: mean(scores.map((s) => s.costUsd)),
    wallSeconds: mean(scores.map((s) => s.wallSeconds)),
    notes: scores.flatMap((s) => s.notes ?? []),
  }
}
