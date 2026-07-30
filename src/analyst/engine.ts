import type { CostLedgerHandle } from '../cost-ledger'
import type { TraceAnalysisToolDescriptor } from '../trace-analyst/tools'
import type { RawAnalystFinding } from './finding-signature'

/** Hard limits for one recursive trace investigation. */
export interface TraceAnalystLimits {
  /** Maximum controller iterations. */
  maxIterations: number
  /** Maximum recursive model queries issued from the controller program. */
  maxLlmCalls: number
  /** Maximum trace-store reads. */
  maxToolCalls: number
  /** Maximum controller output retained between iterations. */
  maxOutputChars: number
}

export const DEFAULT_TRACE_ANALYST_LIMITS: Readonly<TraceAnalystLimits> = {
  maxIterations: 12,
  maxLlmCalls: 8,
  maxToolCalls: 48,
  maxOutputChars: 10_000,
}

export interface TraceAnalysisEngineRequest {
  analystId: string
  question: string
  instructions: string
  tools: readonly TraceAnalysisToolDescriptor[]
  limits: TraceAnalystLimits
  costLedger: CostLedgerHandle
  costPhase: string
  costTags?: Record<string, string>
  signal?: AbortSignal
  log?: (message: string, fields?: Record<string, unknown>) => void
}

/** Complete result of one recursive investigation, before registry adaptation. */
export interface TraceAnalysisEngineResult {
  answer: string
  findings: RawAnalystFinding[]
  /** Engine-native steps retained for audit and debugging. */
  trajectory: readonly unknown[]
  /**
   * Successful model completions used by the engine.
   * The usage receipt may contain more provider attempts when a request fails.
   */
  modelCalls: number
  /** Trace-tool requests admitted for execution, including a tool that later fails. */
  toolCalls: number
  runtime: Record<string, unknown>
}

/**
 * A recursive research engine that can inspect traces with bounded tools.
 *
 * Implementations may use DSPy RLM, HALO, another upstream engine, or a
 * caller-owned implementation. The analyst definition and finding contract do
 * not change when the engine changes.
 */
export interface TraceAnalysisEngine {
  readonly id: string
  readonly description: string
  readonly model?: string
  analyze(request: TraceAnalysisEngineRequest): Promise<TraceAnalysisEngineResult>
}

export function resolveTraceAnalystLimits(
  limits: Partial<TraceAnalystLimits> | undefined,
): TraceAnalystLimits {
  const resolved = { ...DEFAULT_TRACE_ANALYST_LIMITS, ...limits }
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`trace analyst ${name} must be a positive safe integer`)
    }
  }
  return resolved
}
