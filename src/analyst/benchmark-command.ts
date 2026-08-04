import { arch, platform } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireSingleRunLock } from '../campaign/single-run-lock'
import { createRunCostLedger, fsCampaignStorage } from '../campaign/storage'
import {
  CostAccountingIncompleteError,
  type CostLedger,
  type CostLedgerSummary,
} from '../cost-ledger'
import { resolveModelPricing } from '../metrics'
import {
  type AnalystBenchmarkObservation,
  type AnalystBenchmarkResult,
  type AnalystBenchmarkRunner,
  runAnalystBenchmark,
  traceStoreEvidenceResolver,
} from './benchmark'
import {
  AGENT_RX_UPSTREAM_REVISION,
  renderAgentRxCalibrationMarkdown,
  summarizeAgentRxCalibration,
} from './benchmark-agentrx-calibration'
import type {
  AnalystBenchmarkArtifact,
  VerificationAvailabilitySummary,
} from './benchmark-command-artifact'
import { digestCanonical } from './benchmark-command-artifact'
import {
  type AnalystBenchmarkOutputPaths,
  createLocalRunReceipt,
  createObservationAppender,
  createRunIdentity,
  initializeRunFiles,
  openOutputDirectory,
  prepareOutputLockPath,
  readAndValidateResumeFiles,
  readProgress,
  regularFileExists,
  writeExclusiveOrVerify,
} from './benchmark-command-persistence'
import {
  assertCompletedArtifactMatchesRun,
  assertSameObservations,
  readAnalystBenchmarkArtifact,
} from './benchmark-command-result'
import { compareAnalystRunners } from './benchmark-comparison'
import {
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
  ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
} from './benchmark-implementation'
import {
  effectiveAnalystProtocolSha256,
  readAnalystInstructionsOverride,
} from './benchmark-instructions-override'
import {
  renderCodeTraceCalibrationMarkdown,
  summarizeCodeTraceCalibration,
} from './benchmark-public-calibration'
import { createPublicBenchmarkDirectRunner } from './benchmark-public-model'
import { createPublicBenchmarkRlmRunner } from './benchmark-public-rlm'
import {
  emptyPublicBenchmarkRunner,
  type PublicAnalystBenchmarkDataset,
  type PublicAnalystBenchmarkModelConfig,
  type PublicAnalystBenchmarkModelOwner,
  type PublicBenchmarkSelectionReport,
  preparePublicAnalystBenchmark,
} from './benchmark-real-model'
import { renderAnalystBenchmarkMarkdown } from './benchmark-report'
import {
  DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
  type VerificationArtifactManifest,
} from './benchmark-verification-artifacts'
import type { AnalystRunInputs } from './types'

export {
  ANALYST_BENCHMARK_COST_LEDGER_FILE,
  ANALYST_BENCHMARK_LOCAL_RECEIPT_FILE,
  ANALYST_BENCHMARK_MANIFEST_FILE,
  ANALYST_BENCHMARK_OBSERVATIONS_FILE,
  type AnalystBenchmarkArtifact,
  type AnalystBenchmarkLocalRunReceipt,
  type AnalystBenchmarkProgressRow,
  type AnalystBenchmarkRunIdentity,
  type AnalystBenchmarkRunManifest,
  type VerificationAvailabilitySummary,
} from './benchmark-command-artifact'
export { readAnalystBenchmarkArtifact } from './benchmark-command-result'

export interface AnalystBenchmarkCommandDependencies {
  createAnalystRunner?: (
    dataset: PublicAnalystBenchmarkDataset,
    config: PublicAnalystBenchmarkModelConfig,
  ) => AnalystBenchmarkRunner<AnalystRunInputs>
  loadModelExecutionOwner?: (
    moduleRef: string,
    context: {
      model: string
      environment: Readonly<NodeJS.ProcessEnv>
    },
  ) => Promise<PublicAnalystBenchmarkModelOwner>
}

