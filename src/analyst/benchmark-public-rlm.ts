import {
  CostAccountingIncompleteError,
  CostCallConflictError,
  CostCeilingReachedError,
  CostLedger,
  type CostLedgerHandle,
  CostLedgerPersistenceError,
  CostReceiptCaptureError,
  CostReservationExceededError,
  type CustomTokenPricing,
} from '../cost-ledger'
import { resolveModelPricing } from '../metrics'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { AnalystBenchmarkOutput, AnalystBenchmarkRunner } from './benchmark'
import { effectiveAnalystProtocolSha256 } from './benchmark-instructions-override'
import {
  adaptPublicBenchmarkFindings,
  type CodeTraceFailureBlock,
  type CodeTraceStepAssignment,
  codeTraceBlockMetadataFromSubject,
  expandCodeTraceFailureBlocks,
} from './benchmark-public-adapters'
import { consensusCodeTraceBlocks } from './benchmark-public-consensus'
import { publicBenchmarkError } from './benchmark-public-errors'
import { createPublicBenchmarkDirectRunner } from './benchmark-public-model'
import { publicBenchmarkRlmInstructions } from './benchmark-public-prompt'
import type {
  PublicAnalystBenchmarkDataset,
  PublicAnalystBenchmarkModelConfig,
} from './benchmark-public-types'
import {
  type AnalystDefinition,
  AnalystExpressivenessError,
  type ReplVariableConsensusPort,
  type ReplVariableEvidenceBinding,
} from './definition'
import { createDspyRlmTraceEngine, type DspyRlmTraceEngineOptions } from './dspy-rlm-engine'
import type { TraceAnalysisEngine, TraceAnalystLimits } from './engine'
import {
  evidenceRefsFromRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  type RawAnalystFinding,
  RawAnalystFindingSchema,
} from './finding-signature'
import { runTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import type { AnalystFinding, AnalystRunInputs, AnalystUsageReceipt } from './types'
import { makeFinding } from './types'
import { usageReceiptFromCostLedger } from './usage-receipt'

/**
 * Public benchmark candidate that runs the actual recursive trace analyst.
 *
 * The arm is expressed as an `AnalystDefinition` (`publicRlmAnalystDefinition`):
 * the question, the recursive instructions (stock or override), the tool group,
 * the engine iteration limits, and the budget are definition content, and
 * `createPublicBenchmarkRlmRunner` is a thin shell that builds the definition
 * and runs it through the repl-variable strategy below — the same strategy
 * `bindAnalyst` (./bind) dispatches to.
 */

export interface PublicRlmDefinitionArgs {
  /** Effective recursive instructions: the override text or the stock prompt. */
  instructions: string
  /** Digest the arm records: the stock digest, bound to any override. */
  protocolSha256: string
  /** Whole-analysis deadline (`config.timeoutMs`). */
  timeoutMs: number
  /** Controller completion-token cap (`config.maxOutputTokens`). */
  maxOutputTokens: number
  /** Per-case engine spend ceiling (`config.maxCostUsdPerAnalysis`). */
  maxCostUsd: number
  /** Resolved recursive-engine iteration limits. */
  engineLimits: TraceAnalystLimits
}

/** The dspy-rlm arm as a declarative unit for one public dataset. */
export function publicRlmAnalystDefinition(
  dataset: PublicAnalystBenchmarkDataset,
  args: PublicRlmDefinitionArgs,
): AnalystDefinition<RawAnalystFinding, CodeTraceStepAssignment> {
  return {
    id: 'dspy-rlm',
    description:
      dataset === 'agentrx'
        ? 'Localizes the first unrecoverable root-cause step.'
        : 'Localizes every incorrect state-changing assistant step.',
    version: '1.0.0',
    area: dataset === 'agentrx' ? 'root-cause' : 'incorrect',
    // The caller-owned model path selects the model; the engine owns reasoning.
    profile: {},
    question:
      dataset === 'agentrx'
        ? 'What is the first unrecoverable root cause in this failed trajectory?'
        : 'Which assistant steps are incorrect under the CodeTraceBench definition?',
    taskDefinition: args.instructions,
    projection: { mode: 'repl-variable', toolGroup: 'singleTrace' },
    // Declarative restatement of the engine's row grammar: the engine enforces
    // the same `RawAnalystFindingSchema` on every submitted row, and the
    // schema prompt below is what `runTraceAnalyst` splices into the
    // instructions. The bounded typed repair lives inside the engine's control
    // adapter, so no repair grammar restatement exists.
    replyContract: {
      rowsField: 'findings',
      contractLines: [RAW_FINDING_SCHEMA_PROMPT],
      repairContractLines: [],
      decodeRow(row) {
        const parsed = RawAnalystFindingSchema.safeParse(row)
        if (parsed.success) return { ok: true, row: parsed.data }
        return {
          ok: false,
          reason: parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
        }
      },
    },
    contractLimits: {
      maxIterations: args.engineLimits.maxIterations,
      maxLlmCalls: args.engineLimits.maxLlmCalls,
      maxToolCalls: args.engineLimits.maxToolCalls,
      maxOutputChars: args.engineLimits.maxOutputChars,
    },
    budget: {
      timeoutMs: args.timeoutMs,
      maxCostUsd: args.maxCostUsd,
      maxOutputTokens: args.maxOutputTokens,
      engineLimits: args.engineLimits,
    },
    // One bounded typed-extraction repair inside the engine's control adapter,
    // mirroring the prime arm's single repair turn.
    repair: { turns: 1 },
    protocolSha256: args.protocolSha256,
    binding: {
      kind: 'repl-variable',
      traceAnalystId: dataset === 'agentrx' ? 'agentrx-dspy-rlm' : 'codetracebench-dspy-rlm',
      subjectFromCaseId: (caseId) => trajectoryIdFromCaseId(dataset, caseId),
      baseMetadata: { analysisMode: 'recursive', engine: 'dspy-rlm' },
      findingBaseMetadata: { analysis_mode: 'recursive', engine: 'dspy-rlm' },
      costPhase: 'analyst.public-benchmark.dspy-rlm',
      ...(dataset === 'codetracebench'
        ? { metadataFromSubject: codeTraceBlockMetadataFromSubject }
        : {}),
      async adapt({ subject, findings, analystId, store, signal }) {
        return adaptPublicBenchmarkFindings({
          dataset,
          trajectoryId: subject,
          findings: [...findings],
          analystId,
          store,
          ...(signal ? { signal } : {}),
        })
      },
      ...(dataset === 'codetracebench' ? { consensus: codeTraceConsensusPort() } : {}),
      abstentionFallback: (fallbackConfig) =>
        createPublicBenchmarkDirectRunner(dataset, fallbackConfig),
    },
  }
}

/** Step-level majority consensus on the CodeTraceBench block grammar. */
function codeTraceConsensusPort(): ReplVariableConsensusPort<
  CodeTraceStepAssignment,
  CodeTraceFailureBlock
> {
  return {
    vote(samples) {
      const consensus = consensusCodeTraceBlocks(samples.map((sample) => [...sample]))
      return { blocks: consensus.blocks, decision: consensus.decision }
    },
    async expand({ subject, blocks, store, analystId, producedAt, signal }) {
      const expanded = await expandCodeTraceFailureBlocks({
        trajectoryId: subject,
        blocks,
        store,
        analystId,
        producedAt,
        ...(signal ? { signal } : {}),
      })
      return { findings: expanded.findings, diagnostics: expanded.diagnostics }
    },
    sampleRecord(assignments) {
      return {
        blocks: sampleBlockRecords(assignments),
        steps: assignments.map((assignment) => assignment.step),
      }
    },
  }
}

/** Thin shell: validate config, declare the definition, run the repl-variable strategy. */
export function createPublicBenchmarkRlmRunner(
  dataset: PublicAnalystBenchmarkDataset,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const samples = config.dspyRlm?.samples ?? 1
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new RangeError('dspyRlm.samples must be a positive safe integer')
  }
  if (samples > 1 && dataset !== 'codetracebench') {
    throw new Error(
      'dspyRlm.samples > 1 requires the codetracebench dataset; step-level consensus is defined on its block grammar',
    )
  }
  return runReplVariableAnalystDefinition(
    publicRlmAnalystDefinition(dataset, {
      instructions: config.instructionsOverride?.text ?? publicBenchmarkRlmInstructions(dataset),
      protocolSha256: effectiveAnalystProtocolSha256(dataset, config.instructionsOverride),
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      maxCostUsd: config.maxCostUsdPerAnalysis ?? 1,
      engineLimits: rlmEngineLimits(config),
    }),
    config,
  )
}

