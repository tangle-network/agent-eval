/**
 * Tests for `OtlpFileTraceStore`.
 *
 * Each test names the regression it would catch — no `.toBeDefined()`
 * filler. Real fixtures, real file IO, no mocks.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { compileSearchRegex } from './store'
import { OtlpFileTraceStore, TraceFileMissingError, TraceNotFoundError } from './store-otlp'

const TINY_FIXTURE = new URL('../../tests/fixtures/trace-analyst/tiny-trace.jsonl', import.meta.url)
  .pathname

describe('OtlpFileTraceStore', () => {
  it('throws TraceFileMissingError synchronously for a missing path so callers fail fast', async () => {
    const store = new OtlpFileTraceStore({ path: '/nonexistent/path/does-not-exist.jsonl' })
    await expect(store.ensureIndexed()).rejects.toBeInstanceOf(TraceFileMissingError)
  })

  it('builds an index that splits the fixture into two distinct trace ids', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const overview = await store.getOverview()
    expect(overview.total_traces).toBe(2)
    expect(overview.sample_trace_ids).toEqual(['t000000000001', 't000000000002'])
    // Service rolled up from resource.attributes — bug class: forgetting
    // to merge resource.attributes with span.attributes lost service.name.
    expect(overview.services).toEqual(['redteam-audit'])
  })

  it('detects errors and lifts agent + model + tool names — bug class: missing indexed filter on these fields', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const overview = await store.getOverview()
    expect(overview.errors.trace_count).toBe(1)
    expect(overview.errors.span_count).toBe(1)
    expect(overview.agents).toEqual(['AuditCoord'])
    expect(overview.models.sort()).toEqual(['claude-sonnet-4-5-noext', 'deepseek-v4-pro'])
    expect(overview.tool_names.sort()).toEqual(['publish_finding', 'spawn_subagent'])
  })

  it('queryTraces honours has_errors filter — bug class: filter applied AFTER pagination drops valid hits', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const errored = await store.queryTraces({ filters: { has_errors: true }, limit: 50 })
    expect(errored.total).toBe(1)
    expect(errored.traces.map((t) => t.trace_id)).toEqual(['t000000000001'])
    const clean = await store.queryTraces({ filters: { has_errors: false }, limit: 50 })
    expect(clean.total).toBe(1)
    expect(clean.traces.map((t) => t.trace_id)).toEqual(['t000000000002'])
  })

  it('queryTraces.has_more flips correctly at page boundary — bug class: off-by-one on offset+slice.length', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const page1 = await store.queryTraces({ limit: 1, offset: 0 })
    expect(page1.has_more).toBe(true)
    expect(page1.traces.length).toBe(1)
    const page2 = await store.queryTraces({ limit: 1, offset: 1 })
    expect(page2.has_more).toBe(false)
    expect(page2.traces.length).toBe(1)
  })

  it('queryTraces rejects out-of-range limit and offset', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    await expect(store.queryTraces({ limit: 0 })).rejects.toBeInstanceOf(RangeError)
    await expect(store.queryTraces({ limit: 201 })).rejects.toBeInstanceOf(RangeError)
    await expect(store.queryTraces({ limit: 10, offset: -1 })).rejects.toBeInstanceOf(RangeError)
  })

  it('viewTrace returns spans sorted by start_time and projects span fields correctly', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const result = await store.viewTrace({ trace_id: 't000000000001' })
    expect(result.oversized).toBeUndefined()
    expect(result.spans).toBeDefined()
    const spans = result.spans!
    expect(spans.length).toBe(4)
    expect(spans.map((s) => s.span_id)).toEqual(['s001', 's002', 's003', 's004'])
    // Bug class: forgetting to project openinference.span.kind into kind.
    expect(spans[0].kind).toBe('AGENT')
    expect(spans[1].kind).toBe('LLM')
    expect(spans[2].kind).toBe('TOOL')
    expect(spans[3].status).toBe('ERROR')
    expect(spans[3].status_message).toBe('MaxTurnsExceeded')
    expect(spans[1].model_name).toBe('claude-sonnet-4-5-noext')
  })

  it('viewTrace switches to oversized summary when payload exceeds the per-call ceiling', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE, perCallByteCeiling: 100 })
    const result = await store.viewTrace({ trace_id: 't000000000001' })
    expect(result.spans).toBeUndefined()
    expect(result.oversized).toBeDefined()
    expect(result.oversized!.span_count).toBe(4)
    expect(result.oversized!.error_span_count).toBe(1)
    expect(result.oversized!.top_span_names.length).toBeGreaterThan(0)
    // top_span_names sorted desc by count
    const counts = result.oversized!.top_span_names.map(([, n]) => n)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('viewTrace truncates large attribute payloads with a parseable marker', async () => {
    const huge = 'X'.repeat(20_000)
    const tmp = await mkdtemp(join(tmpdir(), 'trace-analyst-'))
    const path = join(tmp, 'trace.jsonl')
    try {
      await writeFile(
        path,
        `${JSON.stringify({
          trace_id: 'big',
          span_id: 'a',
          parent_span_id: '',
          name: 'big.span',
          start_time: '2026-04-24T18:00:00.000000000Z',
          end_time: '2026-04-24T18:00:01.000000000Z',
          status: { code: 'STATUS_CODE_OK' },
          resource: { attributes: { 'service.name': 'svc' } },
          attributes: {
            'openinference.span.kind': 'TOOL',
            'tool.name': 'noisy',
            'input.value': huge,
          },
        })}\n`,
        'utf8',
      )
      const store = new OtlpFileTraceStore({ path, perAttributeViewBudget: 100 })
      const result = await store.viewTrace({ trace_id: 'big' })
      const inputValue = result.spans?.[0].attributes['input.value']
      expect(typeof inputValue).toBe('string')
      expect(inputValue as string).toMatch(/\[trace-analyst truncated: original 20000 bytes\]/)
      // Pre-cap value should not bleed through entirely.
      expect((inputValue as string).length).toBeLessThan(huge.length)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('viewSpans returns only requested spans and reports missing ids — bug class: silent drop of unknown ids', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const result = await store.viewSpans({
      trace_id: 't000000000001',
      span_ids: ['s002', 'sNOPE', 's004'],
    })
    expect(result.spans.map((s) => s.span_id)).toEqual(['s002', 's004'])
    expect(result.missing_span_ids).toEqual(['sNOPE'])
  })

  it('viewSpans rejects oversized span_ids batch', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const ids = Array.from({ length: 101 }, (_, i) => `s${i}`)
    await expect(
      store.viewSpans({ trace_id: 't000000000001', span_ids: ids }),
    ).rejects.toBeInstanceOf(RangeError)
  })

  it('searchTrace finds STATUS_CODE_ERROR — bug class: regex applied per-line but matches counted across slice', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const result = await store.searchTrace({
      trace_id: 't000000000001',
      regex_pattern: 'STATUS_CODE_ERROR',
    })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].span_id).toBe('s004')
    expect(result.hits[0].matched_text).toBe('STATUS_CODE_ERROR')
    expect(result.total_matches).toBe(1)
    expect(result.has_more).toBe(false)
  })

  it('searchTrace caps results at max_matches and reports has_more', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    // 'span_id' appears in every span line — high-frequency match.
    const result = await store.searchTrace({
      trace_id: 't000000000001',
      regex_pattern: 'span_id',
      max_matches: 2,
    })
    expect(result.hits.length).toBe(2)
    expect(result.total_matches).toBeGreaterThan(result.hits.length)
    expect(result.has_more).toBe(true)
  })

  it('supports (?i) case-insensitive regex prefix', () => {
    const re = compileSearchRegex('(?i)status_code_error')
    expect(re.test('STATUS_CODE_ERROR')).toBe(true)
  })

  it('bounds zero-width search output at max_matches', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const result = await store.searchTrace({
      trace_id: 't000000000001',
      regex_pattern: '',
      max_matches: 3,
    })
    expect(result.hits).toHaveLength(3)
    expect(result.has_more).toBe(true)
    expect(result.total_matches).toBeGreaterThan(3)
  })

  it('searchSpan returns hits scoped to one span only', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const result = await store.searchSpan({
      trace_id: 't000000000001',
      span_id: 's004',
      regex_pattern: 'MaxTurnsExceeded',
    })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].matched_text).toBe('MaxTurnsExceeded')
  })

  it('throws TraceNotFoundError for unknown trace_ids — bug class: returning empty payload masks "you fabricated this"', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    await expect(store.viewTrace({ trace_id: 'tFAKE' })).rejects.toBeInstanceOf(TraceNotFoundError)
    await expect(store.viewSpans({ trace_id: 'tFAKE', span_ids: ['x'] })).rejects.toBeInstanceOf(
      TraceNotFoundError,
    )
    await expect(
      store.searchTrace({ trace_id: 'tFAKE', regex_pattern: 'x' }),
    ).rejects.toBeInstanceOf(TraceNotFoundError)
  })

  it('skips malformed JSONL lines silently — bug class: one bad line nukes the whole dataset', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'trace-analyst-'))
    const path = join(tmp, 'trace.jsonl')
    try {
      const goodLine = JSON.stringify({
        trace_id: 'ok',
        span_id: 'a',
        parent_span_id: '',
        name: 'ok.span',
        start_time: '2026-04-24T18:00:00.000000000Z',
        end_time: '2026-04-24T18:00:01.000000000Z',
        status: { code: 'STATUS_CODE_OK' },
        resource: { attributes: { 'service.name': 'svc' } },
        attributes: { 'openinference.span.kind': 'TOOL' },
      })
      await writeFile(path, `${goodLine}\nthis is not json\n${goodLine}\n`, 'utf8')
      const store = new OtlpFileTraceStore({ path })
      const overview = await store.getOverview()
      expect(overview.total_traces).toBe(1)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('regex_pattern in filters narrows traces — bug class: opt-in scan applied to whole dataset, not narrowed set', async () => {
    const store = new OtlpFileTraceStore({ path: TINY_FIXTURE })
    const r = await store.queryTraces({
      filters: { regex_pattern: 'lavarage-audit' },
      limit: 50,
    })
    expect(r.total).toBe(1)
    expect(r.traces[0].trace_id).toBe('t000000000001')
  })
})
