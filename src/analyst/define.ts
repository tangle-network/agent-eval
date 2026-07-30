import type { TraceAnalystDefinition } from './kind-factory'

/**
 * Define a reusable trace-research question.
 *
 * The returned value contains no model, credentials, or execution state. Bind
 * it to any TraceAnalysisEngine with `runTraceAnalyst` or
 * `createTraceAnalyst`.
 */
export function defineTraceAnalyst(definition: TraceAnalystDefinition): TraceAnalystDefinition {
  for (const [name, value] of [
    ['id', definition.id],
    ['description', definition.description],
    ['area', definition.area],
    ['version', definition.version],
    ['instructions', definition.instructions],
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`defineTraceAnalyst: ${name} must be a non-empty string`)
    }
  }
  return {
    ...definition,
    limits: definition.limits ? { ...definition.limits } : undefined,
  }
}