/** Engine iteration limits with this arm's defaults applied. */
export function rlmEngineLimits(config: PublicAnalystBenchmarkModelConfig): TraceAnalystLimits {
  return {
    maxIterations: config.dspyRlm?.maxIterations ?? 14,
    maxLlmCalls: config.dspyRlm?.maxLlmCalls ?? 8,
    maxToolCalls: config.dspyRlm?.maxToolCalls ?? 80,
    maxOutputChars: config.dspyRlm?.maxOutputChars ?? 8_000,
  }
}

// ── Repl-variable execution strategy ────────────────────────────────

type ReplVariableBinding = ReplVariableEvidenceBinding<CodeTraceStepAssignment>
type BenchmarkContext = Parameters<AnalystBenchmarkRunner<AnalystRunInputs>['analyze']>[1]

/** What one compiled repl-variable arm shares across every case it analyzes. */
interface ReplVariableArm {
  readonly definition: AnalystDefinition<RawAnalystFinding, CodeTraceStepAssignment>
  readonly binding: ReplVariableBinding
  readonly config: PublicAnalystBenchmarkModelConfig
  readonly area: string
  readonly samples: number
  readonly costLedger: CostLedgerHandle
  readonly engine: TraceAnalysisEngine
  readonly traceDefinition: TraceAnalystDefinition
  readonly abstentionFallbackRunner: AnalystBenchmarkRunner<AnalystRunInputs>
}