/**
 * Which analyst produces the scored arm.
 *
 * `dspy-rlm` is the recursive engine. `direct` is the one-shot comparison arm.
 */
export type AnalystBenchmarkRunnerKind = 'dspy-rlm' | 'direct'

export interface AnalystBenchmarkCommandConfig {
  dataset: PublicAnalystBenchmarkDataset
  analyst: AnalystBenchmarkRunnerKind
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
  /** Recursive-engine runs per case; above 1 the consensus is scored. */
  rlmSamples: number
  maxCostUsd: number
  maxArtifactBytes: number
  modelOwnerModule: string
  command: string
  resume: boolean
}

export { AGENT_RX_UPSTREAM_REVISION } from './benchmark-agentrx-calibration'

export async function runAnalystBenchmarkCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AnalystBenchmarkCommandDependencies = {},
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${ANALYST_BENCHMARK_HELP}\n`)
    return 0
  }
  const config = await parseCommandConfig(argv, env, dependencies)
  const outputLock = acquireSingleRunLock({
    lockPath: await prepareOutputLockPath(config.outDir),
  })
  try {
    return await executeAnalystBenchmarkCommand(config, dependencies)
  } finally {
    outputLock.release()
  }
}

async function executeAnalystBenchmarkCommand(
  config: AnalystBenchmarkCommandConfig,
  dependencies: AnalystBenchmarkCommandDependencies,
): Promise<number> {
  const paths = await openOutputDirectory(config.outDir, config.resume)

  const prepared = await preparePublicAnalystBenchmark({
    dataset: config.dataset,
    labelsPath: config.labelsPath,
    traceDir: config.traceDir,
    artifactDir: config.artifactDir,
    maxArtifactBytes: config.maxArtifactBytes,
    limit: config.limit,
    seed: config.seed,
  })
  const identity = createRunIdentity(config, prepared)
  const localReceipt = createLocalRunReceipt(config, paths)
  const localIdentitySha256 = digestCanonical(localReceipt.local)
  const identitySha256 = digestCanonical(identity)
  const manifest = config.resume
    ? await readAndValidateResumeFiles(
        paths,
        identity,
        identitySha256,
        localIdentitySha256,
        localReceipt,
      )
    : await initializeRunFiles(paths, identity, identitySha256, localIdentitySha256, localReceipt)
  const progress = await readProgress(
    paths.observations,
    manifest.identitySha256,
    prepared.selectedCaseIds,
    config.repetitions,
    config.analyst,
  )
  const costLedger = createRunCostLedger({
    storage: fsCampaignStorage(),
    runDir: paths.directory,
    costCeilingUsd: config.maxCostUsd,
  })

  if (await regularFileExists(paths.result)) {
    assertCostLedgerFinalizable(costLedger)
    const artifact = await readAnalystBenchmarkArtifact(paths.result)
    assertCompletedArtifactMatchesRun(artifact, manifest, progress.observations, prepared)
    const markdown = renderArtifactMarkdown(artifact)
    await writeExclusiveOrVerify(paths.report, markdown)
    printSuccessSummary(artifact, paths)
    return benchmarkExitCode(artifact.result, config.analyst)
  }
  if (await regularFileExists(paths.report)) {
    throw new Error(
      `benchmark report exists without a completed result; refusing ambiguous resume: ${paths.report}`,
    )
  }

  const createAnalystRunner =
    dependencies.createAnalystRunner ??
    ((dataset: PublicAnalystBenchmarkDataset, model: PublicAnalystBenchmarkModelConfig) =>
      config.analyst === 'direct'
        ? createPublicBenchmarkDirectRunner(dataset, model)
        : createPublicBenchmarkRlmRunner(dataset, model))
  const runners = [
    emptyPublicBenchmarkRunner(),
    createAnalystRunner(config.dataset, {
      ...config.model,
      costLedger,
      durability: {
        runIdentitySha256: manifest.identitySha256,
        responseCacheDir: paths.modelResponses,
      },
    }),
  ]
  const appendObservation = createObservationAppender(
    paths.observations,
    manifest.identitySha256,
    progress,
  )
  const runAbort = new AbortController()
  let result: AnalystBenchmarkResult
  try {
    result = await runAnalystBenchmark({
      cases: prepared.cases,
      runners,
      repetitions: config.repetitions,
      maxConcurrency: config.concurrency,
      runnerOrderSeed: config.seed,
      initialObservations: progress.observations,
      signal: runAbort.signal,
      onObservation: async (observation) => {
        assertObservationAccountingComplete(observation, costLedger, config.analyst)
        await appendObservation(observation)
      },
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
        environment: {
          node: process.version,
          platform: platform(),
          arch: arch(),
        },
        metadata: {
          model: config.model.model,
          modelOwnerCallRef: config.model.callRef,
          rlmSamples: config.rlmSamples,
          outputAdapter:
            config.dataset === 'agentrx'
              ? 'agentrx-taxonomy-and-root-step'
              : 'codetracebench-incorrect-block',
          caseSelection: prepared.selection.method,
          caseSelectionSeed: config.seed,
          selectionStratified: prepared.selection.stratified,
          protocolSha256: effectiveAnalystProtocolSha256(
            config.dataset,
            config.model.instructionsOverride,
          ),
          implementationSha256: ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
          dependencyLockSha256: ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
          populationRepresentativenessProven: false,
        },
      },
    })
  } catch (error) {
    runAbort.abort(error)
    const idle = await costLedger.waitForIdle({
      timeoutMs: Math.min(config.model.timeoutMs, 10_000),
    })
    if (!idle) {
      throw accountingError(costLedger, 'provider calls remain unresolved after cancellation')
    }
    throw error
  }
  assertCostLedgerFinalizable(costLedger)
  result.provenance.startedAt = manifest.createdAt
  const persisted = await readProgress(
    paths.observations,
    manifest.identitySha256,
    prepared.selectedCaseIds,
    config.repetitions,
    config.analyst,
  )
  assertSameObservations(result.observations, persisted.observations)
  const comparisons = [
    compareAnalystRunners(result, {
      baselineRunnerId: 'empty',
      candidateRunnerId: config.analyst,
      seed: config.seed,
    }),
  ]
  const codeTraceCalibration =
    config.dataset === 'codetracebench' ? summarizeCodeTraceCalibration(result) : undefined
  const agentRxCalibration =
    config.dataset === 'agentrx'
      ? summarizeAgentRxCalibration(result, AGENT_RX_UPSTREAM_REVISION)
      : undefined
  const artifact: AnalystBenchmarkArtifact = {
    kind: 'agent-eval/analyst-benchmark-result',
    runIdentitySha256: manifest.identitySha256,
    inputs: {
      dataset: config.dataset,
      datasetRevision: config.revision,
      datasetSplit: config.split,
      labelsSha256: prepared.labelsSha256,
      sourceRowCount: prepared.sourceRowCount,
      traceFiles: prepared.traceFiles,
      verificationArtifacts: prepared.verificationArtifacts,
      verificationAvailability: summarizeVerificationAvailability(prepared.verificationArtifacts),
      selection: {
        limit: config.limit,
        seed: config.seed,
        selectedCaseIds: prepared.selectedCaseIds,
        report: prepared.selection,
      },
      execution: {
        repetitions: config.repetitions,
        concurrency: config.concurrency,
        rlmSamples: config.rlmSamples,
        model: config.model.model,
        modelOwnerCallRef: manifest.identity.config.model.ownerCallRef,
        maxOutputTokens: manifest.identity.config.model.maxOutputTokens,
        maxReasoningTokens: manifest.identity.config.model.maxReasoningTokens,
        maxModelRequestBytes: manifest.identity.config.model.maxRequestBytes,
        maxModelResponseBytes: manifest.identity.config.model.maxResponseBytes,
        modelRequestTimeoutMs: manifest.identity.config.model.requestTimeoutMs,
        timeoutMs: manifest.identity.config.model.timeoutMs,
        pricing: manifest.identity.config.model.pricing,
        recursiveLimits: manifest.identity.config.model.recursiveLimits,
        processLimits: manifest.identity.config.model.processLimits,
        maxCostUsd: config.maxCostUsd,
        maxArtifactBytes: config.maxArtifactBytes,
        analystProtocolSha256: effectiveAnalystProtocolSha256(
          config.dataset,
          config.model.instructionsOverride,
        ),
        ...(config.model.instructionsOverride
          ? { instructionsOverrideSha256: config.model.instructionsOverride.sha256 }
          : {}),
        implementationSha256: ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
        dependencyLockSha256: ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
      },
    },
    result,
    comparisons,
    ...(codeTraceCalibration ? { codeTraceCalibration } : {}),
    ...(agentRxCalibration ? { agentRxCalibration } : {}),
  }

  const markdown = renderArtifactMarkdown(artifact)
  await writeExclusiveOrVerify(paths.result, `${JSON.stringify(artifact, null, 2)}\n`)
  await writeExclusiveOrVerify(paths.report, markdown)
  printSuccessSummary(artifact, paths)
  return benchmarkExitCode(result, config.analyst)
}

const NON_SCORABLE_COST_ERRORS = new Set([
  'CostAccountingIncompleteError',
  'CostCallConflictError',
  'CostCeilingReachedError',
  'CostLedgerPersistenceError',
  'CostReceiptCaptureError',
  'CostReservationExceededError',
])

function assertObservationAccountingComplete(
  observation: AnalystBenchmarkObservation,
  costLedger: CostLedger,
  analystRunnerId: string,
): void {
  if (observation.error && NON_SCORABLE_COST_ERRORS.has(observation.error.class)) {
    throw new CostAccountingIncompleteError(
      `Analyst benchmark stopped before scoring: ${observation.error.message}`,
    )
  }
  if (observation.runnerId !== analystRunnerId) return
  const filter = {
    channel: 'analyst' as const,
    tags: {
      benchmarkCaseId: observation.caseId,
      benchmarkRepetition: String(observation.repetition),
    },
  }
  const summary = costLedger.summary(filter)
  // Every settled call is honestly accounted: a known cost is summed, and a
  // provider response that omitted usage is flagged and excluded from the
  // reported total. Neither invalidates a run, whether the case succeeded or
  // failed. Only a call left pending, one lost, or one charged beyond its
  // maximum leaves the cost genuinely unknowable, and those still halt.
  if (!costAccountingIsTrustworthy(summary)) {
    throw accountingError(
      costLedger,
      'the recursive analyst has incomplete cost accounting',
      filter,
    )
  }
}

const BUDGET_BREACH_REASON = /exceeding its enforced maximum/

/**
 * Cost accounting is trustworthy when every call resolved and none breached its
 * budget. A recursive analyst on a real provider will occasionally receive a
 * settled response whose usage the provider omitted; that call is honestly
 * recorded as unknown and excluded from the reported cost, so it does not
 * invalidate a completed run. A call left pending, one lost, or one charged
 * beyond its maximum is a genuine integrity failure and still halts.
 */
function costAccountingIsTrustworthy(summary: CostLedgerSummary): boolean {
  if (summary.pendingCalls > 0 || summary.unresolvedCalls > 0) return false
  return !summary.incompleteReasons.some((reason) => BUDGET_BREACH_REASON.test(reason))
}

function assertCostLedgerFinalizable(costLedger: CostLedger): void {
  const summary = costLedger.summary()
  if (!costAccountingIsTrustworthy(summary)) {
    throw accountingError(costLedger, 'the run has pending or budget-breaching cost entries')
  }
}

function accountingError(
  costLedger: CostLedger,
  reason: string,
  filter?: Parameters<CostLedger['summary']>[0],
): CostAccountingIncompleteError {
  const summary = costLedger.summary(filter)
  const details = summary.incompleteReasons.slice(0, 3).join('; ')
  return new CostAccountingIncompleteError(
    `Analyst benchmark cannot continue because ${reason}${details ? `: ${details}` : ''}`,
  )
}

export const ANALYST_BENCHMARK_HELP = `agent-eval analyst-benchmark

