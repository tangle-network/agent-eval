import { z } from 'zod'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { AnalystBenchmarkRunner } from './benchmark'
import { agentRxPredictionsToFindings } from './benchmark-datasets'
import {
  resolveAssistantStepEvidence,
  validateCodeTraceFindingEvidence,
} from './benchmark-evidence-validation'
import {
  type CodeTraceBlockDiagnostics,
  type CodeTraceFailureBlock,
  expandCodeTraceFailureBlocks,
} from './benchmark-public-adapters'
import { runChunkedAnalystDefinition } from './benchmark-public-chunked'
import {
  MAX_INCORRECT_BLOCK_STEPS,
  MAX_INCORRECT_BLOCKS,
  PUBLIC_BENCHMARK_ENVELOPE_CONTRACT,
  publicBenchmarkFieldContract,
  publicBenchmarkProtocolSha256,
  publicBenchmarkTaskPrompt,
  TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS,
} from './benchmark-public-prompt'
import {
  type PublicAnalystBenchmarkDataset,
  type PublicAnalystBenchmarkModelConfig,
  positiveSafeInteger,
  requiredString,
} from './benchmark-public-types'
import type { AnalystDefinition } from './definition'
import type { ReplyContract } from './reply-contract'
import type { AnalystFinding, AnalystRunInputs } from './types'

export {
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  publicBenchmarkProtocolSha256,
} from './benchmark-public-prompt'

/**
 * One-shot JSON baseline arm. Not a recursive trace analyst.
 *
 * The arm is expressed as an `AnalystDefinition`
 * (`publicDirectAnalystDefinition`): the task text, field and envelope
 * contracts, the descending projection ladder, and the zero-repair declaration
 * are definition content, and `createPublicBenchmarkDirectRunner` is a thin
 * shell that builds the definition and runs it through the chunked strategy
 * below — the same strategy `bindAnalyst` (./bind) dispatches to.
 */

export interface PublicDirectDefinitionArgs {
  /** Whole-analysis deadline (`config.timeoutMs`). */
  timeoutMs: number
  /** Completion-token cap per call (`config.maxOutputTokens`). */
  maxOutputTokens: number
  /** Per-case provider spend ceiling (`config.maxCostUsdPerAnalysis`). */
  maxCostUsd: number
}

/** The direct arm as a declarative unit for one public dataset. */
export function publicDirectAnalystDefinition(
  dataset: PublicAnalystBenchmarkDataset,
  args: PublicDirectDefinitionArgs,
): AnalystDefinition<PublicBenchmarkModelPrediction> {
  const actor =
    dataset === 'agentrx' ? 'agentrx-root-cause-localizer' : 'codetracebench-step-localizer'
  const outputAdapter =
    dataset === 'agentrx' ? 'agentrx-taxonomy-and-root-step' : 'codetracebench-incorrect-block'
  return {
    id: 'direct',
    description: 'One-shot JSON baseline over the caller-owned model path.',
    version: '1.0.0',
    area: dataset === 'agentrx' ? 'root-cause' : 'incorrect',
    // One-shot JSON transport runs with thinking disabled.
    profile: { model: { reasoningEffort: 'none' } },
    // The task text is the whole ask: the one-shot prompt carries no question line.
    question: '',
    taskDefinition: publicBenchmarkTaskPrompt(dataset),
    projection: { mode: 'chunked', attributeByteCaps: TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS },
    replyContract: directReplyContract(dataset),
    contractLimits:
      dataset === 'agentrx'
        ? { maxFindings: 1 }
        : { maxBlocks: MAX_INCORRECT_BLOCKS, maxBlockSteps: MAX_INCORRECT_BLOCK_STEPS },
    budget: {
      timeoutMs: args.timeoutMs,
      maxCostUsd: args.maxCostUsd,
      maxOutputTokens: args.maxOutputTokens,
    },
    repair: { turns: 0 },
    protocolSha256: publicBenchmarkProtocolSha256(dataset),
    binding: {
      kind: 'chunked',
      subjectFromCaseId: (caseId) => trajectoryIdFromCaseId(dataset, caseId),
      baseMetadata: { analysisMode: 'direct-baseline', outputAdapter },
      costActor: actor,
      costPhase: 'analyst.public-benchmark',
      userMessage: (rendered) => `TRACE DATA:\n${rendered}\n\nReturn the analysis JSON object.`,
      async expandRows({ subject, rows, store, analystId, producedAt, providerModel, signal }) {
        const converted = await publicBenchmarkPredictionsToFindings({
          dataset,
          trajectoryId: subject,
          predictions: rows,
          store,
          analystId,
          providerModel: requiredString(providerModel ?? '', 'finding providerModel'),
          producedAt: requiredString(producedAt ?? '', 'finding producedAt'),
          ...(signal ? { signal } : {}),
        })
        return { findings: converted.findings, diagnostics: converted.diagnostics }
      },
      ...(dataset === 'codetracebench'
        ? {
            verifyFindings: async (args: {
              subject: string
              findings: readonly AnalystFinding[]
              store: TraceAnalysisStore
              signal?: AbortSignal
            }) => {
              await validateCodeTraceFindingEvidence({
                trajectoryId: args.subject,
                findings: [...args.findings],
                store: args.store,
                ...(args.signal ? { signal: args.signal } : {}),
              })
            },
          }
        : {}),
    },
  }
}