/** One case's identity and what its analysis has produced so far, kept for the error path. */
interface ReplVariableCase {
  readonly context: BenchmarkContext
  readonly trajectoryId: string
  readonly tags: { benchmarkCaseId: string; benchmarkRepetition: string }
  usage: AnalystUsageReceipt | undefined
  rawFindings: AnalystFinding[]
}

/** Totals a multi-sample case accumulates across its samples. */
interface SampleTotals {
  readonly sampleRuns: Array<Record<string, unknown>>
  readonly sampleAssignments: CodeTraceStepAssignment[][]
  modelCalls: number
  toolCalls: number
}

/** Refuse a definition or transport the repl-variable strategy cannot execute exactly as declared. */
function checkReplVariableDefinition(
  definition: AnalystDefinition<RawAnalystFinding, CodeTraceStepAssignment>,
  config: PublicAnalystBenchmarkModelConfig,
) {
  const { projection, binding } = definition
  if (projection.mode !== 'repl-variable' || binding.kind !== 'repl-variable') {
    throw new AnalystExpressivenessError(
      `the repl-variable strategy compiles only repl-variable projections; definition ` +
        `'${definition.id}' declares projection '${projection.mode}' with a '${binding.kind}' binding`,
    )
  }
  const instructions = definition.taskDefinition
  if (instructions === undefined) {
    throw new AnalystExpressivenessError(
      `the repl-variable strategy runs the definition's task text as engine instructions; ` +
        `definition '${definition.id}' declares none`,
    )
  }
  if (
    config.instructionsOverride !== undefined &&
    config.instructionsOverride.text !== instructions
  ) {
    throw new AnalystExpressivenessError(
      `definition '${definition.id}' declares instructions that differ from the transport's ` +
        'instructionsOverride; one text must execute',
    )
  }
  const area = definition.area
  if (area === undefined) {
    throw new AnalystExpressivenessError(
      `the repl-variable strategy stamps the definition's area on every finding; definition ` +
        `'${definition.id}' declares none`,
    )
  }
  const limits = definition.budget.engineLimits
  if (limits === undefined) {
    throw new AnalystExpressivenessError(
      `the repl-variable strategy needs declared engine limits; definition ` +
        `'${definition.id}' declares none`,
    )
  }
  const effectiveLimits = rlmEngineLimits(config)
  if (
    limits.maxIterations !== effectiveLimits.maxIterations ||
    limits.maxLlmCalls !== effectiveLimits.maxLlmCalls ||
    limits.maxToolCalls !== effectiveLimits.maxToolCalls ||
    limits.maxOutputChars !== effectiveLimits.maxOutputChars
  ) {
    throw new AnalystExpressivenessError(
      `definition '${definition.id}' declares engine limits ${JSON.stringify(limits)} but the ` +
        `bound transport runs ${JSON.stringify(effectiveLimits)}; the declaration must state what executes`,
    )
  }
  return { binding, instructions, area, limits, toolGroup: projection.toolGroup }
}

