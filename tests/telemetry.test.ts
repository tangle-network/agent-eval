import { beforeEach, describe, expect, it } from 'vitest'
import type { TelemetryEnvelope, TelemetrySink, TelemetrySource } from '../src/telemetry/index'
import {
  FanoutTelemetrySink,
  HttpTelemetrySink,
  InMemoryTelemetrySink,
  NullTelemetrySink,
  sanitiseArgv,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryClient,
} from '../src/telemetry/index'

const defaultSource: TelemetrySource = {
  repo: 'agent-eval-tests',
  cwd: '/test',
  cliVersion: 'test',
  invocation: 'unit-test',
}

describe('TelemetryClient', () => {
  let captured: InMemoryTelemetrySink

  beforeEach(() => {
    captured = new InMemoryTelemetrySink()
  })

  it('emits a fully-shaped envelope', () => {
    const client = new TelemetryClient(captured, defaultSource)
    client.emit({
      kind: 'design-audit-page',
      runId: 'r1',
      ok: true,
      durationMs: 123,
      data: { url: 'https://x' },
      metrics: { score: 7.5 },
    })
    expect(captured.envelopes).toHaveLength(1)
    const env = captured.envelopes[0]!
    expect(env.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION)
    expect(env.runId).toBe('r1')
    expect(env.kind).toBe('design-audit-page')
    expect(env.metrics.score).toBe(7.5)
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(env.source.repo).toBe('agent-eval-tests')
  })

  it('honours per-emit source override', () => {
    const client = new TelemetryClient(captured, defaultSource)
    client.emit({
      kind: 'agent-run',
      runId: 'r1',
      ok: true,
      durationMs: 1,
      source: { ...defaultSource, repo: 'overridden', tenantId: 'workspace-xyz' },
    })
    expect(captured.envelopes[0]!.source.repo).toBe('overridden')
    expect(captured.envelopes[0]!.source.tenantId).toBe('workspace-xyz')
  })

  it('never throws when sink throws', () => {
    const blowing: TelemetrySink = {
      emit() {
        throw new Error('disk full')
      },
    }
    const client = new TelemetryClient(blowing, defaultSource)
    expect(() =>
      client.emit({ kind: 'agent-run', runId: 'r', ok: true, durationMs: 0 }),
    ).not.toThrow()
  })
})

describe('FanoutTelemetrySink', () => {
  it('continues fanout when one sink throws', () => {
    const good = new InMemoryTelemetrySink()
    const bad: TelemetrySink = {
      emit() {
        throw new Error('boom')
      },
    }
    const fan = new FanoutTelemetrySink([bad, good])
    const client = new TelemetryClient(fan, defaultSource)
    client.emit({ kind: 'agent-run', runId: 'r', ok: true, durationMs: 0 })
    expect(good.envelopes).toHaveLength(1)
  })

  it('forwards close() to all child sinks', async () => {
    let closed = 0
    const a: TelemetrySink = {
      emit() {},
      close() {
        closed++
      },
    }
    const b: TelemetrySink = {
      emit() {},
      close: async () => {
        closed++
      },
    }
    await new FanoutTelemetrySink([a, b]).close?.()
    expect(closed).toBe(2)
  })
})

describe('NullTelemetrySink', () => {
  it('drops envelopes silently', () => {
    const sink = new NullTelemetrySink()
    const client = new TelemetryClient(sink, defaultSource)
    expect(() =>
      client.emit({ kind: 'agent-run', runId: 'r', ok: true, durationMs: 0 }),
    ).not.toThrow()
  })
})

describe('HttpTelemetrySink', () => {
  it('POSTs JSON with bearer when set', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('ok', { status: 200 })
    }) as typeof fetch
    try {
      const sink = new HttpTelemetrySink('https://collector.test/v1', 'tok')
      const client = new TelemetryClient(sink, defaultSource)
      client.emit({ kind: 'agent-run', runId: 'r', ok: true, durationMs: 1 })
      await sink.close()
    } finally {
      globalThis.fetch = origFetch
    }
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://collector.test/v1')
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer tok')
    const env = JSON.parse(String(calls[0]!.init?.body)) as TelemetryEnvelope
    expect(env.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION)
  })

  it('swallows fetch errors (best-effort)', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('unreachable')
    }) as typeof fetch
    try {
      const sink = new HttpTelemetrySink('https://collector.test/v1')
      const client = new TelemetryClient(sink, defaultSource)
      expect(() =>
        client.emit({ kind: 'agent-run', runId: 'r', ok: true, durationMs: 0 }),
      ).not.toThrow()
      await sink.close()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('sanitiseArgv', () => {
  it('redacts secret-bearing flags', () => {
    expect(sanitiseArgv(['run', '--api-key', 'sk', '--url', 'http://x', '--token=abc'])).toEqual([
      'run',
      '--api-key',
      '<redacted>',
      '--url',
      'http://x',
      '--token=<redacted>',
    ])
  })

  it('passes through clean argv unchanged', () => {
    expect(sanitiseArgv(['run', '--goal', 'hello', '--max-turns', '10'])).toEqual([
      'run',
      '--goal',
      'hello',
      '--max-turns',
      '10',
    ])
  })
})
