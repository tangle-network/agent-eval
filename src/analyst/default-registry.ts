/**
 * `buildDefaultAnalystRegistry` — the canonical analyst suite, so consumers
 * stop hand-wiring `new AnalystRegistry()` + per-kind `createTraceAnalystKind`.
 *
 * The deterministic `behavioralAnalyst` is ALWAYS registered (it needs no
 * model and is model-agnostic by construction). The agentic RLM kinds are
 * registered only when an `ai` service is supplied — so a caller with no LLM
 * still gets the full behavioral/efficiency diagnosis, and the substrate's
 * "any model (including no model)" guarantee holds at the suite level.
 */

import type { AxAIService } from '@ax-llm/ax'
import { behavioralAnalyst } from './behavioral-analyst'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from './kind-factory'
import { DEFAULT_TRACE_ANALYST_KINDS } from './kinds'
import { AnalystRegistry, type AnalystRegistryOptions } from './registry'

export interface DefaultAnalystRegistryOptions {
  /** Ax service for the agentic RLM kinds. Omit → only the deterministic analyst. */
  ai?: AxAIService
  /** Required unless `ai` was created by `createAnalystAi`. */
  model?: string
  /** Which agentic kinds to register when `ai` is present. Default = the shipped suite. */
  kinds?: readonly TraceAnalystKindSpec[]
  /** Set false to omit the deterministic behavioral analyst (default: include). */
  includeBehavioral?: boolean
  /** Forwarded to the AnalystRegistry constructor (signal, tags, priorFindings). */
  registry?: AnalystRegistryOptions
}

export function buildDefaultAnalystRegistry(
  opts: DefaultAnalystRegistryOptions = {},
): AnalystRegistry {
  const registry = new AnalystRegistry(opts.registry)
  if (opts.includeBehavioral !== false) {
    registry.register(behavioralAnalyst())
  }
  if (opts.ai) {
    const kinds = opts.kinds ?? DEFAULT_TRACE_ANALYST_KINDS
    for (const spec of kinds) {
      registry.register(createTraceAnalystKind(spec, { ai: opts.ai, model: opts.model }))
    }
  }
  return registry
}