/** The recursive engine over the caller-owned model path, with only the configured options set. */
function createReplVariableEngine(
  config: PublicAnalystBenchmarkModelConfig,
  pricing: CustomTokenPricing,
): TraceAnalysisEngine {
  return createDspyRlmTraceEngine({
    call: config.call,
    callRef: config.callRef,
    recordExecution: config.recordExecution,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    maxCostUsd: config.maxCostUsdPerAnalysis ?? 1,
    pricing,
    ...(config.maxReasoningTokens === undefined
      ? {}
      : { maxReasoningTokens: config.maxReasoningTokens }),
    ...(config.maxModelRequestBytes === undefined
      ? {}
      : { maxModelRequestBytes: config.maxModelRequestBytes }),
    ...(config.maxModelResponseBytes === undefined
      ? {}
      : { maxModelResponseBytes: config.maxModelResponseBytes }),
    ...(config.modelRequestTimeoutMs === undefined
      ? {}
      : { modelRequestTimeoutMs: config.modelRequestTimeoutMs }),
    ...(config.dspyRlm?.maxModelRequests === undefined
      ? {}
      : { maxModelRequests: config.dspyRlm.maxModelRequests }),
    ...(config.dspyRlm?.traceToolRequestBytes === undefined &&
    config.dspyRlm?.traceToolResponseBytes === undefined
      ? {}
      : {
          traceToolLimits: {
            ...(config.dspyRlm?.traceToolRequestBytes === undefined
              ? {}
              : { maxRequestBytes: config.dspyRlm.traceToolRequestBytes }),
            ...(config.dspyRlm?.traceToolResponseBytes === undefined
              ? {}
              : { maxResponseBytes: config.dspyRlm.traceToolResponseBytes }),
          },
        }),
    ...(config.dspyRlm?.traceToolTimeoutMs === undefined
      ? {}
      : { traceToolTimeoutMs: config.dspyRlm.traceToolTimeoutMs }),
    ...(config.dspyRlm?.runner ? { runner: config.dspyRlm.runner } : {}),
  } satisfies DspyRlmTraceEngineOptions)
}

/** Validate the definition and transport, then build the engine, ledger and abstention floor. */
function compileReplVariableArm(
  definition: AnalystDefinition<RawAnalystFinding, CodeTraceStepAssignment>,
  config: PublicAnalystBenchmarkModelConfig,
): ReplVariableArm {
  const { binding, instructions, area, limits, toolGroup } = checkReplVariableDefinition(
    definition,
    config,
  )
  const costLedger = config.costLedger ?? new CostLedger()
  const samples = config.dspyRlm?.samples ?? 1
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new RangeError('dspyRlm.samples must be a positive safe integer')
  }
  if (samples > 1 && binding.consensus === undefined) {
    throw new AnalystExpressivenessError(
      `samples > 1 needs a consensus port; definition '${definition.id}' declares none`,
    )
  }
  const pricing = config.pricing ?? pricingForModel(config.model)
  const engine = createReplVariableEngine(config, pricing)
  const traceDefinition: TraceAnalystDefinition = {
    id: binding.traceAnalystId,
    description: definition.description,
    area,
    version: definition.version,
    question: definition.question,
    instructions,
    toolGroup,
    limits,
  }
  // Abstention floor: shares this arm's cost ledger so a fallback call's spend
  // lands under the same case and repetition tags as the engine's calls. The
  // fallback always runs the stock direct prompt — an instructions override
  // replaces only the recursive instructions, and the effective protocol digest
  // binds the stock digest (covering this fallback prompt) to the override.
  const { instructionsOverride: _rlmOnlyOverride, ...directConfig } = config
  void _rlmOnlyOverride
  const abstentionFallbackRunner = binding.abstentionFallback({ ...directConfig, costLedger })
  return {
    definition,
    binding,
    config,
    area,
    samples,
    costLedger,
    engine,
    traceDefinition,
    abstentionFallbackRunner,
  }
}