Run the recursive DSPy trace analyst against public AgentRx or CodeTraceBench labels.

Required:
  --dataset agentrx|codetracebench
  --analyst dspy-rlm|direct        Scored analyst. Default: dspy-rlm.
                                   'direct' is the one-shot comparison arm.
  --labels <dataset.json|dataset.jsonl>
  --trace-dir <one-trace-per-file OTLP JSONL directory>
  --artifact-dir <extracted artifact root>  Required for CodeTraceBench
  --out <new output directory>
  --revision <full 40- or 64-character hex digest>
  --split <dataset split>
  --model-owner-module <module>   Module exporting createModelExecutionOwner;
                                   the owner keeps provider credentials and policy
  --model <provider model id>
  --limit <positive case count>

Controls:
  --resume                         Continue an interrupted run in --out
  --seed <integer>                 Case-selection and comparison seed. Default: 0
  --concurrency <positive integer> Parallel benchmark jobs. Default: 1
  --repetitions <positive integer> Runs per case and runner. Default: 1
  --rlm-samples <positive integer> Recursive-engine runs per case; above 1 the
                                   step-level majority consensus is scored
                                   (CodeTraceBench + dspy-rlm only). Default: 1
  --instructions-file <path>       Replace the recursive analyst instructions
                                   with this file's text (dspy-rlm only). The
                                   recorded protocol digest binds the stock
                                   protocol to the override text, and
                                   result.json records instructionsOverrideSha256.
  --max-output-tokens <positive>   Model output limit per call. Default: 16384
  --max-reasoning-tokens <integer> Reasoning-token limit per call. Default: 65536
  --max-model-requests <positive>  Caller-owned model calls per analysis.
                                   Default: max iterations + model calls + 1
  --max-model-request-bytes <positive>   Default: 16777216
  --max-model-response-bytes <positive>  Default: 4194304
  --model-request-timeout-ms <positive>  Default: --timeout-ms
  --max-iterations <positive>      Recursive iterations per analysis. Default: 14
  --max-llm-calls <positive>       DSPy model calls per analysis. Default: 8
  --max-tool-calls <positive>      Trace-tool calls per analysis. Default: 80
  --max-analysis-output-chars <positive> Default: 8000
  --trace-tool-request-bytes <positive>  Default: 1000000
  --trace-tool-response-bytes <positive> Default: 4000000
  --trace-tool-timeout-ms <positive>     Default: 60000
  --max-process-input-bytes <positive>   Default: 67108864
  --max-process-result-bytes <positive>  Default: 4194304
  --max-process-output-chars <positive>  Default: 64000
  --python <executable>             Python with agent-eval-rpc[dspy]. Default: python
  --timeout-ms <positive>          Model analyst deadline per case. Default: 300000
  --max-cost-usd <positive>        Run-wide spend limit. Default: 5
  --max-artifact-bytes <positive>  Final evidence bytes per case. Default: ${DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES}

