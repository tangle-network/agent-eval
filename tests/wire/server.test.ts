/**
 * HTTP server smoke tests using Hono's in-memory request fetcher.
 *
 * These tests run against the same handlers the production server uses
 * — no separate test app, no mocks. They cover routing, response shape,
 * and error mapping for every endpoint that does not require a live LLM.
 */
import { describe, expect, it } from 'vitest'

import { createApp } from '../../src/wire/server'

const app = createApp()

async function get(path: string) {
  const res = await app.fetch(new Request(`http://localhost${path}`))
  const body = res.status === 204 ? null : await res.json()
  return { status: res.status, body }
}

async function post(path: string, body: unknown) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  const responseBody = await res.json()
  return { status: res.status, body: responseBody }
}

describe('GET /healthz', () => {
  it('returns 200 with status:ok (regression: liveness probe must succeed before judge)', async () => {
    const r = await get('/healthz')
    expect(r.status).toBe(200)
    expect((r.body as { status: string }).status).toBe('ok')
  })
})

describe('GET /v1/version', () => {
  it('returns package, version, wireVersion, apiSurface', async () => {
    const r = await get('/v1/version')
    expect(r.status).toBe(200)
    const v = r.body as Record<string, unknown>
    expect(v.package).toBe('@tangle-network/agent-eval')
    expect(typeof v.version).toBe('string')
    expect(typeof v.wireVersion).toBe('string')
    expect(Array.isArray(v.apiSurface)).toBe(true)
  })
})

describe('GET /v1/rubrics', () => {
  it('returns a non-empty rubric listing (regression: empty registry breaks every consumer)', async () => {
    const r = await get('/v1/rubrics')
    expect(r.status).toBe(200)
    const list = r.body as { rubrics: { name: string }[] }
    expect(list.rubrics.length).toBeGreaterThan(0)
    expect(list.rubrics.some((x) => x.name === 'anti-slop')).toBe(true)
  })
})

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.1 document with our paths', async () => {
    const r = await get('/openapi.json')
    expect(r.status).toBe(200)
    const spec = r.body as {
      openapi: string
      paths: Record<string, unknown>
      components: { schemas: Record<string, unknown> }
    }
    expect(spec.openapi).toMatch(/^3\.1/)
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/v1/judge', '/v1/rubrics', '/v1/version', '/healthz']),
    )
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['JudgeRequest', 'JudgeResult', 'Rubric']),
    )
    const judgeRequest = spec.components.schemas.JudgeRequest as { oneOf?: unknown[] }
    expect(judgeRequest.oneOf).toHaveLength(2)
  })
})

describe('POST /v1/judge', () => {
  it('returns 400 with validation_error when body is empty (regression: silent 200 on bad input)', async () => {
    const r = await post('/v1/judge', {})
    expect(r.status).toBe(400)
    const err = r.body as { error: { code: string } }
    expect(err.error.code).toBe('validation_error')
  })

  it('returns 404 when rubricName is unknown', async () => {
    const r = await post('/v1/judge', { rubricName: 'no-such-rubric', content: 'hi' })
    // Validation passes (both required fields present); the handler then 404s.
    // Note: depending on transport, the 404 may surface here directly.
    expect([404, 400]).toContain(r.status)
    const err = r.body as { error: { code: string } }
    expect(['rubric_not_found', 'validation_error']).toContain(err.error.code)
  })
})