/** Stamp the engine's raw rows as findings; `extra` metadata sits between the model and the subject block. */
function stampFindings(
  arm: ReplVariableArm,
  rows: readonly RawAnalystFinding[],
  extra: Record<string, unknown>,
): AnalystFinding[] {
  const { definition, binding, config, area } = arm
  const producedAt = new Date().toISOString()
  return rows.map((finding) =>
    makeFinding({
      analyst_id: definition.id,
      area,
      subject: finding.subject,
      claim: finding.claim,
      rationale: finding.rationale,
      severity: finding.severity,
      confidence: finding.confidence,
      evidence_refs: evidenceRefsFromRawFinding(finding),
      recommended_action: finding.recommended_action,
      metadata: {
        ...binding.findingBaseMetadata,
        model: config.model,
        ...extra,
        // Block coordinates from the subject grammar, so a row retained
        // by a failed or empty case still carries its block metadata.
        ...(binding.metadataFromSubject?.(finding.subject) ?? {}),
      },
      produced_at: producedAt,
    }),
  )
}

/** Metadata that records a direct abstention-floor call, or nothing when none fired. */
function abstentionFallbackMetadata(
  fallback: AnalystBenchmarkOutput | undefined,
): Record<string, unknown> {
  if (!fallback) return {}
  return {
    abstentionFallback: 'direct',
    ...(fallback.metadata ? { abstentionFallbackMetadata: fallback.metadata } : {}),
    ...(fallback.error ? { abstentionFallbackError: fallback.error } : {}),
  }
}

/** Run one engine sample of a multi-sample case and fold it into the totals. */
async function runReplVariableSample(
  arm: ReplVariableArm,
  run: ReplVariableCase,
  store: TraceAnalysisStore,
  sample: number,
  totals: SampleTotals,
): Promise<void> {
  const { definition, binding, costLedger } = arm
  const { context, tags } = run
  const caseUsageFilter = { channel: 'analyst' as const, tags }
  let sampleUsage: AnalystUsageReceipt | undefined
  const completed = await runTraceAnalyst({
    definition: arm.traceDefinition,
    engine: arm.engine,
    store,
    context: {
      runId: context.caseId,
      // A distinct correlation id per sample tags each sample's
      // provider calls individually in the shared ledger, while the
      // case and repetition tags keep all k samples' spend — and a
      // fallback's — on this one case.
      correlationId: `${context.caseId}:${context.repetition}:sample-${sample}`,
      costLedger,
      costPhase: binding.costPhase,
      tags,
      recordUsage: (receipt) => {
        sampleUsage = receipt
        run.usage = usageReceiptFromCostLedger(costLedger, caseUsageFilter)
      },
      signal: context.signal,
    },
  })
  const sampleFindings = stampFindings(arm, completed.findings, { sample })
  run.rawFindings = [...run.rawFindings, ...sampleFindings]
  const adapted = await binding.adapt({
    subject: run.trajectoryId,
    findings: sampleFindings,
    analystId: definition.id,
    store,
    ...(context.signal ? { signal: context.signal } : {}),
  })
  const assignments = adapted.stepBlocks ?? []
  totals.sampleAssignments.push(assignments)
  totals.modelCalls += completed.modelCalls
  totals.toolCalls += completed.toolCalls
  totals.sampleRuns.push({
    sample,
    answer: completed.answer,
    trajectory: completed.trajectory,
    modelCalls: completed.modelCalls,
    toolCalls: completed.toolCalls,
    runtime: completed.runtime,
    ...binding.consensus!.sampleRecord(assignments),
    ...(adapted.diagnostics ? { blockDiagnostics: adapted.diagnostics } : {}),
    ...(sampleUsage ? { usage: sampleUsage } : {}),
  })
}

