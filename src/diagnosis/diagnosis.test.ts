import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'

import { diagnoseSpans, epochMillis, ingestSpans } from './index'

// Built at runtime so no literal credential shape sits in the source tree.
const OPENAI = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('-')

// Same JSON as tangle-network/traces main (ebae7c9)
// diagnosis-kit/templates/findings.schema.json, the schema the kit validates with.
import schema from './fixtures/diagnosis-findings-v1.schema.json'

const validateAgainstKitSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
function kitSchemaErrors(document: unknown): string[] {
  return validateAgainstKitSchema(document)
    ? []
    : (validateAgainstKitSchema.errors ?? []).map((e) => `${e.instancePath} ${e.message}`)
}

const NS = (iso: string, plusMs = 0) => `${BigInt(Date.parse(iso) + plusMs) * 1_000_000n}`

function span(over: Record<string, unknown>): Record<string, unknown> {
  return {
    trace_id: 't1',
    span_id: 's1',
    parent_span_id: null,
    name: 'step',
    start_time: NS('2026-09-22T10:00:00Z'),
    end_time: NS('2026-09-22T10:00:01Z'),
    status_code: 'STATUS_CODE_OK',
    attributes: {},
    ...over,
  }
}

/** One run: a root agent span and six Bash calls, four failing, three identical in a row. */
function sampleRun(traceId = 't1', prefix = ''): Record<string, unknown>[] {
  const out = [
    span({
      trace_id: traceId,
      span_id: `${prefix}root`,
      name: 'session',
      status_code: 'STATUS_CODE_ERROR',
      status_message: 'agent gave up',
      attributes: { 'openinference.span.kind': 'AGENT' },
    }),
  ]
  for (let i = 0; i < 6; i += 1) {
    out.push(
      span({
        trace_id: traceId,
        span_id: `${prefix}tool${i}`,
        parent_span_id: `${prefix}root`,
        name: 'Bash',
        start_time: NS('2026-09-22T10:00:00Z', (i + 1) * 1000),
        end_time: NS('2026-09-22T10:00:00Z', (i + 1) * 1000 + 500),
        status_code: i < 4 ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK',
        status_message: i < 4 ? 'command not found' : undefined,
        attributes: {
          'openinference.span.kind': 'TOOL',
          'tool.name': 'Bash',
          input: i < 3 ? 'make test' : `echo ${i}`,
        },
      }),
    )
  }
  return out
}

describe('ingest', () => {
  it('reads OTLP nanoseconds, epoch milliseconds and ISO times', () => {
    const ms = Date.parse('2026-09-22T10:00:00Z')
    expect(epochMillis(NS('2026-09-22T10:00:00Z'))).toBe(ms)
    expect(epochMillis(String(ms))).toBe(ms)
    expect(epochMillis('2026-09-22T10:00:00Z')).toBe(ms)
    expect(epochMillis('')).toBeNull()
  })

  it('drops content attributes when content is not included, after taking the input digest', () => {
    const { spans, report } = ingestSpans(sampleRun(), { contentIncluded: false })
    const tool = spans.find((s) => s.spanId === 'tool0')!
    expect(tool.attributes.input).toBeUndefined()
    expect(tool.inputDigest).toMatch(/^[0-9a-f]{16}$/)
    expect(report.droppedAttributes).toContain('input')
  })

  it('keeps a span id shared by two runs but marks it ambiguous', () => {
    const { spans, report } = ingestSpans([...sampleRun('t1'), ...sampleRun('t2')], {
      contentIncluded: true,
    })
    expect(spans).toHaveLength(14)
    expect(report.ambiguousSpanIds).toContain('tool0')
  })
})





describe('contract edges', () => {
  it('honours a top-level kind and the contract name patterns when classifying spans', () => {
    const { spans } = ingestSpans(
      [
        span({ span_id: 'a', kind: 'TOOL', attributes: {} }),
        span({ span_id: 'b', name: 'tool:read_file', attributes: {} }),
        span({ span_id: 'c', kind: 'SPAN_KIND_INTERNAL', attributes: { 'tool.name': 'Bash' } }),
        span({ span_id: 'd', name: 'chat.completions', attributes: {} }),
      ],
      { contentIncluded: false },
    )
    expect(spans.map((s) => s.kind)).toEqual(['TOOL', 'TOOL', 'TOOL', 'LLM'])
  })

  it('drops bare content, body, request, response and command attributes when content is withheld', () => {
    const { spans } = ingestSpans(
      [
        span({
          attributes: {
            content: 'prose',
            body: 'b',
            request: 'q',
            response: 'r',
            command: 'c',
            'tool.name': 'Bash',
          },
        }),
      ],
      { contentIncluded: false },
    )
    expect(Object.keys(spans[0]!.attributes)).toEqual(['tool.name'])
  })

  it('keeps calls that differ only in secret material distinct for repeated-call detection', () => {
    const calls = ['A', 'B', 'C'].map((c, i) =>
      span({
        span_id: `k${i}`,
        attributes: { 'tool.name': 'curl', input: `Authorization: Bearer ${c.repeat(24)}xyz123` },
      }),
    )
    const { spans } = ingestSpans(calls, { contentIncluded: false })
    expect(new Set(spans.map((s) => s.inputDigest)).size).toBe(3)
  })

  it('redacts a secret in the owner label', async () => {
    const result = await diagnoseSpans(
      sampleRun(),
      { subject: 'customer', label: `case ${OPENAI}` },
      { mode: 'deterministic' },
    )
    expect(result.document.subject.label).not.toContain(OPENAI)
    expect(result.document.coverage.redaction?.redactionCount).toBeGreaterThan(0)
    expect(kitSchemaErrors(result.document)).toEqual([])
  })
})
