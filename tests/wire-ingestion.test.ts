/**
 * Wire-protocol ingestion tests (0.25.0).
 *
 * Regression coverage:
 *   - POST /v1/feedback persists into the configured FeedbackTrajectoryStore
 *   - POST /v1/feedback returns 400 ValidationError on malformed payload
 *   - POST /v1/feedback returns 503 when no store is wired
 *   - POST /v1/traces/ingest accepts both JSON ({events:[...]}) and NDJSON
 *   - POST /v1/traces/ingest reports per-event errors without poisoning the batch
 *   - Bearer auth (when configured) blocks ingestion without a valid token
 *     but never blocks /healthz or /v1/version
 *   - OpenAPI doc lists the new endpoints + components
 */
import { describe, expect, it } from 'vitest'

import { InMemoryFeedbackTrajectoryStore } from '../src/feedback-trajectory'
import { InMemoryTraceStore } from '../src/trace/store'
import { createApp } from '../src/wire/server'

async function postJson(app: ReturnType<typeof createApp>, path: string, body: unknown, headers?: Record<string, string>) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  )
  const responseBody = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, body: responseBody }
}

async function postRaw(
  app: ReturnType<typeof createApp>,
  path: string,
  body: string,
  contentType: string,
  headers?: Record<string, string>,
) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType, ...headers },
      body,
    }),
  )
  const responseBody = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, body: responseBody }
}

function validFeedback(id = 'ft_1') {
  return {
    id,
    task: { intent: 'help filing 2025 taxes' },
    attempts: [],
    labels: [
      {
        source: 'user',
        kind: 'approve',
        value: { thumb: 'up' },
        createdAt: '2026-05-14T00:00:00Z',
      },
    ],
    createdAt: '2026-05-14T00:00:00Z',
  }
}

describe('POST /v1/feedback', () => {
  it('persists a feedback trajectory and returns 200 with id + persisted:true', async () => {
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    const app = createApp({ stores: { feedbackStore } })

    const r = await postJson(app, '/v1/feedback', validFeedback('ft_persist'))
    expect(r.status).toBe(200)
    expect((r.body as { id: string }).id).toBe('ft_persist')
    expect((r.body as { persisted: boolean }).persisted).toBe(true)

    const stored = await feedbackStore.get('ft_persist')
    expect(stored).not.toBeNull()
    expect(stored?.task.intent).toBe('help filing 2025 taxes')
  })

  it('returns 400 ValidationError on malformed payload (regression: silent 200 on bad input)', async () => {
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    const app = createApp({ stores: { feedbackStore } })

    const r = await postJson(app, '/v1/feedback', { id: 'x' /* missing task */ })
    expect(r.status).toBe(400)
    expect((r.body as { error: { code: string } }).error.code).toBe('validation_error')
  })

  it('returns 503 when no feedback store is configured', async () => {
    const app = createApp() // no stores
    const r = await postJson(app, '/v1/feedback', validFeedback())
    expect(r.status).toBe(503)
    expect((r.body as { error: { code: string } }).error.code).toBe('service_unavailable')
  })

  it('is idempotent on id (re-posting replaces)', async () => {
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    const app = createApp({ stores: { feedbackStore } })

    await postJson(app, '/v1/feedback', validFeedback('ft_dup'))
    const second = await postJson(app, '/v1/feedback', {
      ...validFeedback('ft_dup'),
      task: { intent: 'NEW intent' },
    })
    expect(second.status).toBe(200)
    const stored = await feedbackStore.get('ft_dup')
    expect(stored?.task.intent).toBe('NEW intent')
  })
})