/** Run k samples, vote on their step blocks, and fall back only when the whole panel found nothing. */
async function analyzeReplVariableSamples(
  arm: ReplVariableArm,
  run: ReplVariableCase,
  input: AnalystRunInputs,
  store: TraceAnalysisStore,
): Promise<AnalystBenchmarkOutput> {
  const { definition, binding, costLedger, samples } = arm
  const { context } = run
  const totals: SampleTotals = {
    sampleRuns: [],
    sampleAssignments: [],
    modelCalls: 0,
    toolCalls: 0,
  }
  for (let sample = 0; sample < samples; sample += 1) {
    await runReplVariableSample(arm, run, store, sample, totals)
  }
  const consensus = binding.consensus!.vote(totals.sampleAssignments)
  const expanded = await binding.consensus!.expand({
    subject: run.trajectoryId,
    blocks: consensus.blocks,
    store,
    analystId: definition.id,
    producedAt: new Date().toISOString(),
    ...(context.signal ? { signal: context.signal } : {}),
  })
  // Abstention floor, applied AFTER the vote and never per sample:
  // one direct structured call fires only when no step reached the
  // majority threshold, so the whole panel — not one noisy sample —
  // failed to localize anything.
  let fallback: AnalystBenchmarkOutput | undefined
  if (consensus.blocks.length === 0) {
    fallback = await arm.abstentionFallbackRunner.analyze(input, context)
  }
  run.usage = usageReceiptFromCostLedger(costLedger, { channel: 'analyst', tags: run.tags })
  return {
    findings: fallback && !fallback.error ? fallback.findings : expanded.findings,
    usage: run.usage,
    metadata: {
      ...binding.baseMetadata,
      protocolSha256: definition.protocolSha256,
      samples,
      sampleRuns: totals.sampleRuns,
      consensus: consensus.decision,
      blockDiagnostics: expanded.diagnostics,
      modelCalls: totals.modelCalls,
      toolCalls: totals.toolCalls,
      ...abstentionFallbackMetadata(fallback),
    },
  }
}

/** Run the engine once, adapt its rows, and fall back only when it submitted no finding. */
async function analyzeReplVariableOnce(
  arm: ReplVariableArm,
  run: ReplVariableCase,
  input: AnalystRunInputs,
  store: TraceAnalysisStore,
): Promise<AnalystBenchmarkOutput> {
  const { definition, binding, costLedger } = arm
  const { context, tags } = run
  const completed = await runTraceAnalyst({
    definition: arm.traceDefinition,
    engine: arm.engine,
    store,
    context: {
      runId: context.caseId,
      correlationId: `${context.caseId}:${context.repetition}`,
      costLedger,
      costPhase: binding.costPhase,
      tags,
      recordUsage: (receipt) => {
        run.usage = receipt
      },
      signal: context.signal,
    },
  })
  run.rawFindings = stampFindings(arm, completed.findings, {})
  const adapted = await binding.adapt({
    subject: run.trajectoryId,
    findings: run.rawFindings,
    analystId: definition.id,
    store,
    ...(context.signal ? { signal: context.signal } : {}),
  })
  // Abstention floor: the engine finished but submitted no finding at
  // all — indistinguishable from a missed investigation, so one direct
  // structured call gets a second opinion. An explicit clean verdict
  // arrives as a finding and never reaches this branch; an engine error
  // is thrown above and never reaches it either.
  let fallback: AnalystBenchmarkOutput | undefined
  if (completed.findings.length === 0) {
    fallback = await arm.abstentionFallbackRunner.analyze(input, context)
    run.usage = usageReceiptFromCostLedger(costLedger, { channel: 'analyst', tags })
  }
  return {
    findings: fallback && !fallback.error ? fallback.findings : adapted.findings,
    usage: run.usage,
    metadata: {
      ...binding.baseMetadata,
      protocolSha256: definition.protocolSha256,
      ...(adapted.diagnostics ? { blockDiagnostics: adapted.diagnostics } : {}),
      answer: completed.answer,
      trajectory: completed.trajectory,
      modelCalls: completed.modelCalls,
      toolCalls: completed.toolCalls,
      runtime: completed.runtime,
      ...abstentionFallbackMetadata(fallback),
    },
  }
}