Writes result.json with every observation, metric, usage field, error, comparison,
input digest, artifact digest, case distribution, selected case id, and explicit
unknown cost. Limited deterministic-hash subsets are marked non-representative.
Completed observations are fsynced to observations.jsonl. Shareable output is in
result.json and report.md. Machine-local paths, execution-owner module, and command
are isolated in run.local.json. Provider credentials never enter this command.`

async function parseCommandConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: AnalystBenchmarkCommandDependencies,
): Promise<AnalystBenchmarkCommandConfig> {
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
  const maxCostUsd = positiveFiniteFlag(flags, 'max-cost-usd', 5)
  const python = flags.get('python')?.trim()
  const analyst = flags.get('analyst')?.trim() ?? 'dspy-rlm'
  if (analyst !== 'dspy-rlm' && analyst !== 'direct') {
    throw new Error("--analyst must be 'dspy-rlm' or 'direct'")
  }
  const rlmSamples = positiveFlag(flags, 'rlm-samples', 1)
  if (rlmSamples > 1 && analyst !== 'dspy-rlm') {
    throw new Error('--rlm-samples above 1 requires --analyst dspy-rlm')
  }
  const instructionsFile = flags.get('instructions-file')?.trim()
  if (instructionsFile && analyst !== 'dspy-rlm') {
    throw new Error('--instructions-file requires --analyst dspy-rlm')
  }
  const instructionsOverride = instructionsFile
    ? readAnalystInstructionsOverride(instructionsFile)
    : undefined
  if (rlmSamples > 1 && dataset !== 'codetracebench') {
    throw new Error(
      '--rlm-samples above 1 requires --dataset codetracebench; step-level consensus is defined on its block grammar',
    )
  }
  const model = requiredFlag(flags, 'model')
  const modelOwnerModule = requiredFlag(flags, 'model-owner-module')
  const owner = await (dependencies.loadModelExecutionOwner ?? loadModelExecutionOwner)(
    modelOwnerModule,
    {
      model,
      environment: Object.freeze({ ...env }),
    },
  )
  assertModelExecutionOwner(owner)
  const pricing = owner.pricing ?? benchmarkModelPricing(model)
  const maxOutputTokens = positiveFlag(flags, 'max-output-tokens', 16_384)
  const timeoutMs = positiveFlag(flags, 'timeout-ms', 300_000)
  return {
    dataset,
    analyst,
    labelsPath: requiredFlag(flags, 'labels'),
    traceDir: requiredFlag(flags, 'trace-dir'),
    ...(artifactDir ? { artifactDir } : {}),
    outDir: requiredFlag(flags, 'out'),
    revision: immutableRevision(requiredFlag(flags, 'revision')),
    split: requiredFlag(flags, 'split'),
    model: {
      call: owner.call,
      callRef: owner.callRef,
      recordExecution: owner.recordExecution,
      model,
      maxOutputTokens,
      timeoutMs,
      maxReasoningTokens: nonNegativeFlag(flags, 'max-reasoning-tokens', maxOutputTokens * 4),
      maxModelRequestBytes: positiveFlag(flags, 'max-model-request-bytes', 16 * 1024 * 1024),
      maxModelResponseBytes: positiveFlag(flags, 'max-model-response-bytes', 4 * 1024 * 1024),
      modelRequestTimeoutMs: positiveFlag(flags, 'model-request-timeout-ms', timeoutMs),
      pricing,
      maxCostUsdPerAnalysis: maxCostUsd,
      ...(instructionsOverride ? { instructionsOverride } : {}),
      dspyRlm: {
        runner: {
          ...(python ? { command: python } : {}),
          limits: {
            maxInputBytes: positiveFlag(flags, 'max-process-input-bytes', 64 * 1024 * 1024),
            maxResultBytes: positiveFlag(flags, 'max-process-result-bytes', 4 * 1024 * 1024),
            maxOutputChars: positiveFlag(flags, 'max-process-output-chars', 64_000),
          },
        },
        maxIterations: positiveFlag(flags, 'max-iterations', 14),
        maxLlmCalls: positiveFlag(flags, 'max-llm-calls', 8),
        maxToolCalls: positiveFlag(flags, 'max-tool-calls', 80),
        maxOutputChars: positiveFlag(flags, 'max-analysis-output-chars', 8_000),
        ...(flags.has('max-model-requests')
          ? { maxModelRequests: positiveFlag(flags, 'max-model-requests') }
          : {}),
        traceToolRequestBytes: positiveFlag(flags, 'trace-tool-request-bytes', 1_000_000),
        traceToolResponseBytes: positiveFlag(flags, 'trace-tool-response-bytes', 4_000_000),
        traceToolTimeoutMs: positiveFlag(flags, 'trace-tool-timeout-ms', 60_000),
        samples: rlmSamples,
      },
    },
    limit: positiveFlag(flags, 'limit'),
    seed: integerFlag(flags, 'seed', 0),
    concurrency: positiveFlag(flags, 'concurrency', 1),
    repetitions: positiveFlag(flags, 'repetitions', 1),
    rlmSamples,
    maxCostUsd,
    maxArtifactBytes: positiveFlag(
      flags,
      'max-artifact-bytes',
      DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
    ),
    modelOwnerModule,
    command: `agent-eval analyst-benchmark ${argv
      .filter((argument) => argument !== '--resume')
      .map(shellQuote)
      .join(' ')}`,
    resume: flags.has('resume'),
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
    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== undefined) throw new Error(`--${name} does not accept a value`)
      flags.set(name, 'true')
      continue
    }
    const value = inlineValue ?? argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
    flags.set(name, value)
  }
  return flags
}

const KNOWN_FLAGS = new Set([
  'resume',
  'dataset',
  'analyst',
  'labels',
  'trace-dir',
  'artifact-dir',
  'out',
  'revision',
  'split',
  'model-owner-module',
  'model',
  'limit',
  'seed',
  'concurrency',
  'repetitions',
  'rlm-samples',
  'instructions-file',
  'max-output-tokens',
  'max-reasoning-tokens',
  'max-model-requests',
  'max-model-request-bytes',
  'max-model-response-bytes',
  'model-request-timeout-ms',
  'max-iterations',
  'max-llm-calls',
  'max-tool-calls',
  'max-analysis-output-chars',
  'trace-tool-request-bytes',
  'trace-tool-response-bytes',
  'trace-tool-timeout-ms',
  'max-process-input-bytes',
  'max-process-result-bytes',
  'max-process-output-chars',
  'python',
  'timeout-ms',
  'max-cost-usd',
  'max-artifact-bytes',
])

const BOOLEAN_FLAGS = new Set(['resume'])

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

function nonNegativeFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  defaultValue: number,
): number {
  const raw = flags.get(name)
  if (raw === undefined) return defaultValue
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative safe integer`)
  }
  return value
}

function positiveFiniteFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  defaultValue: number,
): number {
  const raw = flags.get(name)
  if (raw === undefined) return defaultValue
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive finite number`)
  }
  return value
}

async function loadModelExecutionOwner(
  moduleRef: string,
  context: { model: string; environment: Readonly<NodeJS.ProcessEnv> },
): Promise<PublicAnalystBenchmarkModelOwner> {
  const specifier =
    moduleRef.startsWith('.') || moduleRef.startsWith('/')
      ? pathToFileURL(resolve(moduleRef)).href
      : moduleRef
  const imported = (await import(specifier)) as {
    createModelExecutionOwner?: (value: {
      model: string
      environment: Readonly<NodeJS.ProcessEnv>
    }) => PublicAnalystBenchmarkModelOwner | Promise<PublicAnalystBenchmarkModelOwner>
  }
  if (typeof imported.createModelExecutionOwner !== 'function') {
    throw new Error(`${moduleRef} must export createModelExecutionOwner({ model, environment })`)
  }
  return imported.createModelExecutionOwner(context)
}

function assertModelExecutionOwner(value: PublicAnalystBenchmarkModelOwner): void {
  if (!value || typeof value !== 'object') {
    throw new Error('createModelExecutionOwner must return an object')
  }
  if (typeof value.call !== 'function') {
    throw new Error('model execution owner call must be a function')
  }
  if (
    typeof value.callRef !== 'string' ||
    !value.callRef.trim() ||
    value.callRef !== value.callRef.trim()
  ) {
    throw new Error('model execution owner callRef must be trimmed and non-empty')
  }
  if (typeof value.recordExecution !== 'function') {
    throw new Error('model execution owner recordExecution must be a function')
  }
}

function benchmarkModelPricing(
  model: string,
): NonNullable<PublicAnalystBenchmarkModelConfig['pricing']> {
  const pricing = resolveModelPricing(model)
  if (!pricing) {
    throw new Error(`model execution owner must supply pricing for uncatalogued model '${model}'`)
  }
  return {
    inputUsdPerMillion: pricing.input * 1_000,
    outputUsdPerMillion: pricing.output * 1_000,
  }
}

function immutableRevision(value: string): string {
  if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value)) {
    throw new Error('--revision must be a full 40- or 64-character hexadecimal digest')
  }
  return value.toLowerCase()
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

function summarizeVerificationAvailability(
  manifests: readonly VerificationArtifactManifest[],
): VerificationAvailabilitySummary {
  return {
    cases: manifests.length,
    resultFilesPresent: manifests.filter((manifest) => manifest.status === 'present').length,
    resultFilesMissing: manifests.filter((manifest) => manifest.status === 'missing').length,
    outcomes: {
      passed: manifests.filter((manifest) => manifest.outcome.status === 'passed').length,
      failed: manifests.filter((manifest) => manifest.outcome.status === 'failed').length,
      unavailable: manifests.filter((manifest) => manifest.outcome.status === 'unavailable').length,
    },
  }
}

function renderVerificationAvailability(summary: VerificationAvailabilitySummary): string {
  return [
    '## Final Verification Availability',
    '',
    '| Cases | Result files present | Result files missing | Passed | Failed | Unavailable |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${summary.cases} | ${summary.resultFilesPresent} | ${summary.resultFilesMissing} | ${summary.outcomes.passed} | ${summary.outcomes.failed} | ${summary.outcomes.unavailable} |`,
  ].join('\n')
}

