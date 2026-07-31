import { type BehavioralAnalystOptions, behavioralAnalyst } from './behavioral-analyst'
import type { TraceAnalysisEngine } from './engine'
import { createTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import { DEFAULT_TRACE_ANALYST_KINDS } from './kinds'
import { AnalystRegistry, type AnalystRegistryOptions } from './registry'

export interface DefaultAnalystRegistryOptions {
  /**
   * Recursive engine for model-backed trace analysts. When omitted, the
   * registry contains only deterministic analysts. The engine's id, version,
   * and model become the exact-run identity of every analyst it executes.
   */
  engine?: TraceAnalysisEngine
  definitions?: readonly TraceAnalystDefinition[]
  /** Set false to omit the deterministic behavioral analyst (default: include). */
  includeBehavioral?: boolean
  behavioral?: BehavioralAnalystOptions
  registry?: AnalystRegistryOptions
}

export function buildDefaultAnalystRegistry(
  options: DefaultAnalystRegistryOptions = {},
): AnalystRegistry {
  if (options.definitions && !options.engine) {
    throw new TypeError(
      'buildDefaultAnalystRegistry: definitions require an engine — a definition cannot run without one',
    )
  }
  const registry = new AnalystRegistry(options.registry)
  if (options.includeBehavioral !== false) {
    registry.register(behavioralAnalyst(options.behavioral))
  }
  if (options.engine) {
    for (const definition of options.definitions ?? DEFAULT_TRACE_ANALYST_KINDS) {
      registry.register(createTraceAnalyst(definition, { engine: options.engine }))
    }
  }
  return registry
}
