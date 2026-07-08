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
  cellsFailed: number
  cellsCached: number
  totalCostUsd: number
  splits: Record<string, BenchmarkSliceSummary>
  tags: Record<string, BenchmarkSliceSummary>
  dimensions: Record<string, BenchmarkDistribution>
  score: BenchmarkDistribution
  costUsd: BenchmarkDistribution
  latencyMs: BenchmarkDistribution
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
  const benchmarkId = benchmarkIdFor(options.adapter)
  const scenarios = await loadBenchmarkScenarios(options.adapter, options.splits)
  const judge = benchmarkAdapterJudge(options.adapter)
  const dispatch: DispatchFn<BenchmarkScenario<TPayload>, TArtifact> = async (
    scenario,
    context,
  ) => {
    return options.respond({ scenario, item: scenario.item, context })
  }

  const campaign = await runCampaign<BenchmarkScenario<TPayload>, TArtifact>({
    scenarios,
    dispatch,
    dispatchRef: `benchmark:${benchmarkId}`,
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

export async function loadBenchmarkScenarios<TPayload>(
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

export function benchmarkAdapterJudge<TPayload, TArtifact>(
  adapter: BenchmarkAdapter<BenchmarkDatasetItem<TPayload>, TPayload, TArtifact>,
): JudgeConfig<TArtifact, BenchmarkScenario<TPayload>> {
  const benchmarkId = benchmarkIdFor(adapter)
  return {
    name: `${benchmarkId}:score`,
    dimensions: [
      { key: 'score', description: `Primary ${benchmarkId} benchmark score` },
      { key: 'passed', description: 'Binary pass projection for aggregate reporting' },
    ],
    appliesTo: (scenario: Scenario): scenario is BenchmarkScenario<TPayload> => {
      return scenario.kind === 'benchmark' && scenario.id.startsWith(`${benchmarkId}:`)
    },
    async score({ artifact, scenario }) {
      const evaluation = await adapter.evaluate(scenario.item, artifact)
      const dimensions = normalizeEvaluationDimensions(evaluation)
      return {
        dimensions,
        composite: clamp01(evaluation.score),
        notes: evaluation.notes ?? '',
      }
    },
  }
}

export function summarizeBenchmarkCampaign<TPayload, TArtifact>(input: {
  adapter: BenchmarkAdapter<BenchmarkDatasetItem<TPayload>, TPayload, TArtifact>
  scenarios: Array<BenchmarkScenario<TPayload>>
  campaign: CampaignResult<TArtifact, BenchmarkScenario<TPayload>>
}): BenchmarkReport {
  const scenarioById = new Map(input.scenarios.map((scenario) => [scenario.id, scenario]))
  const rows = input.campaign.cells.map((cell) => {
    const scenario = scenarioById.get(cell.scenarioId)
    const judge = firstJudgeScore(cell.judgeScores)
    const score = judge?.composite ?? 0
    return {
      cell,
      scenario,
      score,
      passed: (judge?.dimensions.passed ?? (score > 0 ? 1 : 0)) >= 1,
      dimensions: judge?.dimensions ?? {},
    }
  })
  const successful = rows.filter((row) => !row.cell.error)
  const scoreValues = successful.map((row) => row.score)
  return {
    benchmarkId: benchmarkIdFor(input.adapter),
    family: input.adapter.family ?? 'custom',
    taskKind: input.adapter.taskKind ?? 'custom',
    ...(input.adapter.source ? { source: input.adapter.source } : {}),
    runDir: input.campaign.runDir,
    manifestHash: input.campaign.manifestHash,
    seed: input.campaign.seed,
    startedAt: input.campaign.startedAt,
    endedAt: input.campaign.endedAt,
    durationMs: input.campaign.durationMs,
    totalItems: input.scenarios.length,
    totalCells: input.campaign.cells.length,
    cellsFailed: input.campaign.aggregates.cellsFailed,
    cellsCached: input.campaign.aggregates.cellsCached,
    totalCostUsd: input.campaign.aggregates.totalCostUsd,
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

export function renderBenchmarkReportMarkdown(report: BenchmarkReport): string {
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
    `- cells: ${report.totalCells} total, ${report.cellsFailed} failed, ${report.cellsCached} cached`,
    `- cost: $${fmt(report.totalCostUsd)}`,
    `- score: mean ${fmt(report.score.mean)}, median ${fmt(report.score.median)}, p90 ${fmt(report.score.p90)}, n=${report.score.n}`,
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
    if (Number.isFinite(value)) dimensions[key] = value
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
    out[key] = {
      n: list.length,
      meanScore: mean(withShape.map((row) => row.score)),
      passRate: mean(withShape.map((row) => (row.passed ? 1 : 0))),
      score: distribution(withShape.map((row) => row.score)),
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
  const finite = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (finite.length === 0) return { n: 0, min: 0, mean: 0, median: 0, p90: 0, max: 0 }
  return {
    n: finite.length,
    min: finite[0]!,
    mean: mean(finite),
    median: percentile(finite, 0.5),
    p90: percentile(finite, 0.9),
    max: finite[finite.length - 1]!,
  }
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(p * sortedValues.length) - 1),
  )
  return sortedValues[index]!
}

function mean(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
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
