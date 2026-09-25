import { describe, expect, it } from 'vitest'
import type { OtlpExport } from '../src/trace/otel'
import { flattenOtlpExportToNdjson } from '../src/trace-analyst/otlp-flatten'

// ── T04 flattenOtlpExportToNdjson ────────────────────────────────────
const otlp: OtlpExport = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'agent-x' } }] },
      scopeSpans: [
        {
          scope: { name: '@tangle-network/agent-eval', version: '0.3.0' },
          spans: [
            {
              traceId: 't1',
              spanId: 's1',
              name: 'llm.call',
              kind: 3,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              attributes: [
                { key: 'llm.model', value: { stringValue: 'claude-sonnet' } },
                { key: 'llm.tokens.in', value: { intValue: '1200' } },
                { key: 'span.kind', value: { stringValue: 'llm' } },
              ],
              status: { code: 2, message: 'rate_limited' },
            },
          ],
        },
      ],
    },
  ],
}

describe('flattenOtlpExportToNdjson', () => {
  it('flattens to the OtlpFileTraceStore line shape with mapped codes + ISO times', () => {
    const lines = flattenOtlpExportToNdjson(otlp)
    expect(lines).toHaveLength(1)
    const l = lines[0]!
    expect(l.trace_id).toBe('t1')
    expect(l.span_id).toBe('s1')
    expect(l.parent_span_id).toBeNull()
    expect(l.kind).toBe('SPAN_KIND_CLIENT') // numeric 3
    expect(l.status).toEqual({ code: 'STATUS_CODE_ERROR', message: 'rate_limited' })
    expect(l.start_time).toBe('2023-11-14T22:13:20.000Z')
    expect(l.resource.attributes['service.name']).toBe('agent-x')
    // attribute values unwrapped to scalars (intValue → number)
    expect(l.attributes['llm.tokens.in']).toBe(1200)
  })

  it('mirrors attributes into the OpenInference vocabulary by default', () => {
    const l = flattenOtlpExportToNdjson(otlp)[0]!
    expect(l.attributes['llm.model_name']).toBe('claude-sonnet')
    expect(l.attributes['openinference.span.kind']).toBe('LLM')
  })

  it('passes attributes through untouched under vocabulary "none"', () => {
    const l = flattenOtlpExportToNdjson(otlp, { attributeVocabulary: 'none' })[0]!
    expect(l.attributes['llm.model_name']).toBeUndefined()
    expect(l.attributes['llm.model']).toBe('claude-sonnet')
  })
})