function renderArtifactMarkdown(artifact: AnalystBenchmarkArtifact): string {
  const calibrationMarkdown = artifact.codeTraceCalibration
    ? `\n\n${renderCodeTraceCalibrationMarkdown(artifact.codeTraceCalibration)}`
    : artifact.agentRxCalibration
      ? `\n\n${renderAgentRxCalibrationMarkdown(artifact.agentRxCalibration)}`
      : ''
  const verificationMarkdown =
    artifact.inputs.dataset === 'codetracebench'
      ? `\n\n${renderVerificationAvailability(artifact.inputs.verificationAvailability)}`
      : ''
  return `${renderAnalystBenchmarkMarkdown(artifact.result, artifact.comparisons).trimEnd()}${calibrationMarkdown}${verificationMarkdown}\n\n${renderSelectionMarkdown(artifact.inputs.selection.report)}\n`
}

function benchmarkExitCode(result: AnalystBenchmarkResult, analystRunnerId: string): number {
  return result.summaries.find((summary) => summary.runnerId === analystRunnerId)?.failedRuns
    ? 2
    : 0
}

function printSuccessSummary(
  artifact: AnalystBenchmarkArtifact,
  paths: AnalystBenchmarkOutputPaths,
): void {
  const failures = artifact.result.summaries.reduce(
    (total, summary) => total + summary.failedRuns,
    0,
  )
  const knownCostUsd = artifact.result.summaries.reduce(
    (total, summary) => total + summary.knownCostUsd,
    0,
  )
  const unknownCostRuns = artifact.result.summaries.reduce(
    (total, summary) => total + summary.costUnknownRuns,
    0,
  )
  process.stdout.write(
    `Analyst benchmark complete: cases=${artifact.result.provenance.caseCount} failures=${failures} known_cost_usd=${knownCostUsd.toFixed(6)} unknown_cost_runs=${unknownCostRuns}\nresult=${paths.result}\nreport=${paths.report}\n`,
  )
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}
