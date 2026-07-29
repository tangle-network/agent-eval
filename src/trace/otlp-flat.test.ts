import { describe, expect, it } from 'vitest'
import { createOtlpFlatLine, epochMillisToIso, spanStatusToOtlp } from './otlp-flat'

const BASE = {
  traceId: 'trace',
  spanId: 'span',
  parentSpanId: null,
  name: 'tool.read',
  kind: 'SPAN_KIND_INTERNAL',
  startTime: '1970-01-01T00:00:00.000Z',
  endTime: '1970-01-01T00:00:00.001Z',
  statusCode: 'STATUS_CODE_OK' as const,
  resource: { attributes: {} },
  attributes: {},
}

describe('OTLP flat projection', () => {
  it('preserves an explicitly empty status message and omits absent events', () => {
    expect(createOtlpFlatLine({ ...BASE, statusMessage: '' })).toMatchObject({
      status: { code: 'STATUS_CODE_OK', message: '' },
    })
    expect(createOtlpFlatLine({ ...BASE, events: [] })).not.toHaveProperty('events')
  })

  it('omits an absent status message and includes non-empty events', () => {
    expect(createOtlpFlatLine(BASE).status).toEqual({ code: 'STATUS_CODE_OK' })
    expect(createOtlpFlatLine({ ...BASE, events: [{ name: 'attempt' }] }).events).toEqual([
      { name: 'attempt' },
    ])
  })

  it('rejects non-finite and out-of-range epoch values without throwing', () => {
    expect(epochMillisToIso(Number.NaN)).toBeUndefined()
    expect(epochMillisToIso(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(epochMillisToIso(9e15)).toBeUndefined()
    expect(epochMillisToIso(0)).toBe('1970-01-01T00:00:00.000Z')
  })

  it('maps status, errors, and caller defaults deterministically', () => {
    expect(spanStatusToOtlp('error', undefined, 'STATUS_CODE_UNSET')).toBe('STATUS_CODE_ERROR')
    expect(spanStatusToOtlp('ok', 'captured error', 'STATUS_CODE_UNSET')).toBe('STATUS_CODE_ERROR')
    expect(spanStatusToOtlp('ok', undefined, 'STATUS_CODE_UNSET')).toBe('STATUS_CODE_OK')
    expect(spanStatusToOtlp(undefined, undefined, 'STATUS_CODE_UNSET')).toBe('STATUS_CODE_UNSET')
  })
})
