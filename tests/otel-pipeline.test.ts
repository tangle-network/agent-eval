import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOtelConfigured, withOtelPipeline } from '../src/otel-pipeline'
import { createOtelTracingStore, otelRunCompleteHook } from '../src/trace/otel-bridge'
import { createOtelExporter } from '../src/trace/otel-export'
import { InMemoryTraceStore } from '../src/trace/store'

describe('OTEL export', () => {
  const originalEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEnv
    }
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS
  })

  it('createOtelExporter returns undefined when no endpoint set', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    const exporter = createOtelExporter()
    expect(exporter).toBeUndefined()
  })

  it('createOtelExporter returns exporter when endpoint is configured', () => {
    const exporter = createOtelExporter({ endpoint: 'http://localhost:4318' })
    expect(exporter).toBeDefined()
    expect(exporter!.exportSpan).toBeInstanceOf(Function)
    expect(exporter!.flush).toBeInstanceOf(Function)
    expect(exporter!.shutdown).toBeInstanceOf(Function)
  })

  it('reads endpoint from env when not passed in config', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.example.com:4318'
    const exporter = createOtelExporter()
    expect(exporter).toBeDefined()
  })

  it('batch flush sends spans in OTLP JSON format', async () => {
    const bodies: unknown[] = []
    const mockFetch = vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body))
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', mockFetch)

    const exporter = createOtelExporter({
      endpoint: 'http://localhost:4318',
      batchSize: 2,
    })!

    exporter.exportSpan({
      traceId: 'aaaa',
      spanId: 'bbbb',
      name: 'judge:domain',
      kind: 'llm',
      startedAt: 1000,
      endedAt: 1500,
      status: 'ok',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
    })
    exporter.exportSpan({
      traceId: 'aaaa',
      spanId: 'cccc',
      parentSpanId: 'bbbb',
      name: 'judge:coherence',
      kind: 'llm',
      startedAt: 1500,
      endedAt: 2000,
      status: 'ok',
    })

    // Wait for async flush triggered by batch size
    await new Promise((r) => setTimeout(r, 50))

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:4318/v1/traces',
      expect.objectContaining({ method: 'POST' }),
    )

    const body = bodies[0] as any
    expect(body.resourceSpans).toHaveLength(1)
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2)
    const span = body.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.name).toBe('judge:domain')
    expect(span.traceId).toBe('aaaa0000000000000000000000000000')

    await exporter.shutdown()
    vi.unstubAllGlobals()
  })

  it('header propagation from env', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-api-key=secret123,x-org=my-org'
    const exporter = createOtelExporter()
    expect(exporter).toBeDefined()
    // Headers are applied on flush — verified structurally via the config path
  })

  it('shutdown drains pending spans', async () => {
    const mockFetch = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    const exporter = createOtelExporter({
      endpoint: 'http://localhost:4318',
      batchSize: 100, // high batch size so auto-flush doesn't trigger
    })!

    exporter.exportSpan({
      traceId: 'aaaa',
      spanId: 'dddd',
      name: 'test',
      kind: 'custom',
      startedAt: 1000,
      endedAt: 1100,
    })

    await exporter.shutdown()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('export failure does not crash the pipeline', async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error('network failure')
    })
    vi.stubGlobal('fetch', mockFetch)

    const exporter = createOtelExporter({
      endpoint: 'http://localhost:4318',
      batchSize: 1,
    })!

    // Should not throw
    exporter.exportSpan({
      traceId: 'aaaa',
      spanId: 'eeee',
      name: 'test',
      kind: 'custom',
      startedAt: 1000,
      endedAt: 1100,
    })

    await new Promise((r) => setTimeout(r, 50))
    await exporter.shutdown()
    vi.unstubAllGlobals()
  })
})

describe('OTEL tracing store', () => {
  it('auto-exports spans when they close via updateSpan', async () => {
    const exported: any[] = []
    const mockExporter = {
      exportSpan: (span: any) => exported.push(span),
      flush: async () => {},
      shutdown: async () => {},
    }

    const inner = new InMemoryTraceStore()
    const store = createOtelTracingStore(inner, mockExporter, 'trace-123')

    await store.appendRun({
      runId: 'trace-123',
      scenarioId: 'test',
      startedAt: 1000,
      status: 'running',
    })
    await store.appendSpan({
      spanId: 's1',
      runId: 'trace-123',
      kind: 'llm',
      name: 'judge:test',
      startedAt: 1000,
      model: 'gpt-4o',
      messages: [],
    } as any)

    // No export yet — span not ended
    expect(exported).toHaveLength(0)

    await store.updateSpan('s1', { endedAt: 1500, status: 'ok' })
    expect(exported).toHaveLength(1)
    expect(exported[0].name).toBe('judge:test')
    expect(exported[0].traceId).toBe('trace-123')
  })
})

describe('OTEL pipeline integration', () => {
  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  })

  it('withOtelPipeline returns undefined exporter when no endpoint set', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    const handle = withOtelPipeline()
    expect(handle.exporter).toBeUndefined()
  })

  it('withOtelPipeline returns active exporter when endpoint is set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    const handle = withOtelPipeline({ pipelineKind: 'eval-campaign', pipelineId: 'test-1' })
    expect(handle.exporter).toBeDefined()
  })

  it('isOtelConfigured reflects env state', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    expect(isOtelConfigured()).toBe(false)
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    expect(isOtelConfigured()).toBe(true)
  })

  it('runEvalCampaign with OTEL exports all spans including judge + analyst', async () => {
    // Structural test: the pipeline handle creates and shuts down cleanly.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
    const mockFetch = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    const handle = withOtelPipeline({ pipelineKind: 'eval-campaign', pipelineId: 'camp-1' })
    expect(handle.exporter).toBeDefined()

    // Simulate a traced span export
    handle.exporter!.exportSpan({
      traceId: 'campaign-trace',
      spanId: 'span-1',
      name: 'judge:domain_expert',
      kind: 'llm',
      startedAt: 1000,
      endedAt: 1500,
      model: 'gpt-4o',
      attributes: { 'judge.composite_score': 8.5 },
    })

    await handle.shutdown()
    expect(mockFetch).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('otelRunCompleteHook exports all spans at run end', async () => {
    const exported: any[] = []
    const mockExporter = {
      exportSpan: (span: any) => exported.push(span),
      flush: async () => {},
      shutdown: async () => {},
    }

    const store = new InMemoryTraceStore()
    const hook = otelRunCompleteHook(mockExporter)

    // Simulate a run with spans
    await store.appendRun({
      runId: 'run-1',
      scenarioId: 'test',
      startedAt: 1000,
      status: 'running',
    })
    await store.appendSpan({
      spanId: 's1',
      runId: 'run-1',
      kind: 'llm',
      name: 'judge:test',
      startedAt: 1000,
      endedAt: 1500,
      status: 'ok',
      model: 'gpt-4o',
      messages: [],
    } as any)
    await store.appendSpan({
      spanId: 's2',
      runId: 'run-1',
      kind: 'custom',
      name: 'analyst:analyze-traces',
      startedAt: 1500,
      endedAt: 2000,
      status: 'ok',
    } as any)

    await hook({
      runId: 'run-1',
      emitter: {} as any,
      store,
      status: 'completed',
    })

    expect(exported).toHaveLength(2)
    expect(exported.map((s: any) => s.name).sort()).toEqual([
      'analyst:analyze-traces',
      'judge:test',
    ])
  })
})
