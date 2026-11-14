import { join } from 'node:path'
import {
  type CampaignResult,
  type DispatchFn,
  type JudgeConfig,
  type JudgeScore,
  runCampaign,
  type Scenario,
} from '../campaign'
import { type CampaignStorage, fsCampaignStorage } from '../campaign/storage'
import type { RunSplitTag } from '../run-record'
import { summarizeNumberSeries } from '../statistics'
import { mean } from '../statistics/mean'
import { benchmarkDefinitionDigest } from './definition'
import { defineBenchmarkResult } from './result'
import type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
  BenchmarkFamily,
  BenchmarkResponder,
  BenchmarkScenario,
  BenchmarkTaskKind,
} from './types'

export interface BenchmarkRunOptions<TPayload = unknown, TArtifact = string> {
  adapter: BenchmarkAdapter<BenchmarkDatasetItem<TPayload>, TPayload, TArtifact>
  respond: BenchmarkResponder<TPayload, TArtifact>
  /** Pins the responder/model/prompt implementation for resumable defined benchmarks. */
  dispatchRef?: string
  splits?: readonly RunSplitTag[]
  runDir: string
  repo?: string
  seed?: number
  reps?: number
  resumable?: boolean
  costCeiling?: number
  maxConcurrency?: number
  dispatchTimeoutMs?: number
  expectUsage?: 'assert' | 'warn' | 'off'
  storage?: CampaignStorage
  now?: () => Date
}

export interface BenchmarkReport {
  benchmarkId: string
  family: BenchmarkFamily | string
  taskKind: BenchmarkTaskKind | string
  source?: BenchmarkAdapter['source']
  runDir: string
  manifestHash: string
  seed: number
  startedAt: string
  endedAt: string
  durationMs: number
  totalItems: number
  totalCells: number
  /** Cells with a complete score, excluding missing/failed grading. */
  cellsMeasured: number
  cellsUnmeasured: number
  cellsFailed: number
  cellsCached: number
  totalCostUsd: number
  splits: Record<string, BenchmarkSliceSummary>
  tags: Record<string, BenchmarkSliceSummary>
  dimensions: Record<string, BenchmarkDistribution>
  score: BenchmarkDistribution
  costUsd: BenchmarkDistribution
  latencyMs: BenchmarkDistribution
  definition?: BenchmarkAdapter['definition']
  definitionDigest?: string
  evaluationRef?: string
  /** This report summarizes normalized Eval scores; native official aggregation is separate. */
  scoreAggregation: 'mean-normalized-score'
  nativeAggregation: 'not-computed'
}

export interface BenchmarkSliceSummary {
  n: number
  meanScore: number
  passRate: number
  score: BenchmarkDistribution
  costUsd: BenchmarkDistribution
  latencyMs: BenchmarkDistribution
}

export interface BenchmarkDistribution {
  n: number
  min: number
  mean: number
  median: number
  p90: number
  max: number
}

export interface BenchmarkRunResult<TPayload = unknown, TArtifact = string> {
  scenarios: Array<BenchmarkScenario<TPayload>>
  campaign: CampaignResult<TArtifact, BenchmarkScenario<TPayload>>
  report: BenchmarkReport
  reportJsonPath: string
  reportMarkdownPath: string
}

