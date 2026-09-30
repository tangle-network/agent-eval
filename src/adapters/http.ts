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
 *     the artifact back. AbortSignal-aware, one attempt by default,
 *     bounded timeout per call. Explicit retries require worker-owned replay.
 *   - **`runDispatchServer({ dispatch, port, ... })`** — server. Wraps your
 *     local `Dispatch` as an HTTP endpoint. Handles auth, JSON parsing,
 *     error mapping, and cancellation when the client aborts.
 *
 * # Cost receipts cross the wire too
 *
 * A worker dispatch pays for its own model calls through its own
 * `ctx.cost` (wired by `contextFactory`) — a different `CostLedger` than the
 * coordinator's. `runDispatchServer` records every receipt that dispatch
 * settles and returns them alongside the artifact; `httpDispatch` replays
 * each one into the coordinator's `ctx.cost`, the same paid-call path a
 * local dispatch uses. A remote cell's spend therefore reaches the
 * coordinator's `CostLedger` — its summary, its cost ceiling, its
 * `CampaignCellResult.costUsd` — exactly like an in-process cell's does.
 * The worker must authorize and bound spend before executing; importing its
 * receipts cannot retroactively enforce the coordinator's ceiling.
 * Paid work requires a real `contextFactory` cost meter. An empty receipt
 * list does not establish free execution: the host must require usage evidence
 * and reconcile the worker ledger when a client disconnects before delivery.
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

import type { CampaignCostMeter, Dispatch, DispatchContext, Scenario } from '../contract'
import type { CostReceipt, CostReceiptInput } from '../cost-ledger'

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
  /**
   * Additional transport attempts. Default 0: a lost response does not prove
   * the worker did no work. Set a positive value only when the worker durably
   * deduplicates this runAttemptId/cellId and its external effects.
   * 4xx (except 408/429), decoding and receipt-settlement failures are terminal.
   */
  retries?: number
  /** Optional fetch override (auth wrappers, custom agent, mocks). */
  fetchImpl?: typeof fetch
}

export interface HttpDispatchRequestBody<TScenario extends Scenario> {
  scenario: TScenario
  cellId: string
  runAttemptId: string
  rep: number
  generation?: number
  seed: number
  placement?: string
  cycleId?: string
}

export interface HttpDispatchResponseBody<TArtifact> {
  artifact: TArtifact
  /**
   * Every paid-call receipt the worker's `ctx.cost` settled while producing
   * this artifact, in settlement order. Absent or empty when the worker
   * recorded no paid calls (no `contextFactory`, or a dispatch that pays
   * through some other channel entirely). `httpDispatch` replays each one
   * into the coordinator's own `ctx.cost`.
   */
  receipts?: CostReceipt[]
}

function resolveAuth(
  auth: HttpDispatchOptions<Scenario, unknown>['auth'],
): Promise<string | null> {
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
 * a 499 (client-closed) so the client doesn't retry. The server is a transport,
 * not a durable deduplication owner; its default Dispatch may have side effects.
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
  const maxRetries = opts.retries ?? 0
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
    throw new Error('httpDispatch: retries must be a non-negative safe integer.')
  const f: typeof fetch = opts.fetchImpl ?? ((...args) => fetch(...args))

  return async (scenario, ctx) => {
    ctx.signal.throwIfAborted()
    const url =
      opts.url ?? opts.resolveUrl!({ scenario, placement: ctx.placement, cellId: ctx.cellId })
    const body: HttpDispatchRequestBody<TScenario> = {
      scenario,
      cellId: ctx.cellId,
      runAttemptId: ctx.runAttemptId,
      rep: ctx.rep,
      generation: ctx.generation,
      seed: ctx.seed,
      placement: ctx.placement,
      cycleId: ctx.cycleId,
    }

    const encodedBody = JSON.stringify(body)
    const authValue = await resolveAuth(opts.auth)
    for (let attempt = 0; ; attempt++) {
      ctx.signal.throwIfAborted()
      const combinedSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])
      let res: Response
      // Only a fetch failure can enter this catch. Parsing, receipt settlement
      // and deliberate HTTP refusals must never repeat remote execution.
      try {
        res = await f(url, {
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
          body: encodedBody,
          signal: combinedSignal,
        })
      } catch (err) {
        if (ctx.signal.aborted || attempt >= maxRetries) throw err
        await sleep(2 ** attempt * 200 + Math.random() * 200, ctx.signal)
        continue
      }

      if (res.ok) {
        const parsed = (await res.json()) as HttpDispatchResponseBody<TArtifact>
        for (const receipt of parsed?.receipts ?? []) await replayReceipt(ctx.cost, receipt)
        if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'artifact'))
          throw new Error('httpDispatch: response is missing its artifact.')
        return parsed.artifact
      }

      const text = await res.text()
      // Partial spend is still spend. Account for it before surfacing the
      // failure, outside the transport retry catch.
      const receipts = parseErrorReceipts(text)
      for (const receipt of receipts) await replayReceipt(ctx.cost, receipt)
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429
      if (!retryable || receipts.length > 0 || attempt >= maxRetries)
        throw new Error(`httpDispatch ${url} failed (${res.status}): ${text.slice(0, 500)}`)
      await sleep(2 ** attempt * 200 + Math.random() * 200, ctx.signal)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Best-effort receipts from a non-2xx `runDispatchServer` body. Any shape
 *  that isn't `{ error, receipts? }` JSON (plain-text 401/404/413 bodies,
 *  a non-`runDispatchServer` peer) yields none — never itself a reason to
 *  fail the request. */
