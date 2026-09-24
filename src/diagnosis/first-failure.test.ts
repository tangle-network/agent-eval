import { describe, expect, it } from 'vitest'
import { diagnoseSpans, ingestSpans, rankFirstFailure } from './index'

const T0 = Date.parse('2026-09-22T10:00:00Z')
const at = (ms: number) => `${BigInt(T0 + ms) * 1_000_000n}`

interface FlatSpan {
  id: string
  parent?: string
  kind?: string
  start?: number
  end?: number | null
  error?: string | true
  outcome?: 'pass' | 'fail' | 'error'
  trace?: string
}

function flat(spec: FlatSpan): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    'openinference.span.kind': spec.kind ?? 'TOOL',
  }
  if (spec.outcome) attributes['agent.outcome'] = spec.outcome
  return {
    trace_id: spec.trace ?? 't1',
    span_id: spec.id,
    parent_span_id: spec.parent ?? null,
    name: spec.id,
    start_time: at(spec.start ?? 0),
    ...(spec.end === null ? {} : { end_time: at(spec.end ?? (spec.start ?? 0) + 10) }),
    status_code: spec.error ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK',
    ...(typeof spec.error === 'string' ? { status_message: spec.error } : {}),
    attributes,
  }
}

function rankOf(specs: FlatSpan[]) {
  const { spans } = ingestSpans(specs.map(flat), { contentIncluded: true })
  return rankFirstFailure(spans)
}

describe('rankFirstFailure', () => {
  it('ranks the failing span inside a failing parent, not the parent that started first', () => {
    const result = rankOf([
      { id: 'root', kind: 'AGENT', start: 0, end: 100, error: 'agent gave up' },
      { id: 'llm', parent: 'root', kind: 'LLM', start: 10, end: 20 },
      {
        id: 'call',
        parent: 'root',
        kind: 'LLM',
        start: 30,
        end: 40,
        error: 'connect ECONNREFUSED',
      },
    ])
    expect(result).toMatchObject({
      status: 'found',
      stage: 'error-span',
      spanId: 'call',
      kind: 'LLM',
      message: 'connect ECONNREFUSED',
      classification: { failureClass: 'bridge_unreachable', blame: 'machine' },
      blame: 'machine',
      later: [],
      laterCount: 0,
    })
  })

  it('orders independent failures by when they ended and lists the rest', () => {
    const result = rankOf([
      { id: 'root', kind: 'AGENT', start: 0, end: 100 },
      { id: 'late', parent: 'root', start: 5, end: 90, error: 'exit 1' },
      { id: 'early', parent: 'root', start: 10, end: 20, error: 'exit 2' },
    ])
    expect(result).toMatchObject({ status: 'found', spanId: 'early', later: ['late'] })
  })

  it('refuses to pick between failures that ended at the same instant', () => {
    const result = rankOf([
      { id: 'a', start: 0, end: 50, error: 'x' },
      { id: 'b', start: 10, end: 50, error: 'y' },
    ])
    expect(result).toMatchObject({
      status: 'ambiguous',
      stage: 'error-span',
      candidates: ['a', 'b'],
      candidateCount: 2,
    })
  })

  it('refuses to order failures when one has no end time', () => {
    const result = rankOf([
      { id: 'a', start: 0, end: null, error: 'x' },
      { id: 'b', start: 10, end: 20, error: 'y' },
    ])
    expect(result).toMatchObject({ status: 'ambiguous', candidates: ['a', 'b'] })
    expect(result.status === 'ambiguous' && result.reason).toMatch(/no end time/)
  })

  it('keeps a failure without a message unreported instead of guessing its blame', () => {
    const result = rankOf([{ id: 'a', error: true }])
    expect(result).toMatchObject({
      status: 'found',
      message: null,
      classification: { failureClass: 'unreported', blame: 'unknown' },
      blame: 'unknown',
    })
  })

  it('falls back to a failed graded outcome when nothing errored', () => {
    const result = rankOf([
      { id: 'run', kind: 'AGENT', start: 0, end: 100 },
      { id: 'grade', parent: 'run', kind: 'EVALUATOR', start: 100, end: 101, outcome: 'fail' },
    ])
    expect(result).toMatchObject({
      status: 'found',
      stage: 'failed-outcome',
      spanId: 'grade',
      classification: null,
      blame: 'agent',
    })
  })

  it('counts an error outcome as a failing span', () => {
    const result = rankOf([
      { id: 'grade', kind: 'EVALUATOR', outcome: 'fail', start: 0, end: 5 },
      { id: 'judge', kind: 'EVALUATOR', outcome: 'error', start: 10, end: 20 },
    ])
    expect(result).toMatchObject({ status: 'found', stage: 'error-span', spanId: 'judge' })
  })

  it('says none when no span failed', () => {
    const result = rankOf([
      { id: 'run', kind: 'AGENT', start: 0, end: 100 },
      { id: 'grade', parent: 'run', kind: 'EVALUATOR', outcome: 'pass' },
    ])
    expect(result).toEqual({
      status: 'none',
      traceId: 't1',
      reason: 'none of 2 spans has status ERROR or an agent.outcome of error or fail',
    })
  })

  it('reports cyclic containment as ambiguous', () => {
    const result = rankOf([
      { id: 'a', parent: 'b', start: 0, end: 10, error: 'x' },
      { id: 'b', parent: 'a', start: 0, end: 20, error: 'y' },
    ])
    expect(result).toMatchObject({ status: 'ambiguous', candidates: ['a', 'b'] })
  })

  it('rejects spans from two traces', () => {
    const { spans } = ingestSpans([flat({ id: 'a' }), flat({ id: 'b', trace: 't2' })], {
      contentIncluded: true,
    })
    expect(() => rankFirstFailure(spans)).toThrow(/more than one trace/)
  })
})

describe('diagnoseSpans first failures', () => {
  it('reports one first failure per run in the deterministic facts', async () => {
    const result = await diagnoseSpans(
      [
        flat({ id: 'a-root', trace: 'ta', kind: 'AGENT', start: 0, end: 50 }),
        flat({ id: 'a-tool', trace: 'ta', parent: 'a-root', start: 5, end: 10, error: 'boom' }),
        flat({ id: 'b-root', trace: 'tb', kind: 'AGENT', start: 0, end: 50 }),
      ],
      { subject: 'internal', label: 'first failures' },
      { mode: 'deterministic' },
    )
    expect(result.facts.firstFailures.map((failure) => [failure.traceId, failure.status])).toEqual([
      ['ta', 'found'],
      ['tb', 'none'],
    ])
  })
})
