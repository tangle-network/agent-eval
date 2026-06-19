import { describe, expect, it } from 'vitest'
import { otlpToRunRecords } from './otlp-to-run-records'

// One OTLP-flat span line with sane defaults.
function line(o: Record<string, unknown>): string {
  return JSON.stringify({ status: { code: 'OK' }, attributes: {}, ...o })
}
const opts = { experimentId: 'e', candidateId: 'c' } as const

describe('otlpToRunRecords timestamp handling (epoch + ISO dialects)', () => {
  it('computes wallMs from epoch-millis-string timestamps — Date.parse would NaN→0', () => {
    const jsonl = line({
      trace_id: 't1',
      span_id: 'a',
      name: 'llm',
      start_time: '1700000000000',
      end_time: '1700000005000',
      attributes: {
        'openinference.span.kind': 'LLM',
        'llm.input_tokens': 10,
        'llm.output_tokens': 2,
      },
    })
    const recs = otlpToRunRecords(jsonl, opts)
    expect(recs).toHaveLength(1)
    // Pre-fix: Date.parse('1700000000000') is NaN → wallMs silently 0.
    expect(recs[0]!.wallMs).toBe(5000)
  })

  it('orders trace bounds by real time across mixed ISO + epoch dialects', () => {
    const jsonl = [
      line({
        trace_id: 't2',
        span_id: 'older',
        name: 'llm',
        start_time: '1700000000000',
        end_time: '1700000001000',
        attributes: { 'openinference.span.kind': 'LLM' },
      }),
      line({
        trace_id: 't2',
        span_id: 'newer',
        name: 'llm',
        start_time: '2024-01-01T00:00:00.000Z',
        end_time: '2024-01-01T00:00:10.000Z',
        attributes: { 'openinference.span.kind': 'LLM' },
      }),
    ].join('\n')
    const recs = otlpToRunRecords(jsonl, opts)
    expect(recs).toHaveLength(1)
    const expected = Date.parse('2024-01-01T00:00:10.000Z') - 1_700_000_000_000
    expect(recs[0]!.wallMs).toBe(expected)
  })
})