function parseErrorReceipts(text: string): CostReceipt[] {
  try {
    const parsed = JSON.parse(text) as { receipts?: CostReceipt[] }
    return Array.isArray(parsed.receipts) ? parsed.receipts : []
  } catch {
    return []
  }
}

/**
 * Re-enter one already-settled remote receipt through `runPaidCall` — the
 * only path `CampaignCostMeter` admits. `execute` does no new work (the
 * spend already happened on the worker); it only replays the worker's
 * outcome so the coordinator's ledger records the same receipt (a settled
 * failure included, so its `error` and cost — a failed call can still burn
 * tokens — are never dropped on the floor). Faithfully replaying a remote
 * failure still returns `succeeded: false` from `runPaidCall`: that's not
 * ours to raise. Only a `receipt`-less failure is — it means `runPaidCall`
 * refused to admit the call at all (a duplicate `callId`, an unknown-cost
 * receipt under a capped coordinator ledger, a breached cost ceiling), so
 * the remote spend could not be accounted for.
 */
async function replayReceipt(cost: CampaignCostMeter, receipt: CostReceipt): Promise<void> {
  const knownCostUsd = receipt.costUnknown ? undefined : receipt.costUsd
  const observed = (): CostReceiptInput => ({
    model: receipt.model,
    inputTokens: receipt.inputTokens,
    outputTokens: receipt.outputTokens,
    ...(receipt.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: receipt.reasoningTokens }),
    ...(receipt.cachedTokens === undefined ? {} : { cachedTokens: receipt.cachedTokens }),
    ...(receipt.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: receipt.cacheWriteTokens }),
    ...(receipt.usageUnknown ? { usageUnknown: true as const } : {}),
    ...(knownCostUsd === undefined
      ? { costUnknown: true as const }
      : { actualCostUsd: knownCostUsd }),
  })
  const result = await cost.runPaidCall({
    callId: receipt.callId,
    channel: receipt.channel,
    actor: receipt.actor,
    model: receipt.model,
    maximumCharge:
      knownCostUsd === undefined ? undefined : { externallyEnforcedMaximumUsd: knownCostUsd },
    // No `signal`: the call already happened remotely. Aborting the replay
    // would not undo the spend, only hide it from the ledger.
    execute: async () => {
      if (receipt.error) throw new Error(receipt.error)
      return null
    },
    receipt: observed,
    receiptFromError: observed,
  })
  if (!result.succeeded && !result.receipt) {
    throw result.error
  }
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
    // Hoisted so a dispatch that throws AFTER paying for some of its work
    // still reports that spend in the error response — a partial spend is
    // still spend, and it must reach the coordinator's ledger exactly like
    // a locally-dispatched cell's failure accounting does.
    const receipts: CostReceipt[] = []

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
      // The request stream's 'close' fires when the BODY completes, so it
      // cannot signal disconnection. The response stream's 'close' fires
      // once per exchange: with `writableEnded` still false it means the
      // client went away before the dispatch answered.
      res.on('close', () => {
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
      if (typeof body.runAttemptId !== 'string' || body.runAttemptId.trim().length === 0) {
        throw new Error('runDispatchServer: request runAttemptId is required')
      }
      cellId = body.cellId

      const ctx: DispatchContext = opts.contextFactory
        ? await opts.contextFactory(body, aborter.signal)
        : {
            cellId: body.cellId,
            runAttemptId: body.runAttemptId,
            rep: body.rep,
            generation: body.generation,
            seed: body.seed,
            signal: aborter.signal,
            placement: body.placement,
            cycleId: body.cycleId,
            trace: NOOP_TRACE,
            artifacts: NOOP_ARTIFACTS,
            cost: UNCONFIGURED_COST,
          }
      if (ctx.runAttemptId !== body.runAttemptId) {
        throw new Error('runDispatchServer: contextFactory must preserve request runAttemptId')
      }

      // Record every receipt this dispatch settles on ITS OWN `ctx.cost` (the
      // worker's ledger, not the coordinator's) so the response can carry
      // them back. `httpDispatch` replays each one into the coordinator's
      // ledger — see the module doc.
      const recordingCost: CampaignCostMeter = {
        async runPaidCall(input) {
          const result = await ctx.cost.runPaidCall(input)
          if (result.receipt) receipts.push(result.receipt)
          return result
        },
      }

      const artifact = await opts.dispatch(body.scenario, { ...ctx, cost: recordingCost })
      const responseBody: HttpDispatchResponseBody<TArtifact> = {
        artifact,
        ...(receipts.length ? { receipts } : {}),
      }

      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(responseBody))
      success = true
    } catch (err) {
      errCaught = err
      // Cancellation does not erase work that was already charged. A client
      // that can still read this response receives the same complete receipts.
      res.statusCode = (err as Error)?.name === 'AbortError' ? 499 : 500
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          ...(receipts.length ? { receipts } : {}),
        }),
      )
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

// ── Defaults for deterministic work; paid work needs a real context ──

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

const UNCONFIGURED_COST: CampaignCostMeter = {
  async runPaidCall() {
    throw new Error('runDispatchServer: paid work requires a contextFactory cost meter.')
  },
}
