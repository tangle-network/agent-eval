import { describe, expect, it } from 'vitest'
import { summarizeTraceErrors, type TraceErrorSignal } from './error-classification'
import { traceSpanKindToOpenInferenceKind } from './otlp-attributes'

const signal = (
  id: string,
  role: TraceErrorSignal['role'],
  options: Partial<TraceErrorSignal> = {},
): TraceErrorSignal => ({
  id,
  role,
  error: true,
  processRoot: false,
  ...options,
})

describe('summarizeTraceErrors', () => {
  it('exports first-party judge spans as evaluators', () => {
    expect(traceSpanKindToOpenInferenceKind('judge')).toBe('EVALUATOR')
  })

  it('separates a failed process root from its failed tool action', () => {
    expect(
      summarizeTraceErrors([
        signal('root', 'AGENT', { processRoot: true }),
        signal('tool', 'TOOL', { parentId: 'root' }),
      ]),
    ).toEqual({
      total: 2,
      execution: 1,
      process: 1,
      guardrail: 0,
      evaluation: 0,
      propagated: 0,
      unclassified: 0,
    })
  })

  it('does not count a propagated child-agent status twice', () => {
    expect(
      summarizeTraceErrors([
        signal('root', 'AGENT', { error: false, processRoot: true }),
        signal('step', 'AGENT', { parentId: 'root' }),
        signal('tool', 'TOOL', { parentId: 'step' }),
      ]),
    ).toMatchObject({ total: 2, execution: 1, propagated: 1 })
  })

  it('keeps guardrail, evaluation, and unknown errors out of execution errors', () => {
    expect(
      summarizeTraceErrors([
        signal('guard', 'GUARDRAIL'),
        signal('eval', 'EVALUATOR'),
        signal('unknown', 'UNKNOWN'),
      ]),
    ).toMatchObject({
      total: 3,
      execution: 0,
      guardrail: 1,
      evaluation: 1,
      unclassified: 1,
    })
  })

  it('rejects duplicate span identities', () => {
    expect(() =>
      summarizeTraceErrors([signal('duplicate', 'TOOL'), signal('duplicate', 'LLM')]),
    ).toThrow(/duplicate span id/)
  })
})
