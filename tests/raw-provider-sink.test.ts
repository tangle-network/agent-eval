import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultProviderRedactor,
  FileSystemRawProviderSink,
  InMemoryRawProviderSink,
  providerFromBaseUrl,
  type RawProviderEvent,
} from '../src/trace/raw-provider-sink'

function event(overrides: Partial<RawProviderEvent> = {}): RawProviderEvent {
  return {
    eventId: overrides.eventId ?? 'evt-1',
    runId: 'run-1',
    spanId: 'span-1',
    provider: 'tangle-router',
    model: 'claude-sonnet-4-6',
    endpoint: '/chat/completions',
    baseUrl: 'https://router.tangle.tools/v1',
    attemptIndex: 0,
    direction: 'request',
    timestamp: 1_000,
    redactedFields: [],
    ...overrides,
  }
}

describe('defaultProviderRedactor', () => {
  it('strips well-known auth headers and credential body fields', () => {
    const result = defaultProviderRedactor(
      event({
        requestHeaders: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-token',
          'X-Api-Key': 'k123',
          Cookie: 'session=abc',
        },
        requestBody: {
          model: 'gpt-4',
          apiKey: 'should-be-stripped',
          nested: { token: 'also-stripped', other: 'kept' },
        },
      }),
    )
    expect(result.requestHeaders).toEqual({ 'Content-Type': 'application/json' })
    expect(result.requestBody).toEqual({
      model: 'gpt-4',
      nested: { other: 'kept' },
    })
    expect(result.redactedFields).toEqual(
      expect.arrayContaining([
        'requestHeaders.Authorization',
        'requestHeaders.X-Api-Key',
        'requestHeaders.Cookie',
        'requestBody.apiKey',
        'requestBody.nested.token',
      ]),
    )
  })

  it('passes plain bodies through unchanged', () => {
    const result = defaultProviderRedactor(
      event({ requestBody: { model: 'x', messages: [{ role: 'user', content: 'hi' }] } }),
    )
    expect(result.requestBody).toEqual({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
    expect(result.redactedFields).toEqual([])
  })
})

describe('InMemoryRawProviderSink', () => {
  it('records and lists events with filters', async () => {
    const sink = new InMemoryRawProviderSink()
    await sink.record(event({ eventId: 'a', direction: 'request' }))
    await sink.record(event({ eventId: 'b', direction: 'response', spanId: 'span-1' }))
    await sink.record(event({ eventId: 'c', direction: 'request', runId: 'run-other' }))
    expect(sink.size()).toBe(3)
    const requests = await sink.list({ direction: 'request' })
    expect(requests.map((e) => e.eventId)).toEqual(['a', 'c'])
    const forRun = await sink.list({ runId: 'run-1' })
    expect(forRun.map((e) => e.eventId)).toEqual(['a', 'b'])
  })

  it('redacts on record', async () => {
    const sink = new InMemoryRawProviderSink()
    await sink.record(event({ requestHeaders: { Authorization: 'Bearer x' } }))
    const [stored] = await sink.list()
    expect(stored?.requestHeaders).toEqual({})
    expect(stored?.redactedFields).toContain('requestHeaders.Authorization')
  })
})

describe('FileSystemRawProviderSink', () => {
  it('writes NDJSON and lists round-trip', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-sink-'))
    try {
      const sink = new FileSystemRawProviderSink({ dir })
      await sink.record(event({ eventId: 'a' }))
      await sink.record(event({ eventId: 'b', direction: 'response' }))
      const file = path.join(dir, 'raw-provider-events.ndjson')
      const body = await fs.readFile(file, 'utf8')
      expect(body.split('\n').filter(Boolean)).toHaveLength(2)
      const listed = await sink.list()
      expect(listed.map((e) => e.eventId)).toEqual(['a', 'b'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('rolls files at the configured byte threshold', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-sink-roll-'))
    try {
      const sink = new FileSystemRawProviderSink({ dir, rollAtBytes: 200 })
      for (let i = 0; i < 5; i++) {
        await sink.record(event({ eventId: `e${i}`, requestBody: { i, fill: 'x'.repeat(50) } }))
      }
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith('raw-provider-events'))
      expect(files.length).toBeGreaterThan(1)
      const all = await sink.list()
      expect(all.map((e) => e.eventId).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('providerFromBaseUrl', () => {
  it('maps known hosts to provider ids', () => {
    expect(providerFromBaseUrl('https://api.openai.com/v1')).toBe('openai')
    expect(providerFromBaseUrl('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(providerFromBaseUrl('https://router.tangle.tools/v1')).toBe('tangle-router')
    expect(providerFromBaseUrl('https://api.deepseek.com/v1')).toBe('deepseek')
  })

  it('falls back to host for unknown providers', () => {
    expect(providerFromBaseUrl('https://my-proxy.internal/v1')).toBe('my-proxy.internal')
  })
})
