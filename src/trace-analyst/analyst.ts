import { randomUUID } from 'node:crypto'
import type {
  TraceAnalysisEngine,
  TraceAnalysisEngineResult,
  TraceAnalystLimits,
} from '../analyst/engine'
import { runTraceAnalyst } from '../analyst/kind-factory'
import type { TraceToolGroupName } from '../analyst/tool-groups'
import type { AnalystFinding, AnalystUsageReceipt } from '../analyst/types'
import type { CostLedgerHandle } from '../cost-ledger'
import { TRACE_ANALYST_ACTOR_DESCRIPTION, TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION } from './prompts'
import type { TraceAnalysisStore } from './store'
import { OtlpFileTraceStore } from './store-otlp'

export interface AnalyzeTracesInput {
  question: string
  id?: string
  description?: string
  area?: string
}

export type AnalyzeTracesResult = TraceAnalysisEngineResult

export interface AnalyzeTracesOptions {
  /** OTLP JSONL path or a caller-owned store. */
  source: string | TraceAnalysisStore
  /** Recursive research engine. */
  engine: TraceAnalysisEngine
  /** Override the general trace-research policy. */
  instructions?: string
  /** Smallest tool set that can answer the question. Default: all. */
  toolGroup?: TraceToolGroupName
  limits?: Partial<TraceAnalystLimits>
  runId?: string
  budgetUsd?: number
  costLedger?: CostLedgerHandle
  costPhase?: string
  priorFindings?: readonly AnalystFinding[]
  upstreamFindings?: readonly AnalystFinding[]
  recordUsage?: (receipt: AnalystUsageReceipt) => void
  tags?: Record<string, string>
  log?: (message: string, fields?: Record<string, unknown>) => void
  signal?: AbortSignal
}

/**
 * Answer one question by recursively inspecting a trace store.
 *
 * The returned answer, cited findings, engine steps, call counts, and runtime
 * identity are one audit record. A direct one-shot model call is not used.
 */
export async function analyzeTraces(
  input: AnalyzeTracesInput,
  options: AnalyzeTracesOptions,
): Promise<AnalyzeTracesResult> {
  if (typeof input.question !== 'string' || !input.question.trim()) {
    throw new TypeError('analyzeTraces: input.question must be a non-empty string')
  }
  const id = input.id?.trim() || 'trace-analysis'
  const store =
    typeof options.source === 'string'
      ? new OtlpFileTraceStore({ path: options.source })
      : options.source
  if (store instanceof OtlpFileTraceStore) {
    await store.ensureIndexed(options.signal ? { signal: options.signal } : undefined)
  }

  return runTraceAnalyst({
    definition: {
      id,
      description:
        input.description?.trim() ||
        'Answers a caller-defined question by recursively inspecting trace evidence.',
      area: input.area?.trim() || 'trace-analysis',
      version: TRACE_ANALYST_ACTOR_DESCRIPTION_VERSION,
      question: input.question,
      instructions: options.instructions ?? TRACE_ANALYST_ACTOR_DESCRIPTION,
      toolGroup: options.toolGroup ?? 'all',
      limits: options.limits,
    },
    engine: options.engine,
    store,
    context: {
      runId: options.runId ?? id,
      correlationId: randomUUID(),
      budgetUsd: options.budgetUsd,
      costLedger: options.costLedger,
      costPhase: options.costPhase ?? 'trace-analysis',
      priorFindings: options.priorFindings,
      upstreamFindings: options.upstreamFindings,
      recordUsage: options.recordUsage,
      tags: options.tags,
      log: options.log,
      signal: options.signal,
    },
  })
}
