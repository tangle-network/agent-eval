/**
 * HTTP transport for the wire protocol.
 *
 * Hono + @hono/node-server. Every endpoint:
 *   1. Validates the request against its Zod schema.
 *   2. Calls the matching handler in `handlers.ts`.
 *   3. Renders 4xx for `WireError` with structured body, 500 for unexpected.
 *
 * The server has no internal state besides the handler imports — restart
 * costs nothing. Run via `agent-eval serve --port 5005`.
 */
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import {
  handleJudge,
  handleListRubrics,
  handleVersion,
  WireError,
} from './handlers'
import { buildOpenApi } from './openapi'
import { JudgeRequestSchema } from './schemas'

const STARTED_AT = Date.now()

export function createApp() {
  const app = new Hono()

  app.use('*', cors())

  app.onError((err, c) => {
    if (err instanceof WireError) {
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.status as 400 | 404 | 422 | 500,
      )
    }
    // Unexpected — log and return generic 500 without leaking internals.
    console.error('[agent-eval] unhandled error:', err)
    return c.json(
      { error: { code: 'internal_error', message: 'Internal server error.' } },
      500,
    )
  })

  // ── Health ──
  app.get('/healthz', (c) =>
    c.json({ status: 'ok' as const, uptimeSec: (Date.now() - STARTED_AT) / 1000 }),
  )

  // ── Version ──
  app.get('/v1/version', (c) => c.json(handleVersion()))

  // ── Rubrics ──
  app.get('/v1/rubrics', (c) => c.json(handleListRubrics()))

  // ── Judge ──
  app.post('/v1/judge', async (c) => {
    const raw = await c.req.json().catch(() => null)
    if (raw == null) {
      throw new WireError('validation_error', 'Request body must be JSON.', 400)
    }
    const parsed = JudgeRequestSchema.safeParse(raw)
    if (!parsed.success) {
      throw new WireError(
        'validation_error',
        'Request did not match JudgeRequest schema.',
        400,
        parsed.error.issues,
      )
    }
    const result = await handleJudge(parsed.data)
    return c.json(result)
  })

  // ── OpenAPI spec ──
  app.get('/openapi.json', (c) => c.json(buildOpenApi(handleVersion().version)))

  return app
}

export interface ServeOptions {
  /** Default 5005. */
  port?: number
  /** Default '127.0.0.1'. Set to '0.0.0.0' to listen on all interfaces. */
  host?: string
}

export function startServer(opts: ServeOptions = {}): ServerType {
  const app = createApp()
  const port = opts.port ?? 5005
  const host = opts.host ?? '127.0.0.1'
  return serve({ fetch: app.fetch, port, hostname: host }, ({ address, port: actualPort }) => {
    // eslint-disable-next-line no-console
    console.log(`[agent-eval] serving on http://${address}:${actualPort}`)
  })
}