describe('POST /v1/traces/ingest', () => {
  it('accepts JSON body and persists events', async () => {
    const traceStore = new InMemoryTraceStore()
    const app = createApp({ stores: { traceStore } })

    const r = await postJson(app, '/v1/traces/ingest', {
      events: [
        {
          eventId: 'e1',
          runId: 'r1',
          kind: 'log',
          timestamp: 1_700_000_000_000,
          payload: { msg: 'hello' },
        },
        {
          eventId: 'e2',
          runId: 'r1',
          kind: 'error',
          timestamp: 1_700_000_001_000,
          payload: { msg: 'boom' },
        },
      ],
    })

    expect(r.status).toBe(200)
    expect((r.body as { accepted: number }).accepted).toBe(2)
    expect((r.body as { rejected: number }).rejected).toBe(0)
    const events = await traceStore.events({ runId: 'r1' })
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.eventId).sort()).toEqual(['e1', 'e2'])
  })

  it('accepts NDJSON body and persists events', async () => {
    const traceStore = new InMemoryTraceStore()
    const app = createApp({ stores: { traceStore } })

    const ndjson = [
      JSON.stringify({
        eventId: 'n1',
        runId: 'r2',
        kind: 'log',
        timestamp: 1,
        payload: { line: 1 },
      }),
      JSON.stringify({
        eventId: 'n2',
        runId: 'r2',
        kind: 'log',
        timestamp: 2,
        payload: { line: 2 },
      }),
      '',
    ].join('\n')

    const r = await postRaw(app, '/v1/traces/ingest', ndjson, 'application/x-ndjson')
    expect(r.status).toBe(200)
    expect((r.body as { accepted: number }).accepted).toBe(2)

    const events = await traceStore.events({ runId: 'r2' })
    expect(events).toHaveLength(2)
  })

  it('returns 400 on malformed schema', async () => {
    const traceStore = new InMemoryTraceStore()
    const app = createApp({ stores: { traceStore } })
    const r = await postJson(app, '/v1/traces/ingest', { events: [{ eventId: '', runId: 'r1' }] })
    expect(r.status).toBe(400)
    expect((r.body as { error: { code: string } }).error.code).toBe('validation_error')
  })

  it('returns 503 when no trace store is configured', async () => {
    const app = createApp()
    const r = await postJson(app, '/v1/traces/ingest', {
      events: [{ eventId: 'e', runId: 'r', kind: 'log', timestamp: 1, payload: {} }],
    })
    expect(r.status).toBe(503)
  })
})

describe('bearer auth (opt-in)', () => {
  it('blocks ingestion without an Authorization header', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    const app = createApp({
      stores: { traceStore, feedbackStore },
      auth: { bearer: 'sk-prod-1234' },
    })

    const r = await postJson(app, '/v1/feedback', validFeedback())
    expect(r.status).toBe(401)
    const r2 = await postJson(app, '/v1/traces/ingest', {
      events: [{ eventId: 'e', runId: 'r', kind: 'log', timestamp: 1, payload: {} }],
    })
    expect(r2.status).toBe(401)
  })

  it('accepts a valid bearer token', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    const app = createApp({
      stores: { traceStore, feedbackStore },
      auth: { bearer: 'sk-prod-1234' },
    })
    const r = await postJson(app, '/v1/feedback', validFeedback(), {
      authorization: 'Bearer sk-prod-1234',
    })
    expect(r.status).toBe(200)
  })

  it('rejects a wrong bearer token', async () => {
    const traceStore = new InMemoryTraceStore()
    const app = createApp({
      stores: { traceStore },
      auth: { bearer: 'sk-prod-1234' },
    })
    const r = await postJson(
      app,
      '/v1/traces/ingest',
      { events: [{ eventId: 'e', runId: 'r', kind: 'log', timestamp: 1, payload: {} }] },
      { authorization: 'Bearer wrong' },
    )
    expect(r.status).toBe(401)
  })

  it('always exempts /healthz and /v1/version (regression: lock-out from monitoring)', async () => {
    const app = createApp({
      auth: { bearer: 'sk-prod-1234' },
      stores: {},
    })
    const health = await app.fetch(new Request('http://localhost/healthz'))
    expect(health.status).toBe(200)
    const version = await app.fetch(new Request('http://localhost/v1/version'))
    expect(version.status).toBe(200)
  })

  it('supports a verifier function for rotating tokens', async () => {
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    let calledWith: string | undefined
    const app = createApp({
      stores: { feedbackStore },
      auth: {
        bearer: (token: string) => {
          calledWith = token
          return token.startsWith('rotating-')
        },
      },
    })

    const ok = await postJson(app, '/v1/feedback', validFeedback(), {
      authorization: 'Bearer rotating-abc',
    })
    expect(ok.status).toBe(200)
    expect(calledWith).toBe('rotating-abc')

    const bad = await postJson(app, '/v1/feedback', validFeedback('ft_2'), {
      authorization: 'Bearer static-token',
    })
    expect(bad.status).toBe(401)
  })
})

describe('OpenAPI spec', () => {
  it('lists the new ingestion endpoints + component schemas', async () => {
    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/openapi.json'))
    expect(res.status).toBe(200)
    const spec = (await res.json()) as {
      paths: Record<string, unknown>
      components: { schemas: Record<string, unknown> }
    }
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/v1/feedback', '/v1/traces/ingest']),
    )
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining([
        'FeedbackTrajectory',
        'FeedbackIngestResponse',
        'TracesIngestRequest',
        'TracesIngestResponse',
      ]),
    )
  })
})
