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

const DEFAULT_TRACE_ANALYST_LIMITS: Readonly<TraceAnalystLimits> = {
  maxIterations: 12,
  maxLlmCalls: 8,
  maxToolCalls: 48,
  maxOutputChars: 10_000,
}

/**
 * Completion cap one engine turn asks for when the caller names none.
 *
 * Shared by every engine because the number is load-bearing and has one
 * failure story, not two: 4096 is below what current coding models emit for a
 * full findings array — glm-5.2 through an OpenAI-compatible gateway returns
 * 8192 and the request is rejected outright (`502 — provider reported 8192
 * completion tokens, exceeding requested limit 4096`), which failed 2 of 2
 * smoke cases before any analysis ran. Two engines holding private copies of
 * this would have to move in lockstep or diverge on spend behaviour silently.
 *
 * The cap exists to bound a single response, not to bound spend: the cost
 * ledger does that directly, so this starts above what a real report needs.
 */
export const DEFAULT_TRACE_ANALYST_OUTPUT_TOKENS = 16_384

export interface TraceAnalysisEngineRequest {
  analystId: string
  question: string
  instructions: string
  tools: readonly TraceAnalysisToolDescriptor[]
  /**
   * Task material delivered as structured input instead of fetched through
   * tools, for a subject that lives outside any trace store.
   *
   * An engine with a code environment binds these as variables, which is what
   * lets a typed program read the subject with code rather than parse it back
   * out of prompt text. An engine that cannot honour them must throw: dropping
   * them silently would answer a question about material the caller never
   * delivered.
   */
  taskInputs?: Readonly<Record<string, unknown>>
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
  /** Implementation version. Changes whenever execution behavior changes. */
  readonly version: string
  /**
   * Canonical JSON for every effective engine knob not already bound by
   * `version` — endpoint, budgets, timeouts, whether a credential was supplied.
   * Sealed into the exact-run execution plan, so two engines pointed at
   * different providers must not produce the same value. Never carries a
   * secret: a credential is recorded as a boolean.
   */
  readonly executionConfig: Readonly<Record<string, unknown>>
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
