/**
 * HTTP transport for the wire protocol.
 *
 * Hono + @hono/node-server. Every endpoint:
 *   1. Validates the request against its Zod schema.
 *   2. Calls the matching handler in `handlers.ts`.
 *   3. Renders 4xx for `WireError` with structured body, 500 for unexpected.
 *
 * The server holds optional `IngestionStores` (passed to `createApp`)
 * to receive production traces and user feedback. With no stores wired,
 * the ingestion endpoints return 503 — read endpoints (`/v1/judge`,
 * `/v1/rubrics`, `/v1/version`) remain fully functional.
 *
 * Run via `agent-eval serve --port 5005`.
 */
import { type ServerType, serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import {
  handleFeedbackIngest,
  handleJudge,
  handleListRubrics,
  handleTracesIngest,
  handleVersion,
  type IngestionStores,
  WireError,
} from './handlers'
import { buildOpenApi } from './openapi'
import { FeedbackTrajectorySchema, JudgeRequestSchema, TracesIngestRequestSchema } from './schemas'

const STARTED_AT = Date.now()

export interface CreateAppOptions {
  /** Stores wired to the ingestion endpoints. */
  stores?: IngestionStores
  /**
   * Bearer-token auth. When provided, every endpoint EXCEPT `/healthz`
   * and `/v1/version` requires `Authorization: Bearer <token>`. The
   * token may be a static string OR a function for time-bounded /
   * rotating tokens.
   *
   * Recommended for any server that accepts ingestion writes from the
   * public internet. Read-only deployments may omit it.
   */
  auth?: {
    bearer: string | ((token: string) => boolean | Promise<boolean>)
  }
}

const AUTH_EXEMPT_PATHS = new Set(['/healthz', '/v1/version', '/openapi.json'])

export function createApp(opts: CreateAppOptions = {}) {
  const app = new Hono()

  app.use('*', cors())

  // Bearer-token middleware (only attached when configured).
  if (opts.auth) {
    const verify = opts.auth.bearer
    app.use('*', async (c, next) => {
      const path = new URL(c.req.url).pathname
      if (AUTH_EXEMPT_PATHS.has(path)) return next()
      const raw = c.req.header('authorization') ?? ''
      const match = raw.match(/^Bearer\s+(.+)$/i)
      if (!match) {
        throw new WireError('unauthorized', 'Missing or malformed Authorization header.', 401)
      }
      const token = match[1] as string
      const ok = typeof verify === 'string' ? token === verify : await verify(token)
      if (!ok) {
        throw new WireError('unauthorized', 'Invalid bearer token.', 401)
      }
      return next()
    })
  }

  app.onError((err, c) => {
    if (err instanceof WireError) {
      const status = err.status as 400 | 401 | 404 | 422 | 500 | 503
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        status,
      )
    }
    // Unexpected — log and return generic 500 without leaking internals.
    console.error('[agent-eval] unhandled error:', err)
    return c.json({ error: { code: 'internal_error', message: 'Internal server error.' } }, 500)
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

  // ── Traces ingest (NDJSON-friendly: accepts either {events:[...]} or NDJSON) ──
  app.post('/v1/traces/ingest', async (c) => {
    const contentType = c.req.header('content-type') ?? ''
    let payload: unknown
    if (contentType.includes('application/x-ndjson')) {
      const text = await c.req.text()
      const events = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            throw new WireError(
              'validation_error',
              'NDJSON line did not parse as JSON.',
              400,
              line.slice(0, 200),
            )
          }
        })
      payload = { events }
    } else {
      payload = await c.req.json().catch(() => null)
    }
    if (payload == null) {
      throw new WireError('validation_error', 'Request body must be JSON or NDJSON.', 400)
    }
    const parsed = TracesIngestRequestSchema.safeParse(payload)
    if (!parsed.success) {
      throw new WireError(
        'validation_error',
        'Request did not match TracesIngestRequest schema.',
        400,
        parsed.error.issues,
      )
    }
    const result = await handleTracesIngest(parsed.data, opts.stores ?? {})
    return c.json(result)
  })

  // ── Feedback ingest ──
  app.post('/v1/feedback', async (c) => {
    const raw = await c.req.json().catch(() => null)
    if (raw == null) {
      throw new WireError('validation_error', 'Request body must be JSON.', 400)
    }
    const parsed = FeedbackTrajectorySchema.safeParse(raw)
    if (!parsed.success) {
      throw new WireError(
        'validation_error',
        'Request did not match FeedbackTrajectory schema.',
        400,
        parsed.error.issues,
      )
    }
    const result = await handleFeedbackIngest(parsed.data, opts.stores ?? {})
    return c.json(result)
  })

  // ── OpenAPI spec ──
  app.get('/openapi.json', (c) => c.json(buildOpenApi(handleVersion().version)))

  return app
}

export interface ServeOptions extends CreateAppOptions {
  /** Default 5005. */
  port?: number
  /** Default '127.0.0.1'. Set to '0.0.0.0' to listen on all interfaces. */
  host?: string
}

export function startServer(opts: ServeOptions = {}): ServerType {
  const app = createApp(opts)
  const port = opts.port ?? 5005
  const host = opts.host ?? '127.0.0.1'
  return serve({ fetch: app.fetch, port, hostname: host }, ({ address, port: actualPort }) => {
    // eslint-disable-next-line no-console
    console.log(`[agent-eval] serving on http://${address}:${actualPort}`)
  })
}

export interface StartedServer {
  server: ServerType
  /** The OS-assigned port. When opts.port was 0, this is the actual port the
   *  kernel bound — callers that need to dial back (smoke tests, sidecars
   *  registering with a parent) read this rather than guessing a free port. */
  port: number
  /** Resolved host the server bound to (defaults to 127.0.0.1). */
  host: string
  /** Close the server. Resolves once active connections have drained. */
  close(): Promise<void>
}

/**
 * Promise-returning variant of `startServer` that resolves once the server is
 * listening and surfaces the resolved bound port. Use this from smoke tests
 * (`startServerAsync({ port: 0 })`) and any caller that needs to dial back.
 */
export function startServerAsync(opts: ServeOptions = {}): Promise<StartedServer> {
  const app = createApp(opts)
  const port = opts.port ?? 5005
  const host = opts.host ?? '127.0.0.1'
  return new Promise((resolve, reject) => {
    let settled = false
    let server: ServerType | undefined
    server = serve({ fetch: app.fetch, port, hostname: host }, ({ address, port: actualPort }) => {
      if (settled) return
      settled = true
      // eslint-disable-next-line no-console
      console.log(`[agent-eval] serving on http://${address}:${actualPort}`)
      resolve({
        server: server!,
        port: actualPort,
        host: address,
        close: () =>
          new Promise<void>((res, rej) => {
            server!.close((err) => (err ? rej(err) : res()))
          }),
      })
    })
    server.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}
