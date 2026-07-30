import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { ExactCapableAnalyst } from './exact-types'
import type { Analyst, AnalystCost, AnalystFinding } from './types'

export interface DefineTraceAnalystOptions {
  id: string
  description: string
  version?: string
  cost: AnalystCost
  analyze: Analyst<TraceAnalysisStore>['analyze']
}

export interface DefineExactTraceAnalystOptions extends DefineTraceAnalystOptions {
  /** Canonical JSON for behavior knobs not already bound by `version`. */
  executionConfig: Readonly<Record<string, unknown>>
}

/** Define a custom trace analyst without repeating fixed registry fields. */
export function defineTraceAnalyst(
  options: DefineExactTraceAnalystOptions,
): ExactCapableAnalyst<TraceAnalysisStore>
export function defineTraceAnalyst(options: DefineTraceAnalystOptions): Analyst<TraceAnalysisStore>
export function defineTraceAnalyst(
  options: DefineTraceAnalystOptions | DefineExactTraceAnalystOptions,
): Analyst<TraceAnalysisStore> | ExactCapableAnalyst<TraceAnalysisStore> {
  if (!options.id.trim()) throw new TypeError('defineTraceAnalyst: id must not be empty')
  if (!options.description.trim()) {
    throw new TypeError('defineTraceAnalyst: description must not be empty')
  }
  if (options.cost === undefined) {
    throw new TypeError('defineTraceAnalyst: cost must be declared')
  }
  if (
    'executionConfig' in options &&
    (!options.executionConfig ||
      typeof options.executionConfig !== 'object' ||
      Array.isArray(options.executionConfig))
  ) {
    throw new TypeError('defineTraceAnalyst: executionConfig must be an object')
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

export type TraceAnalystAnalyze = (
  store: TraceAnalysisStore,
  context: Parameters<Analyst<TraceAnalysisStore>['analyze']>[1],
) => Promise<AnalystFinding[]>
