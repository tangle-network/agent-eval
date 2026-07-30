import { type BehavioralAnalystOptions, behavioralAnalyst } from './behavioral-analyst'
import type { TraceAnalysisEngine } from './engine'
import { createTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import { DEFAULT_TRACE_ANALYST_KINDS } from './kinds'
import { AnalystRegistry, type AnalystRegistryOptions } from './registry'

export interface DefaultAnalystRegistryOptions {
  /**
   * Recursive engine for model-backed trace analysts. When omitted, the
   * registry contains only deterministic analysts.
   */
  engine?: TraceAnalysisEngine
  definitions?: readonly TraceAnalystDefinition[]
  includeBehavioral?: boolean
  behavioral?: BehavioralAnalystOptions
  registry?: AnalystRegistryOptions
}

export function buildDefaultAnalystRegistry(
  options: DefaultAnalystRegistryOptions = {},
): AnalystRegistry {
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
