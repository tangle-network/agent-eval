import { constants } from 'node:fs'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { resolve } from 'node:path'
import {
  type AnalystBenchmarkResult,
  type AnalystBenchmarkRunner,
  runAnalystBenchmark,
  traceStoreEvidenceResolver,
} from './benchmark'
import { type AnalystRunnerComparison, compareAnalystRunners } from './benchmark-comparison'
import {
  createPublicBenchmarkModelRunner,
  emptyPublicBenchmarkRunner,
  type PublicAnalystBenchmarkDataset,
  type PublicAnalystBenchmarkModelConfig,
  type PublicBenchmarkSelectionReport,
  preparePublicAnalystBenchmark,
} from './benchmark-real-model'
import { renderAnalystBenchmarkMarkdown } from './benchmark-report'
import {
  DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
  type VerificationArtifactManifest,
} from './benchmark-verification-artifacts'
import type { AnalystRunInputs } from './types'

export interface AnalystBenchmarkCommandDependencies {
  createModelRunner?: (
    dataset: PublicAnalystBenchmarkDataset,
    config: PublicAnalystBenchmarkModelConfig,
  ) => AnalystBenchmarkRunner<AnalystRunInputs>
}

interface CommandConfig {
  dataset: PublicAnalystBenchmarkDataset
  labelsPath: string
  traceDir: string
  artifactDir?: string
  outDir: string
  revision: string
  split: string
  model: PublicAnalystBenchmarkModelConfig
  limit: number
  seed: number
  concurrency: number
  repetitions: number
  maxArtifactBytes: number
  command: string
}

interface AnalystBenchmarkArtifact {
  inputs: {
    dataset: PublicAnalystBenchmarkDataset
    datasetRevision: string
    datasetSplit: string
    labelsPath: string
    labelsSha256: string
    sourceRowCount: number
    traceDir: string
    traceFiles: Array<{ traceId: string; path: string; sha256: string }>
    artifactDir?: string
    verificationArtifacts: VerificationArtifactManifest[]
    selection: {
      limit: number
      seed: number
      selectedCaseIds: string[]
      report: PublicBenchmarkSelectionReport
    }
    execution: {
      repetitions: number
      concurrency: number
      model: string
      baseUrl: string
      maxOutputTokens: number
      timeoutMs: number
      maxArtifactBytes: number
    }
  }
  result: AnalystBenchmarkResult
  comparisons: AnalystRunnerComparison[]
}

