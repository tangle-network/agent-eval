import type { OtlpSpanRole } from './otlp-attributes'

export type TraceErrorRole = OtlpSpanRole

export interface TraceErrorSignal {
  id: string
  parentId?: string
  role: TraceErrorRole
  error: boolean
  processRoot: boolean
}

export interface TraceErrorSummary {
  total: number
  execution: number
  process: number
  guardrail: number
  evaluation: number
  propagated: number
  unclassified: number
}

/**
 * Classify errored spans without counting a propagated parent status as a
 * second execution failure.
 */
export function summarizeTraceErrors(signals: readonly TraceErrorSignal[]): TraceErrorSummary {
  const byId = new Map<string, TraceErrorSignal>()
  for (const signal of signals) {
    if (byId.has(signal.id)) {
      throw new Error(`summarizeTraceErrors: duplicate span id '${signal.id}'`)
    }
    byId.set(signal.id, signal)
  }

  const propagated = new Set<string>()
  for (const signal of signals) {
    if (!signal.error) continue
    const visited = new Set<string>()
    let parentId = signal.parentId
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) break
      if (parent.error) propagated.add(parent.id)
      parentId = parent.parentId
    }
  }

  const summary: TraceErrorSummary = {
    total: 0,
    execution: 0,
    process: 0,
    guardrail: 0,
    evaluation: 0,
    propagated: 0,
    unclassified: 0,
  }

  for (const signal of signals) {
    if (!signal.error) continue
    summary.total += 1
    if (signal.role === 'GUARDRAIL') {
      summary.guardrail += 1
    } else if (signal.role === 'EVALUATOR') {
      summary.evaluation += 1
    } else if (signal.processRoot) {
      summary.process += 1
    } else if (propagated.has(signal.id)) {
      summary.propagated += 1
    } else if (
      signal.role === 'AGENT' ||
      signal.role === 'CHAIN' ||
      signal.role === 'LLM' ||
      signal.role === 'TOOL'
    ) {
      summary.execution += 1
    } else {
      summary.unclassified += 1
    }
  }

  return summary
}
