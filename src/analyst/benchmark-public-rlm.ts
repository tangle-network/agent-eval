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
import { adaptPublicBenchmarkFindings } from './benchmark-public-adapters'
import { publicBenchmarkError } from './benchmark-public-errors'
import { usageReceiptFromCostLedger } from './usage-receipt'
import {
  publicBenchmarkProtocolSha256,
  publicBenchmarkRlmInstructions,
} from './benchmark-public-prompt'
import type {
  PublicAnalystBenchmarkDataset,
  PublicAnalystBenchmarkModelConfig,
} from './benchmark-public-types'
import { createDspyRlmTraceEngine, type DspyRlmTraceEngineOptions } from './dspy-rlm-engine'
import { evidenceRefsFromRawFinding } from './finding-signature'
import { runTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import type { AnalystFinding, AnalystRunInputs, AnalystUsageReceipt } from './types'
import { makeFinding } from './types'

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
        const adapted = await adaptPublicBenchmarkFindings({
          dataset,
          trajectoryId,
          findings: rawFindings,
          analystId: 'dspy-rlm',
          store: input.traceStore,
          ...(context.signal ? { signal: context.signal } : {}),
        })
        return {
          findings: adapted.findings,
          usage,
          metadata: {
            analysisMode: 'recursive',
            engine: 'dspy-rlm',
            protocolSha256: publicBenchmarkProtocolSha256(dataset),
            ...(adapted.diagnostics ? { blockDiagnostics: adapted.diagnostics } : {}),
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
          // `recordUsage` only fires when the analyst completes, so a crash in
          // the out-of-process DSPy bridge would leave usage undefined and the
          // paid calls it already made unaccounted — which aborts the whole
          // benchmark on incomplete cost accounting, discarding every other
          // case. The ledger already holds those settled records, so recover
          // the receipt from it exactly as the direct runner does.
          usage: usage ?? usageReceiptFromCostLedger(costLedger, { channel: 'analyst', tags }),
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
    instructions: publicBenchmarkRlmInstructions(dataset),
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
