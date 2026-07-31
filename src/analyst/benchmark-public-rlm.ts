import {
  CostAccountingIncompleteError,
  CostCallConflictError,
  CostCeilingReachedError,
  CostLedger,
  CostLedgerPersistenceError,
  CostReceiptCaptureError,
  CostReservationExceededError,
  type CustomTokenPricing,
} from '../cost-ledger'
import { resolveModelPricing } from '../metrics'
import type { AnalystBenchmarkRunner } from './benchmark'
import { validateCodeTraceFindingEvidence } from './benchmark-evidence-validation'
import { adaptPublicBenchmarkFindings } from './benchmark-public-adapters'
import { publicBenchmarkError } from './benchmark-public-errors'
import {
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  publicBenchmarkProtocolSha256,
} from './benchmark-public-model'
import type {
  PublicAnalystBenchmarkDataset,
  PublicAnalystBenchmarkModelConfig,
} from './benchmark-public-types'
import { createDspyRlmTraceEngine, type DspyRlmTraceEngineOptions } from './dspy-rlm-engine'
import { evidenceRefsFromRawFinding } from './finding-signature'
import { runTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import type { AnalystFinding, AnalystRunInputs, AnalystUsageReceipt } from './types'
import { makeFinding } from './types'

const AGENT_RX_RLM_INSTRUCTIONS = `Analyze exactly one failed agent trajectory.
Find the first unrecoverable critical failure, not every later symptom.
Use the trace tools to inspect the action and its following observation.
Emit zero findings only when evidence does not support a root cause.
Otherwise emit exactly one finding whose subject is exactly one of:
instruction-plan-adherence-failure
invention-of-new-information
invalid-invocation
misinterpretation-of-tool-output-handoff-failure
intent-plan-misalignment
underspecified-user-intent
intent-not-supported
guardrails-triggered
system-failure
inconclusive
Cite exactly one assistant span named step-<n> as trace://<trace-id>/span/step-<n>.
The excerpt must quote the assistant action exactly.`

const CODE_TRACE_RLM_INSTRUCTIONS = `${CODE_TRACE_BENCH_ANALYST_PROMPT}
Use the trace tools rather than asking for the whole trajectory in the prompt.
Keep retrieved trace objects in Python variables.
Never print an entire trace, full source file, or more than 12000 characters in one iteration.
Build a compact table of assistant step ids, actions, following observations, and final verification.
Inspect suspicious steps with viewSpans or searchSpan instead of repeatedly printing the table.
Submit as soon as every state-changing assistant step has a supported verdict.
For each incorrect step, set subject to incorrect-step-<n>.
Cite the assistant span as trace://<URL-encoded-trace-id>/span/step-<n>.
The evidence excerpt must be an exact quote from that span's action content.
Return no finding for a clean trajectory.`

/** Public benchmark candidate that runs the actual recursive trace analyst. */
export function createPublicBenchmarkRlmRunner(
  dataset: PublicAnalystBenchmarkDataset,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const costLedger = config.costLedger ?? new CostLedger()
  const limits = {
    maxIterations: config.dspyRlm?.maxIterations ?? 8,
    maxLlmCalls: config.dspyRlm?.maxLlmCalls ?? 4,
    maxToolCalls: config.dspyRlm?.maxToolCalls ?? 32,
    maxOutputChars: config.dspyRlm?.maxOutputChars ?? 8_000,
  }
  const pricing = config.pricing ?? pricingForModel(config.model)
  const engine = createDspyRlmTraceEngine({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    maxCostUsd: config.maxCostUsdPerAnalysis ?? 1,
    pricing,
    ...(config.dspyRlm?.runner ? { runner: config.dspyRlm.runner } : {}),
  } satisfies DspyRlmTraceEngineOptions)
  const definition = publicBenchmarkDefinition(dataset, limits)

  return {
    id: 'dspy-rlm',
    async analyze(input, context) {
      const trajectoryId = trajectoryIdFromCaseId(dataset, context.caseId)
      const tags = {
        benchmarkCaseId: context.caseId,
        benchmarkRepetition: String(context.repetition),
      }
      let usage: AnalystUsageReceipt | undefined
      let rawFindings: AnalystFinding[] = []
      try {
        if (!input.traceStore) {
          throw new Error(`${dataset} DSPy RLM runner requires a trace store`)
        }
        const completed = await runTraceAnalyst({
          definition,
          engine,
          store: input.traceStore,
          context: {
            runId: context.caseId,
            correlationId: `${context.caseId}:${context.repetition}`,
            costLedger,
            costPhase: 'analyst.public-benchmark.dspy-rlm',
            tags,
            recordUsage: (receipt) => {
              usage = receipt
            },
            signal: context.signal,
          },
        })
        const producedAt = new Date().toISOString()
        rawFindings = completed.findings.map((finding) =>
          makeFinding({
            analyst_id: 'dspy-rlm',
            area: dataset === 'agentrx' ? 'root-cause' : 'incorrect',
            subject: finding.subject,
            claim: finding.claim,
            rationale: finding.rationale,
            severity: finding.severity,
            confidence: finding.confidence,
            evidence_refs: evidenceRefsFromRawFinding(finding),
            recommended_action: finding.recommended_action,
            metadata: {
              analysis_mode: 'recursive',
              engine: 'dspy-rlm',
              model: config.model,
            },
            produced_at: producedAt,
          }),
        )
        const findings = adaptPublicBenchmarkFindings(
          dataset,
          trajectoryId,
          rawFindings,
          'dspy-rlm',
        )
        if (dataset === 'codetracebench') {
          await validateCodeTraceFindingEvidence({
            trajectoryId,
            findings,
            store: input.traceStore,
            ...(context.signal ? { signal: context.signal } : {}),
          })
        }
        return {
          findings,
          usage,
          metadata: {
            analysisMode: 'recursive',
            engine: 'dspy-rlm',
            protocolSha256: publicBenchmarkProtocolSha256(dataset),
            answer: completed.answer,
            trajectory: completed.trajectory,
            modelCalls: completed.modelCalls,
            toolCalls: completed.toolCalls,
            runtime: completed.runtime,
          },
        }
      } catch (error) {
        if (context.signal?.aborted) throw error
        if (isPaidCallControlError(error)) throw error
        return {
          findings: [],
          usage,
          error: publicBenchmarkError(error, [config.apiKey]),
          metadata: {
            analysisMode: 'recursive',
            engine: 'dspy-rlm',
            rawFindings,
          },
        }
      }
    },
  }
}

function publicBenchmarkDefinition(
  dataset: PublicAnalystBenchmarkDataset,
  limits: {
    maxIterations: number
    maxLlmCalls: number
    maxToolCalls: number
    maxOutputChars: number
  },
): TraceAnalystDefinition {
  return {
    id: dataset === 'agentrx' ? 'agentrx-dspy-rlm' : 'codetracebench-dspy-rlm',
    description:
      dataset === 'agentrx'
        ? 'Localizes the first unrecoverable root-cause step.'
        : 'Localizes every incorrect state-changing assistant step.',
    area: dataset === 'agentrx' ? 'root-cause' : 'incorrect',
    version: '1.0.0',
    question:
      dataset === 'agentrx'
        ? 'What is the first unrecoverable root cause in this failed trajectory?'
        : 'Which assistant steps are incorrect under the CodeTraceBench definition?',
    instructions: dataset === 'agentrx' ? AGENT_RX_RLM_INSTRUCTIONS : CODE_TRACE_RLM_INSTRUCTIONS,
    toolGroup: 'singleTrace',
    limits,
  }
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
