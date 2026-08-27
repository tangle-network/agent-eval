import { describe, expect, it } from 'vitest'
import { projectOtlpFlatLine } from './otlp-span'

describe('projectOtlpFlatLine', () => {
  it('returns null when trace_id is missing', () => {
    expect(projectOtlpFlatLine({ span_id: 's1' })).toBeNull()
  })

  it('returns null when span_id is missing', () => {
    expect(projectOtlpFlatLine({ trace_id: 't1' })).toBeNull()
  })

  it('projects a line that has both trace_id and span_id', () => {
    const out = projectOtlpFlatLine({ trace_id: 't1', span_id: 's1' })
    expect(out).not.toBeNull()
    expect(out!.trace_id).toBe('t1')
    expect(out!.span_id).toBe('s1')
  })

  it('resolves camelCase pivots (traceId/spanId/parentSpanId/startTime/endTime)', () => {
    const out = projectOtlpFlatLine({
      traceId: 'tc',
      spanId: 'sc',
      parentSpanId: 'pc',
      startTime: '2024-01-01T00:00:00.000Z',
      endTime: '2024-01-01T00:00:01.000Z',
    })
    expect(out).not.toBeNull()
    expect(out!.trace_id).toBe('tc')
    expect(out!.span_id).toBe('sc')
    expect(out!.parent_span_id).toBe('pc')
    expect(out!.duration_ms).toBe(1000)
  })

  it('resolves snake_case pivots (trace_id/span_id/parent_span_id/start_time/end_time)', () => {
    const out = projectOtlpFlatLine({
      trace_id: 'ts',
      span_id: 'ss',
      parent_span_id: 'ps',
      start_time: '2024-01-01T00:00:00.000Z',
      end_time: '2024-01-01T00:00:02.500Z',
    })
    expect(out).not.toBeNull()
    expect(out!.parent_span_id).toBe('ps')
    expect(out!.duration_ms).toBe(2500)
  })

  it('computes duration from epoch-millisecond timestamps', () => {
    const out = projectOtlpFlatLine({
      trace_id: 'te',
      span_id: 'se',
      start_time: '1704067200000',
      end_time: '1704067200400',
    })
    expect(out).not.toBeNull()
    expect(out!.duration_ms).toBe(400)
  })

  it('span attributes override resource attributes on key overlap', () => {
    const out = projectOtlpFlatLine({
      trace_id: 't',
      span_id: 's',
      resource: { attributes: { 'service.name': 'from-resource', 'only.resource': 'r' } },
      attributes: { 'service.name': 'from-span', 'only.span': 'sp' },
    })
    expect(out).not.toBeNull()
    // span attribute wins
    expect(out!.attributes['service.name']).toBe('from-span')
    expect(out!.service_name).toBe('from-span')
    // non-overlapping keys from both layers survive
    expect(out!.attributes['only.resource']).toBe('r')
    expect(out!.attributes['only.span']).toBe('sp')
  })

  it('clamps duration to 0 when timestamps are unparseable', () => {
    const out = projectOtlpFlatLine({
      trace_id: 't',
      span_id: 's',
      start_time: 'not-a-date',
      end_time: 'also-not-a-date',
    })
    expect(out).not.toBeNull()
    expect(out!.duration_ms).toBe(0)
  })

  it('clamps duration to 0 when end precedes start (never negative)', () => {
    const out = projectOtlpFlatLine({
      trace_id: 't',
      span_id: 's',
      start_time: '2024-01-01T00:00:05.000Z',
      end_time: '2024-01-01T00:00:01.000Z',
    })
    expect(out).not.toBeNull()
    expect(out!.duration_ms).toBe(0)
  })

  it('defaults end_time to start_time when end is absent (duration 0)', () => {
    const out = projectOtlpFlatLine({
      trace_id: 't',
      span_id: 's',
      start_time: '2024-01-01T00:00:05.000Z',
    })
    expect(out).not.toBeNull()
    expect(out!.duration_ms).toBe(0)
    expect(out!.end_time).toBe('2024-01-01T00:00:05.000Z')
  })
})
