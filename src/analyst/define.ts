import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { Analyst, AnalystCost, AnalystFinding } from './types'

export interface DefineTraceAnalystOptions {
  id: string
  description: string
  version?: string
  cost: AnalystCost
  analyze: Analyst<TraceAnalysisStore>['analyze']
}

/** Define a custom trace analyst without repeating fixed registry fields. */
export function defineTraceAnalyst(
  options: DefineTraceAnalystOptions,
): Analyst<TraceAnalysisStore> {
  if (!options.id.trim()) throw new TypeError('defineTraceAnalyst: id must not be empty')
  if (!options.description.trim()) {
    throw new TypeError('defineTraceAnalyst: description must not be empty')
  }
  if (options.cost === undefined) {
    throw new TypeError('defineTraceAnalyst: cost must be declared')
  }
  return {
    id: options.id,
    description: options.description,
    version: options.version ?? '1.0.0',
    inputKind: 'trace-store',
    cost: options.cost,
    analyze: options.analyze,
  }
}

export type TraceAnalystAnalyze = (
  store: TraceAnalysisStore,
  context: Parameters<Analyst<TraceAnalysisStore>['analyze']>[1],
) => Promise<AnalystFinding[]>
