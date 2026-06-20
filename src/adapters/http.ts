/**
 * # `@tangle-network/agent-eval/adapters/http` — distributed Dispatch over HTTP.
 *
 * Decouples coordinator and worker. The coordinator (running
 * `runImprovementLoop` or `runCampaign`) can live anywhere — your VPC, a dev
 * laptop, a cron VM. The workers (running the actual agent) can live anywhere else — different
 * regions, different clouds, different boxes — as long as they speak HTTP.
 *
 * Both sides:
 *
 *   - **`httpDispatch({ url | resolveUrl, ... })`** — client. Returns a
 *     `Dispatch` that POSTs `{ scenario, ctx }` to a worker URL and parses
 *     the artifact back. AbortSignal-aware, retries on idempotent errors,
 *     bounded timeout per call.
 *   - **`runDispatchServer({ dispatch, port, ... })`** — server. Wraps your
 *     local `Dispatch` as an HTTP endpoint. Handles auth, JSON parsing,
 *     error mapping, and cancellation when the client aborts.
 *
 * # Topology examples
 *
 * **Single-worker:** coordinator on box A, worker on box B. Set
 * `httpDispatch({ url: 'https://box-b/dispatch' })`.
 *
 * **Multi-region:** N workers across regions. Use `httpDispatch({ resolveUrl })`
 * with a function that picks the URL per cell from `ctx.placement`. Combined
 * with `cellPlacement` on `RunCampaignOptions`, the substrate fans cells
 * across geographies in parallel.
 *
 * **Coordinator-as-a-service:** coordinator runs as a long-lived process or service
 * (holds optimization state across generations); workers are stateless
 * HTTP services that can scale horizontally per cell.
 */

import type { Dispatch, DispatchContext, Scenario } from '../contract'

// ── Client ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TArtifact is unused
//  in this options interface but kept as a parameter so callers can write
//  `HttpDispatchOptions<MyScenario, MyArtifact>` symmetrically with
//  `Dispatch<MyScenario, MyArtifact>`. Marking it unused at the position
//  where it bites.
export interface HttpDispatchOptions<TScenario extends Scenario, _TArtifact> {
  /** Static endpoint URL. Mutually exclusive with `resolveUrl`. */
  url?: string
  /**
   * Dynamic per-cell URL resolver. Receives the scenario + the substrate
   * placement key (from `RunCampaignOptions.cellPlacement`) and returns the
   * worker URL to invoke. Mutually exclusive with `url`.
   */
  resolveUrl?: (input: { scenario: TScenario; placement?: string; cellId: string }) => string
  /** Bearer token or static auth string set as `Authorization`. */
  auth?: string | (() => string | Promise<string>)
  /** Extra headers merged into every request. */
  headers?: Record<string, string>
  /** Per-call timeout in ms. Default 5 minutes. */
  timeoutMs?: number
  /** How many idempotent retries on 5xx / network errors. Default 2. */
  retries?: number
  /** Optional fetch override (auth wrappers, custom agent, mocks). */
  fetchImpl?: typeof fetch
}

export interface HttpDispatchRequestBody<TScenario extends Scenario> {
  scenario: TScenario
  cellId: string
  rep: number
  generation?: number
  seed: number
  placement?: string
  cycleId?: string
}

export interface HttpDispatchResponseBody<TArtifact> {
  artifact: TArtifact
}

function resolveAuth(auth: HttpDispatchOptions<Scenario, unknown>['auth']): Promise<string | null> {
  if (!auth) return Promise.resolve(null)
  if (typeof auth === 'string') return Promise.resolve(auth)
  return Promise.resolve(auth())
}

/**
 * Wrap a remote HTTP endpoint as a `Dispatch`. The remote side should run
 * `runDispatchServer` (or any service that speaks the same wire shape).
 *
 * Cancellation: the substrate's per-cell `AbortSignal` is forwarded; the
 * server's `runDispatchServer` translates the resulting `AbortError` into
 * a 499 (client-closed) so the client doesn't retry.
 */
