import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { ExactCapableAnalyst } from './exact-types'
import type { TraceAnalystDefinition } from './kind-factory'
import type { Analyst, AnalystCost } from './types'

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

export interface DefineCustomAnalystOptions {
  id: string
  description: string
  version?: string
  cost: AnalystCost
  analyze: Analyst<TraceAnalysisStore>['analyze']
}

export interface DefineExactCustomAnalystOptions extends DefineCustomAnalystOptions {
  /** Canonical JSON for behavior knobs not already bound by `version`. */
  executionConfig: Readonly<Record<string, unknown>>
}

/** Construct a registrable analyst from a hand-written analyze function. */
export function defineCustomAnalyst(
  options: DefineExactCustomAnalystOptions,
): ExactCapableAnalyst<TraceAnalysisStore>
export function defineCustomAnalyst(
  options: DefineCustomAnalystOptions,
): Analyst<TraceAnalysisStore>
export function defineCustomAnalyst(
  options: DefineCustomAnalystOptions | DefineExactCustomAnalystOptions,
): Analyst<TraceAnalysisStore> | ExactCapableAnalyst<TraceAnalysisStore> {
  if (!options.id.trim()) throw new TypeError('defineCustomAnalyst: id must not be empty')
  if (!options.description.trim()) {
    throw new TypeError('defineCustomAnalyst: description must not be empty')
  }
  if (options.cost === undefined) {
    throw new TypeError('defineCustomAnalyst: cost must be declared')
  }
  if (
    'executionConfig' in options &&
    (!options.executionConfig ||
      typeof options.executionConfig !== 'object' ||
      Array.isArray(options.executionConfig))
  ) {
    throw new TypeError('defineCustomAnalyst: executionConfig must be an object')
  }
  return {
    id: options.id,
    description: options.description,
    version: options.version ?? '1.0.0',
    inputKind: 'trace-store',
    cost: options.cost,
    analyze: options.analyze,
    ...('executionConfig' in options ? { executionConfig: options.executionConfig } : {}),
  }
}
