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
import type { AnalystBenchmarkOutput, AnalystBenchmarkRunner } from './benchmark'
import { effectiveAnalystProtocolSha256 } from './benchmark-instructions-override'
import {
  adaptPublicBenchmarkFindings,
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
import { createDspyRlmTraceEngine, type DspyRlmTraceEngineOptions } from './dspy-rlm-engine'
import { evidenceRefsFromRawFinding } from './finding-signature'
import { runTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import type { AnalystFinding, AnalystRunInputs, AnalystUsageReceipt } from './types'
import { makeFinding } from './types'
import { usageReceiptFromCostLedger } from './usage-receipt'

/** Public benchmark candidate that runs the actual recursive trace analyst. */
export function createPublicBenchmarkRlmRunner(
  dataset: PublicAnalystBenchmarkDataset,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const costLedger = config.costLedger ?? new CostLedger()
  const samples = config.dspyRlm?.samples ?? 1
  if (!Number.isSafeInteger(samples) || samples < 1) {
    throw new RangeError('dspyRlm.samples must be a positive safe integer')
  }
  if (samples > 1 && dataset !== 'codetracebench') {
    throw new Error(
      'dspyRlm.samples > 1 requires the codetracebench dataset; step-level consensus is defined on its block grammar',
    )
  }
  const limits = {
    maxIterations: config.dspyRlm?.maxIterations ?? 14,
    maxLlmCalls: config.dspyRlm?.maxLlmCalls ?? 8,
    maxToolCalls: config.dspyRlm?.maxToolCalls ?? 80,
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
  const instructions = config.instructionsOverride?.text ?? publicBenchmarkRlmInstructions(dataset)
  const protocolSha256 = effectiveAnalystProtocolSha256(dataset, config.instructionsOverride)
  const definition = publicBenchmarkDefinition(dataset, limits, instructions)
  // Abstention floor: shares this runner's cost ledger so a fallback call's
  // spend lands under the same case and repetition tags as the engine's calls.
  // The fallback always runs the stock direct prompt — an instructions override
  // replaces only the recursive instructions, and the effective protocol digest
  // binds the stock digest (covering this fallback prompt) to the override.
  const { instructionsOverride: _rlmOnlyOverride, ...directConfig } = config
  void _rlmOnlyOverride
  const abstentionFallbackRunner = createPublicBenchmarkDirectRunner(dataset, {
    ...directConfig,
    costLedger,
  })

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
        if (samples > 1) {
          const store = input.traceStore
          const caseUsageFilter = { channel: 'analyst' as const, tags }
          const sampleRuns: Array<Record<string, unknown>> = []
          const sampleAssignments: CodeTraceStepAssignment[][] = []
          let totalModelCalls = 0
          let totalToolCalls = 0
          for (let sample = 0; sample < samples; sample += 1) {
            let sampleUsage: AnalystUsageReceipt | undefined
            const completed = await runTraceAnalyst({
              definition,
              engine,
              store,
              context: {
                runId: context.caseId,
                // A distinct correlation id per sample tags each sample's
                // provider calls individually in the shared ledger, while the
                // case and repetition tags keep all k samples' spend — and a
                // fallback's — on this one case.
                correlationId: `${context.caseId}:${context.repetition}:sample-${sample}`,
                costLedger,
                costPhase: 'analyst.public-benchmark.dspy-rlm',
                tags,
                recordUsage: (receipt) => {
                  sampleUsage = receipt
                  usage = usageReceiptFromCostLedger(costLedger, caseUsageFilter)
                },
                signal: context.signal,
              },
            })
            const producedAt = new Date().toISOString()
            const sampleFindings = completed.findings.map((finding) =>
              makeFinding({
                analyst_id: 'dspy-rlm',
                area: 'incorrect',
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
                  sample,
                  ...(codeTraceBlockMetadataFromSubject(finding.subject) ?? {}),
                },
                produced_at: producedAt,
              }),
            )
            rawFindings = [...rawFindings, ...sampleFindings]
            const adapted = await adaptPublicBenchmarkFindings({
              dataset,
              trajectoryId,
              findings: sampleFindings,
              analystId: 'dspy-rlm',
              store,
              ...(context.signal ? { signal: context.signal } : {}),
            })
            const assignments = adapted.stepBlocks ?? []
            sampleAssignments.push(assignments)
            totalModelCalls += completed.modelCalls
            totalToolCalls += completed.toolCalls
            sampleRuns.push({
              sample,
              answer: completed.answer,
              trajectory: completed.trajectory,
              modelCalls: completed.modelCalls,
              toolCalls: completed.toolCalls,
              runtime: completed.runtime,
              blocks: sampleBlockRecords(assignments),
              steps: assignments.map((assignment) => assignment.step),
              ...(adapted.diagnostics ? { blockDiagnostics: adapted.diagnostics } : {}),
              ...(sampleUsage ? { usage: sampleUsage } : {}),
            })
          }
          const consensus = consensusCodeTraceBlocks(sampleAssignments)
          const expanded = await expandCodeTraceFailureBlocks({
            trajectoryId,
            blocks: consensus.blocks,
            store,
            analystId: 'dspy-rlm',
            producedAt: new Date().toISOString(),
            ...(context.signal ? { signal: context.signal } : {}),
          })
          // Abstention floor, applied AFTER the vote and never per sample:
          // one direct structured call fires only when no step reached the
          // majority threshold, so the whole panel — not one noisy sample —
          // failed to localize anything.
          let fallback: AnalystBenchmarkOutput | undefined
          if (consensus.blocks.length === 0) {
            fallback = await abstentionFallbackRunner.analyze(input, context)
          }
          usage = usageReceiptFromCostLedger(costLedger, caseUsageFilter)
          return {
            findings: fallback && !fallback.error ? fallback.findings : expanded.findings,
            usage,
            metadata: {
              analysisMode: 'recursive',
              engine: 'dspy-rlm',
              protocolSha256,
              samples,
              sampleRuns,
              consensus: consensus.decision,
              blockDiagnostics: expanded.diagnostics,
              modelCalls: totalModelCalls,
              toolCalls: totalToolCalls,
              ...(fallback
                ? {
                    abstentionFallback: 'direct',
                    ...(fallback.metadata ? { abstentionFallbackMetadata: fallback.metadata } : {}),
                    ...(fallback.error ? { abstentionFallbackError: fallback.error } : {}),
                  }
                : {}),
            },
          }
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
              // Block coordinates from the subject grammar, so a row retained
              // by a failed or empty case still carries its block metadata.
              ...(dataset === 'codetracebench'
                ? codeTraceBlockMetadataFromSubject(finding.subject)
                : {}),
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
        // Abstention floor: the engine finished but submitted no finding at
        // all — indistinguishable from a missed investigation, so one direct
        // structured call gets a second opinion. An explicit clean verdict
        // arrives as a finding and never reaches this branch; an engine error
        // is thrown above and never reaches it either.
        let fallback: AnalystBenchmarkOutput | undefined
        if (completed.findings.length === 0) {
          fallback = await abstentionFallbackRunner.analyze(input, context)
          usage = usageReceiptFromCostLedger(costLedger, {
            channel: 'analyst',
            tags: {
              benchmarkCaseId: context.caseId,
              benchmarkRepetition: String(context.repetition),
            },
          })
        }
        return {
          findings: fallback && !fallback.error ? fallback.findings : adapted.findings,
          usage,
          metadata: {
            analysisMode: 'recursive',
            engine: 'dspy-rlm',
            protocolSha256,
            ...(adapted.diagnostics ? { blockDiagnostics: adapted.diagnostics } : {}),
            answer: completed.answer,
            trajectory: completed.trajectory,
            modelCalls: completed.modelCalls,
            toolCalls: completed.toolCalls,
            runtime: completed.runtime,
            ...(fallback
              ? {
                  abstentionFallback: 'direct',
                  ...(fallback.metadata ? { abstentionFallbackMetadata: fallback.metadata } : {}),
                  ...(fallback.error ? { abstentionFallbackError: fallback.error } : {}),
                }
              : {}),
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
            ...(samples > 1 ? { samples } : {}),
            rawFindings,
          },
        }
      }
    },
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

function publicBenchmarkDefinition(
  dataset: PublicAnalystBenchmarkDataset,
  limits: {
    maxIterations: number
    maxLlmCalls: number
    maxToolCalls: number
    maxOutputChars: number
  },
  instructions: string,
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
    instructions,
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