export function httpDispatch<TScenario extends Scenario, TArtifact>(
  opts: HttpDispatchOptions<TScenario, TArtifact>,
): Dispatch<TScenario, TArtifact> {
  if (!opts.url && !opts.resolveUrl) {
    throw new Error('httpDispatch: pass exactly one of `url` or `resolveUrl`.')
  }
  if (opts.url && opts.resolveUrl) {
    throw new Error('httpDispatch: pass exactly one of `url` or `resolveUrl`, not both.')
  }
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000
  const maxRetries = opts.retries ?? 2
  const f: typeof fetch = opts.fetchImpl ?? ((...args) => fetch(...args))

  return async (scenario, ctx) => {
    const url =
      opts.url ?? opts.resolveUrl!({ scenario, placement: ctx.placement, cellId: ctx.cellId })
    const authValue = await resolveAuth(opts.auth)
    const body: HttpDispatchRequestBody<TScenario> = {
      scenario,
      cellId: ctx.cellId,
      rep: ctx.rep,
      generation: ctx.generation,
      seed: ctx.seed,
      placement: ctx.placement,
      cycleId: ctx.cycleId,
    }

    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Compose the request signal: caller's signal OR our timeout.
      const ourTimeout = AbortSignal.timeout(timeoutMs)
      const combinedSignal = AbortSignal.any([ctx.signal, ourTimeout])
      try {
        const res = await f(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authValue
              ? {
                  Authorization: authValue.startsWith('Bearer ')
                    ? authValue
                    : `Bearer ${authValue}`,
                }
              : {}),
            ...opts.headers,
          },
          body: JSON.stringify(body),
          signal: combinedSignal,
        })
        if (!res.ok) {
          // 4xx is non-retryable (caller error, auth, bad scenario shape).
          // 5xx / 408 / 429 / 502 / 503 / 504 are retryable.
          const retryable = res.status >= 500 || res.status === 408 || res.status === 429
          if (!retryable || attempt === maxRetries) {
            const text = await res.text().catch(() => '')
            throw new Error(`httpDispatch ${url} failed (${res.status}): ${text.slice(0, 500)}`)
          }
          // exponential backoff with jitter
          await sleep(2 ** attempt * 200 + Math.random() * 200)
          continue
        }
        const parsed = (await res.json()) as HttpDispatchResponseBody<TArtifact>
        return parsed.artifact
      } catch (err) {
        // Caller-driven abort is terminal — never retry.
        if (ctx.signal.aborted) throw err
        lastError = err
        if (attempt === maxRetries) throw err
        await sleep(2 ** attempt * 200 + Math.random() * 200)
      }
    }
    throw lastError ?? new Error('httpDispatch exhausted retries')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    // Don't keep node process alive purely for backoff sleeps.
    if (typeof (t as { unref?: () => void }).unref === 'function')
      (t as { unref: () => void }).unref()
  })
}

// ── Server ───────────────────────────────────────────────────────────

export interface RunDispatchServerOptions<TScenario extends Scenario, TArtifact> {
  /** The Dispatch this server exposes — what runs when a request lands. */
  dispatch: Dispatch<TScenario, TArtifact>
  /** TCP port to bind. */
  port: number
  /** Optional bind host; defaults to 0.0.0.0. */
  host?: string
  /** Required for any non-test deployment: the bearer token clients must
   *  send. The substrate refuses to start without auth unless `auth: false`
   *  is set explicitly (intended ONLY for closed-network/internal testing). */
  auth: string | false
  /** Path the server listens on. Default `/dispatch`. */
  path?: string
  /**
   * Per-request handler that wraps `dispatch` with whatever context the
   * worker side needs to construct a `DispatchContext` — typically the
   * trace writer, artifact writer, and cost meter. The substrate provides
   * synthetic-but-typed defaults if not supplied; production deployments
   * should wire real ones (e.g. ship traces to your OTel collector).
   */
  contextFactory?: (
    req: HttpDispatchRequestBody<TScenario>,
    signal: AbortSignal,
  ) => Promise<DispatchContext>
  /** Optional max payload size for the request body (bytes). Default 10 MB. */
  maxBodyBytes?: number
  /** Hook for observability — called on every successful or failed turn. */
  onRequest?: (event: {
    cellId: string
    durationMs: number
    success: boolean
    error?: unknown
  }) => void
}

export interface DispatchServerHandle {
  /** The actual bound port (useful when `port: 0` requests an ephemeral port). */
  port: number
  /** Stop accepting new connections and drain existing ones. */
  close: () => Promise<void>
}