export async function runBenchmarkAdapter<TPayload = unknown, TArtifact = string>(
  options: BenchmarkRunOptions<TPayload, TArtifact>,
): Promise<BenchmarkRunResult<TPayload, TArtifact>> {
  const storage = options.storage ?? fsCampaignStorage()
  if (options.dispatchRef !== undefined && !options.dispatchRef.trim()) {
    throw new Error('benchmark dispatchRef must not be blank')
  }
  if (options.adapter.definition && options.resumable !== false && !options.dispatchRef) {
    throw new Error('resumable defined benchmarks require an explicit responder dispatchRef')
  }
  const benchmarkId = benchmarkIdFor(options.adapter)
  const scenarios = await benchmarkScenarios(options.adapter, options.splits)
  const judge = benchmarkJudge(options.adapter)
  const definitionDigest = options.adapter.definition
    ? benchmarkDefinitionDigest(options.adapter.definition)
    : undefined
  const dispatch: DispatchFn<BenchmarkScenario<TPayload>, TArtifact> = async (
    scenario,
    context,
  ) => {
    return options.respond({ scenario, item: scenario.item, context })
  }

  const campaign = await runCampaign<BenchmarkScenario<TPayload>, TArtifact>({
    scenarios,
    dispatch,
    dispatchRef: [
      `benchmark:${benchmarkId}`,
      definitionDigest,
      options.adapter.evaluationRef,
      options.dispatchRef,
    ]
      .filter((part) => part !== undefined)
      .join(':'),
    judges: [judge],
    seed: options.seed,
    reps: options.reps,
    resumable: options.resumable,
    costCeiling: options.costCeiling,
    maxConcurrency: options.maxConcurrency,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    expectUsage: options.expectUsage ?? 'off',
    runDir: options.runDir,
    repo: options.repo,
    storage,
    now: options.now,
  })
  const report = summarizeBenchmarkCampaign({
    adapter: options.adapter,
    scenarios,
    campaign,
  })
  storage.ensureDir(campaign.runDir)
  const reportJsonPath = join(campaign.runDir, 'benchmark-report.json')
  const reportMarkdownPath = join(campaign.runDir, 'benchmark-report.md')
  storage.write(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`)
  storage.write(reportMarkdownPath, renderBenchmarkReportMarkdown(report))
  return { scenarios, campaign, report, reportJsonPath, reportMarkdownPath }
}

export async function benchmarkScenarios<TPayload>(
  adapter: BenchmarkAdapter<BenchmarkDatasetItem<TPayload>, TPayload, unknown>,
  splits: readonly RunSplitTag[] = ['search', 'dev', 'holdout'],
): Promise<Array<BenchmarkScenario<TPayload>>> {
  const benchmarkId = benchmarkIdFor(adapter)
  const family = adapter.family ?? 'custom'
  const taskKind = adapter.taskKind ?? 'custom'
  const out: Array<BenchmarkScenario<TPayload>> = []
  const seen = new Set<string>()
  for (const split of splits) {
    const items = await adapter.loadDataset(split)
    for (const item of items) {
      const splitTag = item.split ?? adapter.assignSplit(item.id)
      if (splitTag !== split) continue
      const key = `${benchmarkId}:${item.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        id: key,
        kind: 'benchmark',
        benchmarkId,
        family: item.family ?? family,
        taskKind: item.taskKind ?? taskKind,
        splitTag,
        tags: [...new Set([splitTag, ...(item.tags ?? [])])],
        item,
      })
    }
  }
  return out
}

export function benchmarkJudge<TPayload, TArtifact>(
  adapter: BenchmarkAdapter<BenchmarkDatasetItem<TPayload>, TPayload, TArtifact>,
): JudgeConfig<TArtifact, BenchmarkScenario<TPayload>> {
  const benchmarkId = benchmarkIdFor(adapter)
  return {
    name: `${benchmarkId}:score`,
    ...(adapter.evaluationRef ? { judgeVersion: adapter.evaluationRef } : {}),
    dimensions: [
      { key: 'score', description: `Primary ${benchmarkId} benchmark score` },
      { key: 'passed', description: 'Binary pass projection for aggregate reporting' },
    ],
    appliesTo: (scenario: Scenario): scenario is BenchmarkScenario<TPayload> => {
      return scenario.kind === 'benchmark' && scenario.id.startsWith(`${benchmarkId}:`)
    },
    async score({ artifact, scenario }) {
      const receipt = adapter.evaluateResult
        ? defineBenchmarkResult(
            await adapter.evaluateResult(scenario.item, artifact),
            adapter.definition,
          )
        : undefined
      const evaluation = receipt?.evaluation ?? (await adapter.evaluate(scenario.item, artifact))
      if (!Number.isFinite(evaluation.score) || evaluation.score < 0 || evaluation.score > 1) {
        throw new Error(`${benchmarkId}: invalid normalized benchmark score ${evaluation.score}`)
      }
      if (adapter.definition && typeof evaluation.passed !== 'boolean') {
        throw new Error(
          `${benchmarkId}: defined benchmarks require an explicit pass/fail projection`,
        )
      }
      const dimensions = normalizeEvaluationDimensions(evaluation)
      return {
        dimensions,
        composite: clamp01(evaluation.score),
        notes: evaluation.notes ?? '',
        evidence: {
          benchmarkId,
          ...(adapter.evaluationRef ? { evaluationRef: adapter.evaluationRef } : {}),
          ...(receipt ? { benchmarkResult: receipt } : { evaluation }),
        },
        ...(evaluation.certification ? { certification: evaluation.certification } : {}),
      }
    },
  }
}