export async function runAnalystBenchmarkCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AnalystBenchmarkCommandDependencies = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${ANALYST_BENCHMARK_HELP}\n`)
    return 0
  }
  const config = parseCommandConfig(argv, env)
  const resultPath = resolve(config.outDir, 'result.json')
  if (await exists(resultPath)) {
    throw new Error(`refusing to overwrite existing benchmark result: ${resultPath}`)
  }

  const prepared = await preparePublicAnalystBenchmark({
    dataset: config.dataset,
    labelsPath: config.labelsPath,
    traceDir: config.traceDir,
    artifactDir: config.artifactDir,
    maxArtifactBytes: config.maxArtifactBytes,
    limit: config.limit,
    seed: config.seed,
  })
  const createModelRunner =
    dependencies.createModelRunner ??
    ((dataset: PublicAnalystBenchmarkDataset, model: PublicAnalystBenchmarkModelConfig) =>
      createPublicBenchmarkModelRunner(dataset, model))
  const runners = [emptyPublicBenchmarkRunner(), createModelRunner(config.dataset, config.model)]
  const result = await runAnalystBenchmark({
    cases: prepared.cases,
    runners,
    repetitions: config.repetitions,
    maxConcurrency: config.concurrency,
    runnerOrderSeed: config.seed,
    resolveEvidence: traceStoreEvidenceResolver((input) => {
      if (!input.traceStore) throw new Error('benchmark case has no trace store')
      return input.traceStore
    }),
    benchmark: {
      id: `${config.dataset}-real-model-analyst`,
      dataset: {
        id: config.dataset === 'agentrx' ? 'microsoft/AgentRx' : 'NJU-LINK/CodeTraceBench',
        revision: config.revision,
        split: config.split,
      },
      command: config.command,
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
      },
      metadata: {
        model: config.model.model,
        baseUrl: config.model.baseUrl,
        outputAdapter:
          config.dataset === 'agentrx'
            ? 'agentrx-taxonomy-and-root-step'
            : 'codetracebench-incorrect-step',
        caseSelection: prepared.selection.method,
        caseSelectionSeed: config.seed,
        selectionStratified: prepared.selection.stratified,
        selectionRepresentativeOfInput: prepared.selection.representativeOfInput,
      },
    },
  })
  const comparisons = [
    compareAnalystRunners(result, {
      baselineRunnerId: 'empty',
      candidateRunnerId: 'model',
      seed: config.seed,
    }),
  ]
  const artifact: AnalystBenchmarkArtifact = {
    inputs: {
      dataset: config.dataset,
      datasetRevision: config.revision,
      datasetSplit: config.split,
      labelsPath: resolve(config.labelsPath),
      labelsSha256: prepared.labelsSha256,
      sourceRowCount: prepared.sourceRowCount,
      traceDir: resolve(config.traceDir),
      traceFiles: prepared.traceFiles,
      ...(config.artifactDir ? { artifactDir: resolve(config.artifactDir) } : {}),
      verificationArtifacts: prepared.verificationArtifacts,
      selection: {
        limit: config.limit,
        seed: config.seed,
        selectedCaseIds: prepared.selectedCaseIds,
        report: prepared.selection,
      },
      execution: {
        repetitions: config.repetitions,
        concurrency: config.concurrency,
        model: config.model.model,
        baseUrl: config.model.baseUrl,
        maxOutputTokens: config.model.maxOutputTokens,
        timeoutMs: config.model.timeoutMs,
        maxArtifactBytes: config.maxArtifactBytes,
      },
    },
    result,
    comparisons,
  }

  await writeArtifacts(
    config.outDir,
    artifact,
    `${renderAnalystBenchmarkMarkdown(result, comparisons).trimEnd()}\n\n${renderSelectionMarkdown(prepared.selection)}\n`,
  )
  const modelSummary = result.summaries.find((summary) => summary.runnerId === 'model')
  return modelSummary?.failedRuns ? 2 : 0
}

export const ANALYST_BENCHMARK_HELP = `agent-eval analyst-benchmark

Run a real-model trace analyst against public AgentRx or CodeTraceBench labels.

Required:
  --dataset agentrx|codetracebench
  --labels <dataset.json|dataset.jsonl>
  --trace-dir <one-trace-per-file OTLP JSONL directory>
  --artifact-dir <extracted artifact root>  Required for CodeTraceBench
  --out <new output directory>
  --revision <immutable dataset revision or digest>
  --split <dataset split>
  --base-url <OpenAI-compatible /v1 URL>
  --api-key-env <environment variable containing the bearer>
  --model <provider model id>
  --limit <positive case count>

Controls:
  --seed <integer>                 Case-selection and comparison seed. Default: 0
  --concurrency <positive integer> Parallel benchmark jobs. Default: 1
  --repetitions <positive integer> Runs per case and runner. Default: 1
  --max-output-tokens <positive>   Model output limit per call. Default: 4096
  --timeout-ms <positive>          Model analyst deadline per case. Default: 300000
  --max-artifact-bytes <positive>  Final evidence bytes per case. Default: 2097152