/** Analyze one benchmark case; a paid-call control error or an abort is rethrown, any other failure is recorded. */
async function analyzeReplVariableCase(
  arm: ReplVariableArm,
  input: AnalystRunInputs,
  context: BenchmarkContext,
): Promise<AnalystBenchmarkOutput> {
  const { definition, binding, samples } = arm
  const run: ReplVariableCase = {
    context,
    trajectoryId: binding.subjectFromCaseId(context.caseId),
    tags: {
      benchmarkCaseId: context.caseId,
      benchmarkRepetition: String(context.repetition),
    },
    usage: undefined,
    rawFindings: [],
  }
  try {
    if (!input.traceStore) {
      throw new Error(`repl-variable analyst '${definition.id}' requires a trace store`)
    }
    return samples > 1
      ? await analyzeReplVariableSamples(arm, run, input, input.traceStore)
      : await analyzeReplVariableOnce(arm, run, input, input.traceStore)
  } catch (error) {
    if (context.signal?.aborted) throw error
    if (isPaidCallControlError(error)) throw error
    return {
      findings: [],
      usage: run.usage,
      error: publicBenchmarkError(error, []),
      metadata: {
        ...binding.baseMetadata,
        ...(samples > 1 ? { samples } : {}),
        rawFindings: run.rawFindings,
      },
    }
  }
}

/**
 * Compile a repl-variable definition into a runnable recursive-engine arm over
 * the caller-owned model path. The question, instructions, tool group, and
 * iteration limits come from the definition; the engine, model proxy, sampling
 * loop, and abstention floor are transport machinery.
 */
export function runReplVariableAnalystDefinition(
  definition: AnalystDefinition<RawAnalystFinding, CodeTraceStepAssignment>,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const arm = compileReplVariableArm(definition, config)
  return {
    id: definition.id,
    analyze: (input, context) => analyzeReplVariableCase(arm, input, context),
  }
}

/** Per-sample accepted blocks with the exact steps the expansion kept for each. */
function sampleBlockRecords(
  assignments: readonly CodeTraceStepAssignment[],
): Array<Record<string, unknown>> {
  const stepsByBlock = new Map<CodeTraceStepAssignment['block'], number[]>()
  for (const { step, block } of assignments) {
    const steps = stepsByBlock.get(block)
    if (steps) steps.push(step)
    else stepsByBlock.set(block, [step])
  }
  return [...stepsByBlock].map(([block, acceptedSteps]) => ({
    firstStep: block.firstStep,
    lastStep: block.lastStep,
    consequenceStep: block.consequenceStep,
    escapeStatus: block.escapeStatus,
    severity: block.severity,
    confidence: block.confidence,
    claim: block.claim,
    acceptedSteps,
  }))
}

function pricingForModel(model: string): CustomTokenPricing {
  const pricing = resolveModelPricing(model)
  if (!pricing) {
    throw new Error(
      `no pricing is configured for '${model}'; provide PublicAnalystBenchmarkModelConfig.pricing`,
    )
  }
  return {
    inputUsdPerMillion: pricing.input * 1_000,
    outputUsdPerMillion: pricing.output * 1_000,
  }
}

function trajectoryIdFromCaseId(dataset: PublicAnalystBenchmarkDataset, caseId: string): string {
  const prefix = dataset === 'agentrx' ? 'agentrx:' : 'codetrace:'
  if (!caseId.startsWith(prefix) || caseId.length === prefix.length) {
    throw new Error(`unexpected ${dataset} benchmark case id '${caseId}'`)
  }
  return caseId.slice(prefix.length)
}

function isPaidCallControlError(error: unknown): boolean {
  return (
    error instanceof CostAccountingIncompleteError ||
    error instanceof CostCallConflictError ||
    error instanceof CostCeilingReachedError ||
    error instanceof CostLedgerPersistenceError ||
    error instanceof CostReceiptCaptureError ||
    error instanceof CostReservationExceededError
  )
}