/** Thin shell: validate config, declare the definition, run the chunked strategy. */
export function createPublicBenchmarkDirectRunner(
  dataset: PublicAnalystBenchmarkDataset,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  if (config.instructionsOverride) {
    throw new Error(
      'the direct runner executes only the stock protocol; an instructions override requires the dspy-rlm runner',
    )
  }
  const maxOutputTokens = positiveSafeInteger(config.maxOutputTokens, 'maxOutputTokens')
  const timeoutMs = positiveSafeInteger(config.timeoutMs, 'timeoutMs')
  return runChunkedAnalystDefinition(
    publicDirectAnalystDefinition(dataset, {
      timeoutMs,
      maxOutputTokens,
      maxCostUsd: config.maxCostUsdPerAnalysis ?? 1,
    }),
    config,
  )
}

const ModelSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])
const AgentRxPredictionSchema = z
  .object({
    step: z.number().int().positive(),
    severity: ModelSeveritySchema,
    claim: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).optional(),
    recommended_action: z.string().min(1).optional(),
  })
  .strict()
const CodeTraceBlockPredictionSchema = z
  .object({
    first_step: z.number().int().positive(),
    last_step: z.number().int().positive(),
    consequence_step: z.number().int().positive(),
    escape_status: z.enum(['escaped', 'unescaped']),
    severity: ModelSeveritySchema,
    claim: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).optional(),
    recommended_action: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.last_step < block.first_step) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `failure block last_step ${block.last_step} precedes first_step ${block.first_step}`,
      })
      return
    }
    const length = block.last_step - block.first_step + 1
    if (length > MAX_INCORRECT_BLOCK_STEPS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `failure block spans ${length} steps; the maximum is ${MAX_INCORRECT_BLOCK_STEPS}`,
      })
    }
    // The damage a block caused can surface anywhere from the block's own first
    // step onward: a step carries both the assistant action and the observation
    // it produced, and a long block often shows its damage mid-block rather than
    // at the end. Only a consequence before the block began is incoherent.
    if (block.consequence_step < block.first_step) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `failure block consequence_step ${block.consequence_step} precedes first_step ${block.first_step}`,
      })
    }
  })
const AgentRxCategorySchema = z.enum([
  'instruction-plan-adherence-failure',
  'invention-of-new-information',
  'invalid-invocation',
  'misinterpretation-of-tool-output-handoff-failure',
  'intent-plan-misalignment',
  'underspecified-user-intent',
  'intent-not-supported',
  'guardrails-triggered',
  'system-failure',
  'inconclusive',
])
const CodeTraceModelResponseEnvelopeSchema = z
  .object({
    report: z.string().min(1).max(4_000),
    findings: z.array(z.unknown()).max(MAX_INCORRECT_BLOCKS),
  })
  .strict()
const AgentRxModelResponseSchema = z
  .object({
    report: z.string().min(1).max(4_000),
    findings: z
      .array(AgentRxPredictionSchema.extend({ category: AgentRxCategorySchema }).strict())
      .max(1),
  })
  .strict()

type AgentRxModelPrediction = z.infer<typeof AgentRxPredictionSchema> & {
  category?: z.infer<typeof AgentRxCategorySchema>
}
type CodeTraceModelPrediction = z.infer<typeof CodeTraceBlockPredictionSchema>
export type PublicBenchmarkModelPrediction = AgentRxModelPrediction | CodeTraceModelPrediction

/**
 * The one-shot reply grammar per dataset. The envelope is the contract and
 * stays strict. Individual CodeTraceBench blocks are model output: one
 * malformed block must not void a case whose remaining blocks are usable and
 * whose provider call is already paid for, so rows decode individually and
 * every rejection is reported.
 */
