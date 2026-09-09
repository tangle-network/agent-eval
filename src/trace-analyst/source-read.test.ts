import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { buildTraceToolsForGroup } from '../analyst/tool-groups'
import {
  createBoundedTraceAnalysisStore,
  OtlpFileTraceStore,
  otlpTextToTraceAnalysisStore,
  type ReadSpanSourceInput,
  type ReadSpanSourceResult,
  type SpanSourceReader,
} from '../traces'
import { buildTraceAnalysisToolDescriptors } from './tools'

const path = new URL('../../tests/fixtures/trace-analyst/tiny-trace.jsonl', import.meta.url)
  .pathname
const input: ReadSpanSourceInput = {
  trace_id: 't000000000001',
  span_id: 's003',
  attribute: 'output.value',
  offset: 0,
  limit: 64,
}
const field = `${'x'.repeat(20_000)}original tail evidence`
const record = JSON.stringify({ output: field })
const bytes = Buffer.from(field)
const digest = createHash('sha256').update(record).digest('hex')
const source = {
  source_id: 'immutable-record-1',
  source_sha256: digest,
  record_sha256: digest,
  field_locator: '/output',
  value_encoding: 'utf8-string' as const,
}

function available(request: ReadSpanSourceInput): ReadSpanSourceResult {
  const text = bytes.subarray(request.offset, request.offset + request.limit).toString('utf8')
  const end = request.offset + Buffer.byteLength(text)
  return {
    status: 'available',
    trace_id: request.trace_id,
    span_id: request.span_id,
    attribute: request.attribute,
    source_index: request.source_index ?? 0,
    text,
    offset: request.offset,
    total_bytes: bytes.length,
    next_offset: end < bytes.length ? end : null,
    source,
  }
}

function store(reader: SpanSourceReader = async (request) => available(request)) {
  return new OtlpFileTraceStore({ path, sourceReader: reader })
}

function tool(reader?: SpanSourceReader) {
  return buildTraceAnalysisToolDescriptors({ store: store(reader) }).find(
    (item) => item.name === 'readSpanSource',
  )!
}