Writes result.json with every observation, metric, usage field, error, comparison,
input digest, artifact digest, case distribution, selected case id, and explicit
unknown cost. Limited deterministic-hash subsets are marked non-representative.
Also writes report.md.
The key is read from the named environment variable and is never written.`

function parseCommandConfig(argv: readonly string[], env: NodeJS.ProcessEnv): CommandConfig {
  const flags = parseFlags(argv)
  assertKnownFlags(flags)
  const dataset = requiredFlag(flags, 'dataset')
  if (dataset !== 'agentrx' && dataset !== 'codetracebench') {
    throw new Error("--dataset must be 'agentrx' or 'codetracebench'")
  }
  const artifactDir = flags.get('artifact-dir')?.trim()
  if (dataset === 'codetracebench' && !artifactDir) {
    throw new Error('--artifact-dir is required for CodeTraceBench')
  }
  const apiKeyEnv = requiredFlag(flags, 'api-key-env')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error('--api-key-env must be a valid environment variable name')
  }
  const apiKey = env[apiKeyEnv]?.trim()
  if (!apiKey) {
    throw new Error(`--api-key-env points to an empty or missing variable: ${apiKeyEnv}`)
  }

  return {
    dataset,
    labelsPath: requiredFlag(flags, 'labels'),
    traceDir: requiredFlag(flags, 'trace-dir'),
    ...(artifactDir ? { artifactDir } : {}),
    outDir: requiredFlag(flags, 'out'),
    revision: requiredFlag(flags, 'revision'),
    split: requiredFlag(flags, 'split'),
    model: {
      baseUrl: openAiCompatibleBaseUrl(requiredFlag(flags, 'base-url')),
      apiKey,
      model: requiredFlag(flags, 'model'),
      maxOutputTokens: positiveFlag(flags, 'max-output-tokens', 4_096),
      timeoutMs: positiveFlag(flags, 'timeout-ms', 300_000),
    },
    limit: positiveFlag(flags, 'limit'),
    seed: integerFlag(flags, 'seed', 0),
    concurrency: positiveFlag(flags, 'concurrency', 1),
    repetitions: positiveFlag(flags, 'repetitions', 1),
    maxArtifactBytes: positiveFlag(
      flags,
      'max-artifact-bytes',
      DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
    ),
    command: `agent-eval analyst-benchmark ${argv.map(shellQuote).join(' ')}`,
  }
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`)
    const raw = token.slice(2)
    const equalsAt = raw.indexOf('=')
    const name = equalsAt < 0 ? raw : raw.slice(0, equalsAt)
    const inlineValue = equalsAt < 0 ? undefined : raw.slice(equalsAt + 1)
    if (!name || flags.has(name)) throw new Error(`duplicate or empty flag: --${name}`)
    const value = inlineValue ?? argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
    flags.set(name, value)
  }
  return flags
}

const KNOWN_FLAGS = new Set([
  'dataset',
  'labels',
  'trace-dir',
  'artifact-dir',
  'out',
  'revision',
  'split',
  'base-url',
  'api-key-env',
  'model',
  'limit',
  'seed',
  'concurrency',
  'repetitions',
  'max-output-tokens',
  'timeout-ms',
  'max-artifact-bytes',
])

function assertKnownFlags(flags: ReadonlyMap<string, string>): void {
  for (const flag of flags.keys()) {
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`unknown analyst-benchmark flag: --${flag}`)
  }
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name)?.trim()
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function positiveFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  defaultValue?: number,
): number {
  const raw = flags.get(name)
  if (raw === undefined && defaultValue !== undefined) return defaultValue
  if (raw === undefined) throw new Error(`--${name} is required`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive safe integer`)
  }
  return value
}

function integerFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  defaultValue: number,
): number {
  const raw = flags.get(name)
  if (raw === undefined) return defaultValue
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be a safe integer`)
  return value
}

function openAiCompatibleBaseUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('--base-url must be an absolute HTTP or HTTPS URL')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('--base-url must use HTTP or HTTPS without credentials, query, or fragment')
  }
  return value
}

function renderSelectionMarkdown(report: PublicBenchmarkSelectionReport): string {
  const rows = (['class', 'agent', 'model', 'difficulty', 'solved'] as const).map((dimension) => {
    const source = report.source[dimension]
    const selected = report.selected[dimension]
    return `| ${dimension} | ${distributionText(source.counts, source.missing, source.total)} | ${distributionText(selected.counts, selected.missing, selected.total)} |`
  })
  return [
    '## Case Selection',
    '',
    `Method: \`${report.method}\`; seed: \`${report.seed}\`; selected: ${report.selectedCount}/${report.sourceCount}.`,
    report.representativeOfInput
      ? 'This is a census of the supplied input.'
      : 'This deterministic hash subset is not stratified and must not be presented as representative.',
    '',
    '| Dimension | Supplied input | Selected cases |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
}

function distributionText(
  counts: Readonly<Record<string, number>>,
  missing: number,
  total: number,
): string {
  const values = Object.entries(counts).map(([value, count]) => `${value}=${count}`)
  if (missing > 0) values.push(`missing=${missing}`)
  return `${values.join(', ') || 'none'} (n=${total})`
}

async function writeArtifacts(
  outDir: string,
  artifact: AnalystBenchmarkArtifact,
  markdown: string,
): Promise<void> {
  const target = resolve(outDir)
  await mkdir(target, { recursive: true })
  await atomicWrite(resolve(target, 'report.md'), markdown)
  await atomicWrite(resolve(target, 'result.json'), `${JSON.stringify(artifact, null, 2)}\n`)
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}