/**
 * Start an HTTP server exposing a local `Dispatch` over the wire. Pair with
 * `httpDispatch` on the driver side.
 *
 * Wire shape:
 *
 *   POST /dispatch
 *   Authorization: Bearer <token>
 *   Body: HttpDispatchRequestBody
 *   200 OK: HttpDispatchResponseBody
 *   401: missing/invalid auth
 *   408: per-request timeout exceeded
 *   499: client aborted before completion
 *   500: dispatch threw
 *
 * The server is `node:http`-based to keep the runtime dependency surface
 * minimal — works in plain Node, sandbox, or any container.
 */
export async function runDispatchServer<TScenario extends Scenario, TArtifact>(
  opts: RunDispatchServerOptions<TScenario, TArtifact>,
): Promise<DispatchServerHandle> {
  if (opts.auth === undefined) {
    throw new Error(
      "runDispatchServer: 'auth' is required (pass a bearer-token string, or `auth: false` explicitly for a closed-network test deployment).",
    )
  }
  const path = opts.path ?? '/dispatch'
  const maxBytes = opts.maxBodyBytes ?? 10 * 1024 * 1024
  const expectedAuth =
    typeof opts.auth === 'string' ? `Bearer ${opts.auth.replace(/^Bearer\s+/, '')}` : null

  // Lazy-import node:http so the file is usable from non-Node bundlers
  // that import the client side only (e.g. an edge driver shipping
  // httpDispatch alone). Server side is opt-in by calling this function.
  const { createServer } = await import('node:http')

  const server = createServer(async (req, res) => {
    const start = Date.now()
    let cellId = 'unknown'
    let success = false
    let errCaught: unknown

    try {
      if (req.method !== 'POST' || req.url?.split('?')[0] !== path) {
        res.statusCode = 404
        res.end('not found')
        return
      }
      if (expectedAuth) {
        const got = req.headers.authorization
        if (got !== expectedAuth) {
          res.statusCode = 401
          res.end('unauthorized')
          return
        }
      }

      // Read body up to maxBytes
      const chunks: Buffer[] = []
      let totalBytes = 0
      const aborter = new AbortController()
      req.on('close', () => {
        if (!res.writableEnded) aborter.abort()
      })

      for await (const chunk of req) {
        const buf = chunk as Buffer
        totalBytes += buf.length
        if (totalBytes > maxBytes) {
          res.statusCode = 413
          res.end('payload too large')
          return
        }
        chunks.push(buf)
      }

      const body = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as HttpDispatchRequestBody<TScenario>
      cellId = body.cellId

      const ctx: DispatchContext = opts.contextFactory
        ? await opts.contextFactory(body, aborter.signal)
        : {
            cellId: body.cellId,
            rep: body.rep,
            generation: body.generation,
            seed: body.seed,
            signal: aborter.signal,
            placement: body.placement,
            cycleId: body.cycleId,
            trace: NOOP_TRACE,
            artifacts: NOOP_ARTIFACTS,
            cost: NOOP_COST,
          }

      const artifact = await opts.dispatch(body.scenario, ctx)
      const responseBody: HttpDispatchResponseBody<TArtifact> = { artifact }

      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(responseBody))
      success = true
    } catch (err) {
      errCaught = err
      // Client-cancelled — they don't care about the result.
      if ((err as Error)?.name === 'AbortError') {
        res.statusCode = 499
        res.end('client aborted')
        return
      }
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    } finally {
      opts.onRequest?.({
        cellId,
        durationMs: Date.now() - start,
        success,
        error: errCaught,
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve())
  })

  const addr = server.address()
  const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

// ── No-op default ctx machinery (worker can replace via contextFactory) ──

const NOOP_TRACE = {
  span: () => ({
    end: () => {},
    setAttribute: () => {},
    setStatus: () => {},
    recordException: () => {},
    addEvent: () => {},
  }),
} as unknown as DispatchContext['trace']

const NOOP_ARTIFACTS = {
  write: async () => undefined,
  read: async () => undefined,
  list: async () => [],
} as unknown as DispatchContext['artifacts']

const NOOP_COST = {
  record: () => {},
  total: () => 0,
} as unknown as DispatchContext['cost']
