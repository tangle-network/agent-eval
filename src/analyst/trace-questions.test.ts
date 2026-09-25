import { describe, expect, it } from 'vitest'
import { CostLedger } from '../cost-ledger'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import type { TraceAnalysisEngine, TraceAnalysisEngineRequest } from './engine'
import type { RawAnalystFinding } from './finding-signature'
import { askTraceQuestions, citedSpansOnly } from './trace-questions'

const rows: TraceAnalystSpan[] = [
  span('claim', 'I verified all 20 primes.'),
  span('write', 'wrote primes.txt with 19 lines'),
  span('test', 'no test was run'),
]

describe('askTraceQuestions', () => {
  it('asks every question in a bounded pool, admits cited findings, and verifies each one', async () => {
    const requests: TraceAnalysisEngineRequest[] = []
    let active = 0
    let peak = 0
    const engine = fakeEngine(async (request) => {
      requests.push(request)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((done) => setTimeout(done, 5))
      active -= 1
      if (request.analystId.startsWith('verify.')) {
        // The verifier supports the claim about the file and rejects the claim about testing.
        return result(
          request.question.includes('19 lines')
            ? 'SUPPORTED\nspan write says 19.'
            : 'NOT SUPPORTED\nno span shows it.',
        )
      }
      if (request.analystId === 'question.q-claims') {
        return result('The director claimed 20 primes; the file has 19.', [
          finding('The director claimed 20 primes but wrote 19 lines.', ['claim', 'write']),
          finding('The director ran the tests.', ['claim', 'test']),
          // One citation only: runTraceAnalyst refuses it before any verifier sees it.
          finding('The director wrote the file once.', ['write']),
        ])
      }
      if (request.analystId === 'question.q-broken') throw new Error('engine down')
      return result('not in trace')
    })
    const outcomes = await askTraceQuestions({
      questions: [
        { id: 'q-claims', question: 'What did the director claim, and which span verifies it?' },
        { id: 'q-broken', question: 'Which spans touch a test file?' },
        { id: 'q-idle', question: 'Where did turns pass without progress?' },
      ],
      store: traceStore(rows),
      engine,
      costLedger: new CostLedger(5),
      runId: 'panel-1',
      context: 'FAIL prime-count primes.txt:1: 19 primes, expected 20',
      concurrency: 2,
    })
    expect(peak).toBeLessThanOrEqual(2)
    expect(outcomes.map((outcome) => [outcome.id, outcome.status])).toEqual([
      ['q-claims', 'answered'],
      ['q-broken', 'failed'],
      ['q-idle', 'answered'],
    ])
    expect(outcomes[1]?.failure).toContain('engine down')
    const claims = outcomes[0]?.findings ?? []
    expect(claims.map((item) => [item.finding.claim, item.verified])).toEqual([
      ['The director claimed 20 primes but wrote 19 lines.', true],
      ['The director ran the tests.', false],
    ])
    expect(claims[0]?.citations).toEqual(['trace://run-1/span/claim', 'trace://run-1/span/write'])
    // Every question sees the shared context; the verifier sees only the claim and its spans.
    const question = requests.find((request) => request.analystId === 'question.q-claims')
    expect(question?.instructions).toContain('FAIL prime-count')
    const verifier = requests.find((request) => request.analystId.startsWith('verify.'))
    expect(verifier?.tools.map((tool) => tool.name)).toEqual([
      'getDatasetOverview',
      'queryTraces',
      'viewSpans',
      'searchSpan',
    ])
    expect(verifier?.instructions).not.toContain('FAIL prime-count')
  })

  it('refuses malformed questions before any model call', async () => {
    let calls = 0
    const engine = fakeEngine(async () => {
      calls += 1
      return result('x')
    })
    const base = { store: traceStore(rows), engine, costLedger: new CostLedger(1), runId: 'r' }
    await expect(
      askTraceQuestions({ ...base, questions: [{ id: 'bad id', question: 'x' }] }),
    ).rejects.toThrow(/malformed/)
    await expect(
      askTraceQuestions({
        ...base,
        questions: [
          { id: 'a', question: 'x' },
          { id: 'a', question: 'y' },
        ],
      }),
    ).rejects.toThrow(/duplicate/)
    expect(calls).toBe(0)
  })
})

describe('citedSpansOnly', () => {
  it('exposes exactly the cited spans and refuses every wider read', async () => {
    const store = citedSpansOnly(traceStore(rows), new Map([['run-1', new Set(['write'])]]))
    expect(await store.hasTrace('run-1')).toBe(true)
    expect(await store.hasTrace('other')).toBe(false)
    expect(await store.hasSpans({ trace_id: 'run-1', span_ids: ['write', 'claim'] })).toEqual([
      'write',
    ])
    const viewed = await store.viewSpans({ trace_id: 'run-1', span_ids: ['write', 'claim'] })
    expect(viewed.spans.map((row) => row.span_id)).toEqual(['write'])
    await expect(store.viewSpans({ trace_id: 'run-1', span_ids: ['claim'] })).rejects.toThrow(
      /only the cited spans/,
    )
    await expect(store.viewTrace({ trace_id: 'run-1' })).rejects.toThrow(/not available/)
    await expect(store.queryTraces({ limit: 5 })).rejects.toThrow(/not available/)
  })
})

function result(answer: string, findings: RawAnalystFinding[] = []) {
  return { answer, findings, trajectory: [], modelCalls: 1, toolCalls: 1, runtime: {} }
}

function finding(claim: string, spanIds: string[]): RawAnalystFinding {
  return {
    severity: 'high',
    claim,
    confidence: 0.9,
    evidence: spanIds.map((spanId) => ({
      uri: `trace://run-1/span/${spanId}`,
      excerpt: rows.find((row) => row.span_id === spanId)?.attributes.content as string,
    })),
  }
}

function fakeEngine(analyze: TraceAnalysisEngine['analyze']): TraceAnalysisEngine {
  return {
    id: 'test-engine',
    description: 'test',
    model: 'test-model',
    version: '1.0.0',
    executionConfig: { base_url: 'https://engine.test' },
    analyze,
  }
}

function span(spanId: string, content: string): TraceAnalystSpan {
  return {
    trace_id: 'run-1',
    span_id: spanId,
    parent_span_id: null,
    name: 'message.assistant',
    kind: 'LLM',
    start_time: '2026-09-25T00:00:00.000Z',
    end_time: '2026-09-25T00:00:01.000Z',
    duration_ms: 1_000,
    status: 'OK',
    service_name: 'test',
    agent_name: 'director',
    model_name: 'test-model',
    tool_name: null,
    attributes: { content },
  }
}

function traceStore(spans: TraceAnalystSpan[]): TraceAnalysisStore {
  const store: Pick<TraceAnalysisStore, 'hasTrace' | 'hasSpans' | 'viewSpans'> = {
    async hasTrace(traceId) {
      return spans.some((row) => row.trace_id === traceId)
    },
    async hasSpans({ trace_id, span_ids }) {
      return spans
        .filter((row) => row.trace_id === trace_id && span_ids.includes(row.span_id))
        .map((row) => row.span_id)
    },
    async viewSpans({ trace_id, span_ids }) {
      const found = spans.filter(
        (row) => row.trace_id === trace_id && span_ids.includes(row.span_id),
      )
      const ids = new Set(found.map((row) => row.span_id))
      return {
        trace_id,
        spans: found,
        missing_span_ids: span_ids.filter((id) => !ids.has(id)),
        omitted_span_ids: [],
        has_more: false,
        truncated_attribute_count: 0,
      }
    },
  }
  return store as unknown as TraceAnalysisStore
}