function summarizeBenchmarkCampaign<TPayload, TArtifact>(input: {
  adapter: BenchmarkAdapter<BenchmarkDatasetItem<TPayload>, TPayload, TArtifact>
  scenarios: Array<BenchmarkScenario<TPayload>>
  campaign: CampaignResult<TArtifact, BenchmarkScenario<TPayload>>
}): BenchmarkReport {
  const scenarioById = new Map(input.scenarios.map((scenario) => [scenario.id, scenario]))
  const rows = input.campaign.cells.map((cell) => {
    const scenario = scenarioById.get(cell.scenarioId)
    const judge = firstJudgeScore(cell.judgeScores)
    const measured = judge !== undefined && !judge.failed && Number.isFinite(judge.composite)
    const score = measured ? judge.composite : Number.NaN
    return {
      cell,
      scenario,
      score,
      measured,
      passed: (judge?.dimensions.passed ?? (score > 0 ? 1 : 0)) >= 1,
      dimensions: judge?.dimensions ?? {},
    }
  })
  const successful = rows.filter((row) => !row.cell.error && row.measured)
  const scoreValues = successful.map((row) => row.score)
  return {
    benchmarkId: benchmarkIdFor(input.adapter),
    family: input.adapter.family ?? 'custom',
    taskKind: input.adapter.taskKind ?? 'custom',
    ...(input.adapter.source ? { source: input.adapter.source } : {}),
    ...(input.adapter.definition
      ? {
          definition: input.adapter.definition,
          definitionDigest: benchmarkDefinitionDigest(input.adapter.definition),
        }
      : {}),
    ...(input.adapter.evaluationRef ? { evaluationRef: input.adapter.evaluationRef } : {}),
    runDir: input.campaign.runDir,
    manifestHash: input.campaign.manifestHash,
    seed: input.campaign.seed,
    startedAt: input.campaign.startedAt,
    endedAt: input.campaign.endedAt,
    durationMs: input.campaign.durationMs,
    totalItems: input.scenarios.length,
    scoreAggregation: 'mean-normalized-score',
    nativeAggregation: 'not-computed',
    totalCells: input.campaign.cells.length,
    cellsMeasured: successful.length,
    cellsUnmeasured: rows.length - successful.length,
    cellsFailed: input.campaign.aggregates.cellsFailed,
    cellsCached: input.campaign.aggregates.cellsCached,
    totalCostUsd: input.campaign.aggregates.cost.totalCostUsd,
    splits: summarizeSlices(successful, (row) => row.scenario?.splitTag ?? 'unknown', [
      'search',
      'dev',
      'holdout',
    ]),
    tags: summarizeSlices(successful, (row) => row.scenario?.tags ?? []),
    dimensions: summarizeDimensions(successful.map((row) => row.dimensions)),
    score: distribution(scoreValues),
    costUsd: distribution(successful.map((row) => row.cell.costUsd)),
    latencyMs: distribution(successful.map((row) => row.cell.durationMs)),
  }
}