function directReplyContract(
  dataset: PublicAnalystBenchmarkDataset,
): ReplyContract<PublicBenchmarkModelPrediction> {
  if (dataset === 'agentrx') {
    return {
      rowsField: 'findings',
      contractLines: [publicBenchmarkFieldContract('agentrx'), PUBLIC_BENCHMARK_ENVELOPE_CONTRACT],
      repairContractLines: [],
      parseEnvelope(value) {
        const parsed = AgentRxModelResponseSchema.parse(value)
        return { rows: parsed.findings, extras: { report: parsed.report } }
      },
      decodeRow(row) {
        // The strict envelope already validated every row.
        return { ok: true, row: row as AgentRxModelPrediction }
      },
    }
  }
  return {
    rowsField: 'findings',
    contractLines: [
      publicBenchmarkFieldContract('codetracebench'),
      PUBLIC_BENCHMARK_ENVELOPE_CONTRACT,
    ],
    repairContractLines: [],
    parseEnvelope(value) {
      const envelope = CodeTraceModelResponseEnvelopeSchema.parse(value)
      return { rows: envelope.findings, extras: { report: envelope.report } }
    },
    decodeRow(row, index) {
      const parsed = CodeTraceBlockPredictionSchema.safeParse(row)
      if (parsed.success) return { ok: true, row: parsed.data }
      return {
        ok: false,
        reason: `block ${index}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
          .join('; ')}`,
      }
    },
    whenAllRowsRejected: 'fail',
    allRejectedMessage: 'every reported failure block was malformed',
  }
}

async function publicBenchmarkPredictionsToFindings(options: {
  dataset: PublicAnalystBenchmarkDataset
  trajectoryId: string
  predictions: readonly PublicBenchmarkModelPrediction[]
  store: TraceAnalysisStore
  analystId: string
  providerModel: string
  producedAt: string
  signal?: AbortSignal
}): Promise<{ findings: AnalystFinding[]; diagnostics: CodeTraceBlockDiagnostics | undefined }> {
  if (options.predictions.length === 0 && options.dataset === 'agentrx') {
    return { findings: [], diagnostics: undefined }
  }
  if (options.dataset === 'agentrx') {
    const prediction = options.predictions[0]!
    if (!('step' in prediction)) {
      throw new Error('AgentRx model output must name a single root-cause step')
    }
    if (!prediction.category) {
      throw new Error('AgentRx model output is missing its failure category')
    }
    const evidenceByStep = await resolveAssistantStepEvidence({
      trajectoryId: options.trajectoryId,
      steps: [prediction.step],
      store: options.store,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const [finding] = agentRxPredictionsToFindings(
      options.trajectoryId,
      [
        {
          failure_case: prediction.category,
          step_number: prediction.step,
          description: prediction.rationale ?? prediction.claim,
        },
      ],
      {
        analystId: options.analystId,
        producedAt: options.producedAt,
        confidence: prediction.confidence,
      },
    )
    if (!finding) throw new Error('AgentRx output adapter produced no root-cause finding')
    return {
      findings: [
        {
          ...finding,
          evidence_refs: [evidenceByStep.get(prediction.step)!],
          metadata: {
            ...finding.metadata,
            model: options.providerModel,
          },
        },
      ],
      diagnostics: undefined,
    }
  }

  const blocks = options.predictions.map((prediction): CodeTraceFailureBlock => {
    if (!('first_step' in prediction)) {
      throw new Error('CodeTraceBench model output must report first_step/last_step failure blocks')
    }
    return {
      firstStep: prediction.first_step,
      lastStep: prediction.last_step,
      consequenceStep: prediction.consequence_step,
      escapeStatus: prediction.escape_status,
      severity: prediction.severity,
      claim: prediction.claim,
      confidence: prediction.confidence,
      ...(prediction.rationale === undefined ? {} : { rationale: prediction.rationale }),
      ...(prediction.recommended_action === undefined
        ? {}
        : { recommendedAction: prediction.recommended_action }),
      metadata: { analysis_mode: 'direct-baseline', model: options.providerModel },
    }
  })
  return expandCodeTraceFailureBlocks({
    trajectoryId: options.trajectoryId,
    blocks,
    store: options.store,
    analystId: options.analystId,
    producedAt: options.producedAt,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

function trajectoryIdFromCaseId(dataset: PublicAnalystBenchmarkDataset, caseId: string): string {
  const prefix = dataset === 'agentrx' ? 'agentrx:' : 'codetrace:'
  if (!caseId.startsWith(prefix) || caseId.length === prefix.length) {
    throw new Error(`unexpected ${dataset} benchmark case id '${caseId}'`)
  }
  return caseId.slice(prefix.length)
}