describe('bounded original span source field reads', () => {
  it('reads original tails through the canonical handler, with exact hashes and continuation', async () => {
    const reader = vi.fn(async (request: ReadSpanSourceInput) => available(request))
    const handler = tool(reader).handler
    const first = await handler(input)
    expect(first).toMatchObject({ status: 'available', offset: 0, next_offset: 64, source })
    const offset = bytes.length - 24
    expect(await handler({ ...input, offset })).toEqual(available({ ...input, offset }))
    expect(JSON.stringify(await handler({ ...input, offset }))).toContain('original tail evidence')
    expect(reader.mock.calls[0]?.[0].source_index).toBe(0)
    expect(await handler({ ...input, offset: bytes.length })).toMatchObject({
      status: 'available',
      text: '',
      next_offset: null,
    })
  })

  it('makes original evidence accessible when the normalized attribute is truncated', async () => {
    const normalized = JSON.stringify({
      trace_id: input.trace_id,
      span_id: input.span_id,
      name: 'tool',
      start_time: '2026-09-08T00:00:00Z',
      end_time: '2026-09-08T00:00:01Z',
      attributes: { 'output.value': '[truncated]' },
    })
    const buffered = otlpTextToTraceAnalysisStore(normalized, {
      sourceReader: async (request) => available(request),
    })
    const projected = await buffered.viewSpans({
      trace_id: input.trace_id,
      span_ids: [input.span_id],
    })
    expect(JSON.stringify(projected)).not.toContain('original tail evidence')
    const result = await buffered.readSpanSource!({ ...input, offset: bytes.length - 24 })
    expect(result.status === 'available' && result.text).toContain('original tail evidence')
  })

  it('omits the capability and descriptor when no provider exists', () => {
    const unsupported = new OtlpFileTraceStore({ path })
    expect(unsupported.readSpanSource).toBeUndefined()
    expect(createBoundedTraceAnalysisStore(unsupported).readSpanSource).toBeUndefined()
    expect(buildTraceAnalysisToolDescriptors({ store: unsupported })).toHaveLength(7)
  })

  it.each(['all', 'singleTrace', 'targeted', 'discoveryAndRead', 'discoveryAndSearch'] as const)(
    'exposes the same handler in the %s group',
    (group) => {
      expect(buildTraceToolsForGroup(group, store()).map((item) => item.name)).toContain(
        'readSpanSource',
      )
      expect(buildTraceToolsForGroup('discovery', store()).map((item) => item.name)).not.toContain(
        'readSpanSource',
      )
    },
  )

  it('preserves explicit unavailable outcomes and selects an ordered source record', async () => {
    const reader: SpanSourceReader = async (request) => ({
      status: 'unavailable',
      trace_id: request.trace_id,
      span_id: request.span_id,
      attribute: request.attribute,
      source_index: request.source_index ?? 0,
      reason: 'requested source record is not retained',
    })
    expect(await tool(reader).handler({ ...input, source_index: 2 })).toEqual({
      status: 'unavailable',
      trace_id: input.trace_id,
      span_id: input.span_id,
      attribute: input.attribute,
      source_index: 2,
      reason: 'requested source record is not retained',
    })
  })

  it.each([
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER },
    { limit: 0 },
    { limit: -1 },
    { limit: 0.5 },
    { limit: 16_385 },
    { offset: Infinity },
    { source_index: -1 },
    { source_index: 0.5 },
    { attribute: '' },
    { path: '/private/file' },
  ])('rejects invalid windows before the source provider: %j', async (change) => {
    const reader = vi.fn(async (request: ReadSpanSourceInput) => available(request))
    await expect(tool(reader).handler({ ...input, ...change })).rejects.toThrow()
    expect(reader).not.toHaveBeenCalled()
  })

  it.each([{ trace_id: 'missing' }, { trace_id: 't000000000002' }, { span_id: 's101' }])(
    'checks trace/span scope before resolving source identities: %j',
    async (change) => {
      const reader = vi.fn(async (request: ReadSpanSourceInput) => available(request))
      await expect(tool(reader).handler({ ...input, ...change })).rejects.toThrow()
      expect(reader).not.toHaveBeenCalled()
    },
  )

  it.each([
    { trace_id: 'other' },
    { span_id: 'other' },
    { attribute: 'input.value' },
    { source_index: 1 },
    { offset: 1 },
    { next_offset: 0 },
    { next_offset: null },
    { text: '' },
    { text: 'x'.repeat(65) },
    { text: '\ud800' },
    { total_bytes: 1 },
    { total_bytes: Number.MAX_VALUE },
    { source: { ...source, record_sha256: 'invalid' } },
    { unexpected: true },
  ])('rejects malformed provider results: %j', async (change) => {
    const reader = async (request: ReadSpanSourceInput) => ({ ...available(request), ...change })
    await expect(tool(reader as SpanSourceReader).handler(input)).rejects.toMatchObject({
      code: 'backend_integrity',
    })
  })

  it('rejects successful empty responses that substitute for missing source', async () => {
    const reader: SpanSourceReader = async (request) => ({
      ...available(request),
      status: 'available',
      text: '',
      offset: 0,
      total_bytes: 0,
      next_offset: null,
      source,
    })
    await expect(tool(reader).handler(input)).rejects.toMatchObject({ code: 'backend_integrity' })
  })

  it('keeps request scope immutable when a provider mutates its input', async () => {
    const reader: SpanSourceReader = async (request) => {
      request.trace_id = 'different-trace'
      return available(request)
    }
    await expect(tool(reader).handler(input)).rejects.toMatchObject({ code: 'backend_integrity' })
  })

  it('preserves UTF-8 byte positions rather than counting characters', async () => {
    const reader: SpanSourceReader = async (request) => ({
      status: 'available',
      trace_id: request.trace_id,
      span_id: request.span_id,
      attribute: request.attribute,
      source_index: request.source_index ?? 0,
      text: 'é',
      offset: request.offset,
      total_bytes: 10,
      next_offset: request.offset + 2,
      source,
    })
    expect(await tool(reader).handler({ ...input, offset: 4, limit: 2 })).toMatchObject({
      next_offset: 6,
    })
    await expect(tool(reader).handler({ ...input, limit: 1 })).rejects.toMatchObject({
      code: 'backend_integrity',
    })
  })

  it('applies the configured call ceiling to source metadata as well as text', async () => {
    const bounded = createBoundedTraceAnalysisStore(store(), {
      budgets: { perCallByteCeiling: 100 },
    })
    await expect(bounded.readSpanSource!(input)).rejects.toMatchObject({ code: 'limit_exceeded' })
  })

  it('stops after a cancelled existence check without invoking the provider', async () => {
    const controller = new AbortController()
    const reader = vi.fn<SpanSourceReader>(async (request) => available(request))
    const underlying = store(reader)
    underlying.hasTrace = async () => {
      controller.abort(new Error('existence check cancelled'))
      return true
    }
    const bounded = createBoundedTraceAnalysisStore(underlying)
    await expect(bounded.readSpanSource!(input, { signal: controller.signal })).rejects.toThrow(
      'existence check cancelled',
    )
    expect(reader).not.toHaveBeenCalled()
  })

  it('forwards cancellation and rejects a source response received after cancellation', async () => {
    const controller = new AbortController()
    const reader = vi.fn<SpanSourceReader>(async (request, context) => {
      expect(context?.signal).toBe(controller.signal)
      controller.abort(new Error('source cancelled'))
      return available(request)
    })
    await expect(tool(reader).handler(input, { signal: controller.signal })).rejects.toThrow(
      'source cancelled',
    )
    expect(reader).toHaveBeenCalledOnce()
    await expect(tool(reader).handler(input, { signal: controller.signal })).rejects.toThrow(
      'source cancelled',
    )
    expect(reader).toHaveBeenCalledOnce()
  })
})