function renderBenchmarkReportMarkdown(report: BenchmarkReport): string {
  const splitRows = Object.entries(report.splits)
    .map(([split, summary]) => {
      return `| ${split} | ${summary.n} | ${fmt(summary.meanScore)} | ${fmt(summary.passRate)} | ${fmt(summary.score.p90)} | ${fmt(summary.costUsd.mean)} | ${fmt(summary.latencyMs.p90)} |`
    })
    .join('\n')
  const dimRows = Object.entries(report.dimensions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, dist]) => `| ${key} | ${dist.n} | ${fmt(dist.mean)} | ${fmt(dist.p90)} |`)
    .join('\n')
  return [
    `# Benchmark Report: ${report.benchmarkId}`,
    '',
    `- family: ${report.family}`,
    `- task kind: ${report.taskKind}`,
    `- run dir: ${report.runDir}`,
    `- manifest: ${report.manifestHash}`,
    `- cells: ${report.totalCells} total, ${report.cellsMeasured} measured, ${report.cellsUnmeasured} unmeasured, ${report.cellsFailed} failed, ${report.cellsCached} cached`,
    ...(report.definitionDigest ? [`- definition: ${report.definitionDigest}`] : []),
    `- aggregation: ${report.scoreAggregation}; native aggregation: ${report.nativeAggregation}`,
    `- cost: $${fmt(report.totalCostUsd)}`,
    report.score.n === 0
      ? '- score: unmeasured (n=0)'
      : `- normalized score: mean ${fmt(report.score.mean)}, median ${fmt(report.score.median)}, p90 ${fmt(report.score.p90)}, n=${report.score.n}`,
    '',
    '## Splits',
    '',
    '| split | n | mean score | pass rate | score p90 | mean cost | latency p90 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    splitRows || '| none | 0 | 0 | 0 | 0 | 0 | 0 |',
    '',
    '## Dimensions',
    '',
    '| dimension | n | mean | p90 |',
    '| --- | ---: | ---: | ---: |',
    dimRows || '| none | 0 | 0 | 0 |',
    '',
  ].join('\n')
}

function benchmarkIdFor(adapter: Pick<BenchmarkAdapter, 'id' | 'family' | 'taskKind'>): string {
  return adapter.id ?? `${adapter.family ?? 'custom'}/${adapter.taskKind ?? 'custom'}`
}

function normalizeEvaluationDimensions(evaluation: BenchmarkEvaluation): Record<string, number> {
  const dimensions: Record<string, number> = { score: clamp01(evaluation.score) }
  for (const [key, value] of Object.entries(evaluation.dimensions ?? {})) {
    if (key !== 'score' && key !== 'passed' && Number.isFinite(value)) dimensions[key] = value
  }
  dimensions.passed = (evaluation.passed ?? evaluation.score > 0) ? 1 : 0
  return dimensions
}

function summarizeDimensions(
  rows: Array<Record<string, number>>,
): Record<string, BenchmarkDistribution> {
  const values = new Map<string, number[]>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!Number.isFinite(value)) continue
      const list = values.get(key) ?? []
      list.push(value)
      values.set(key, list)
    }
  }
  return Object.fromEntries([...values.entries()].map(([key, vals]) => [key, distribution(vals)]))
}

function summarizeSlices<T>(
  rows: T[],
  keyOf: (row: T) => string | string[],
  knownKeys: readonly string[] = [],
): Record<string, BenchmarkSliceSummary> {
  const grouped = new Map<string, T[]>()
  for (const key of knownKeys) grouped.set(key, [])
  for (const row of rows) {
    const keys = keyOf(row)
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const list = grouped.get(key) ?? []
      list.push(row)
      grouped.set(key, list)
    }
  }
  const out: Record<string, BenchmarkSliceSummary> = {}
  for (const [key, list] of grouped) {
    const withShape = list as Array<{
      score: number
      passed: boolean
      cell: { costUsd: number; durationMs: number }
    }>
    const scores = withShape.map((row) => row.score).filter(Number.isFinite)
    const passed = withShape.filter((row) => row.passed).length
    out[key] = {
      n: list.length,
      meanScore: scores.length ? mean(scores) : 0,
      passRate: list.length ? passed / list.length : 0,
      score: distribution(scores),
      costUsd: distribution(withShape.map((row) => row.cell.costUsd)),
      latencyMs: distribution(withShape.map((row) => row.cell.durationMs)),
    }
  }
  return out
}

function firstJudgeScore(
  judgeScores: CampaignResult<unknown>['cells'][number]['judgeScores'],
): JudgeScore | undefined {
  return Object.values(judgeScores)[0]
}

function distribution(values: readonly number[]): BenchmarkDistribution {
  const summary = summarizeNumberSeries(values.filter(Number.isFinite))
  if (!summary) return { n: 0, min: 0, mean: 0, median: 0, p90: 0, max: 0 }
  const { n, min, p50: median, p90, max, sum } = summary
  return { n, min, mean: sum / n, median, p90, max }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(value === 0 || Math.abs(value) >= 10 ? 0 : 3)
}
