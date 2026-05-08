/**
 * Replay-from-raw-events — turn every captured campaign run into a
 * re-runnable artifact.
 *
 * The premise: 0.21 made `RawProviderSink` capture every provider HTTP
 * envelope. 0.22's `runEvalCampaign` makes capture the default. Together
 * they mean every past run is a complete fingerprint of what happened on
 * the wire — and that fingerprint is enough to replay the run without
 * burning new LLM cost.
 *
 * Three use cases this primitive enables:
 *
 *   1. **Post-hoc judging** — apply a new judge / rubric / scoring callback
 *      to last week's runs without re-calling any LLM. The cost of trying
 *      a new rubric drops from "another full sweep" to a CPU-bound replay.
 *   2. **Determinism audits** — replay the same campaign and verify the
 *      raw responses match byte-for-byte. Any drift is a non-determinism
 *      bug (in the harness, the prompt builder, the sandbox, …).
 *   3. **Free judge calibration** — run two judges on identical responses
 *      and measure inter-judge agreement without doubling LLM spend.
 *
 * The interface is deliberately fetch-shaped. Inject `createReplayFetch`
 * into `LlmClientOptions.fetch` and every `callLlm` transparently reads
 * from the cache instead of calling the network. No new code path through
 * the LLM client is needed; the cache hit is invisible to the runner.
 */

import { canonicalize, hashJson } from './pre-registration'
import type { RawProviderEvent, RawProviderSink } from './trace/raw-provider-sink'

export class ReplayCacheMissError extends Error {
  constructor(
    public readonly url: string,
    public readonly requestKey: string,
    message?: string,
  ) {
    super(message ?? `replay cache miss for ${url} (key=${requestKey})`)
    this.name = 'ReplayCacheMissError'
  }
}

export interface ReplayCacheEntry {
  request: RawProviderEvent
  response: RawProviderEvent
}

export interface ReplayCacheStats {
  total: number
  byProvider: Record<string, number>
  byModel: Record<string, number>
  /** Spans for which we have a request but no response (run aborted mid-call). */
  orphanRequests: number
}

/**
 * In-memory deterministic cache of (request → response) keyed on a stable
 * hash of the request body. Built from a `RawProviderSink` containing
 * paired `request` and `response` events from a previous run.
 *
 * The cache is the source of truth for replay; `createReplayFetch` is a
 * thin wrapper that reads from it.
 */
export class ReplayCache {
  private byKey = new Map<string, ReplayCacheEntry>()
  private orphans = 0
  private byProvider: Record<string, number> = {}
  private byModel: Record<string, number> = {}

  /**
   * Build a cache from a sink's events. The sink must implement `list()`.
   * Filter by `runId` / `spanId` to scope to a specific replay.
   */
  static async fromSink(
    sink: RawProviderSink,
    filter: { runId?: string; spanId?: string } = {},
  ): Promise<ReplayCache> {
    if (!sink.list) {
      throw new Error('ReplayCache.fromSink: sink must implement list() to be replayable.')
    }
    const events = await sink.list(filter)
    return ReplayCache.fromEvents(events)
  }

  /** Build a cache from an in-memory event list. */
  static async fromEvents(events: RawProviderEvent[]): Promise<ReplayCache> {
    const cache = new ReplayCache()
    // Group by (runId, spanId, attemptIndex) so request/response/error pairs are matched.
    // A cell can have many spans; each retry attempt within a span is a separate group.
    type GroupKey = string
    const groups = new Map<GroupKey, { req?: RawProviderEvent; res?: RawProviderEvent }>()
    for (const e of events) {
      const k = `${e.runId ?? ''}::${e.spanId ?? ''}::${e.attemptIndex}`
      const g = groups.get(k) ?? {}
      if (e.direction === 'request') g.req = e
      else g.res = e
      groups.set(k, g)
    }
    for (const g of groups.values()) {
      if (!g.req) continue
      if (!g.res) {
        cache.orphans += 1
        continue
      }
      const key = await requestKey(g.req)
      cache.byKey.set(key, { request: g.req, response: g.res })
      cache.byProvider[g.req.provider] = (cache.byProvider[g.req.provider] ?? 0) + 1
      cache.byModel[g.req.model] = (cache.byModel[g.req.model] ?? 0) + 1
    }
    return cache
  }

  /** Number of cacheable (request, response) pairs in the cache. */
  size(): number { return this.byKey.size }

  stats(): ReplayCacheStats {
    return {
      total: this.byKey.size,
      byProvider: { ...this.byProvider },
      byModel: { ...this.byModel },
      orphanRequests: this.orphans,
    }
  }

  /**
   * Look up a cached response by hashing the (model, messages, temperature,
   * maxTokens, response_format) shape. Returns `undefined` on miss; the
   * caller decides whether to throw, fall back to the network, or skip.
   */
  async lookup(requestBody: unknown): Promise<ReplayCacheEntry | undefined> {
    const key = await keyFromBody(requestBody)
    return this.byKey.get(key)
  }
}

export interface ReplayFetchOptions {
  /**
   * Behaviour on cache miss. Default `'throw'`. `'fallback'` calls the
   * `fallbackFetch` (typically `globalThis.fetch`) so a partial replay can
   * still complete; `'fail-closed'` returns a synthetic 599 response so the
   * call site sees a non-retriable failure.
   */
  onMiss?: 'throw' | 'fallback' | 'fail-closed'
  fallbackFetch?: typeof fetch
  /** Optional callback fired once per replayed call (for telemetry / counters). */
  onHit?: (info: { url: string; provider: string; model: string }) => void
  /** Optional callback fired on cache miss before the `onMiss` policy applies. */
  onMissNotify?: (info: { url: string; requestBody: unknown }) => void
}

/**
 * Build a `fetch`-shaped function that serves cached responses out of a
 * `ReplayCache` for any URL ending in `/chat/completions`. Pass through
 * `LlmClientOptions.fetch` and `callLlm` becomes free.
 *
 * Non-`/chat/completions` URLs are passed straight to the fallback fetch
 * (default: `globalThis.fetch`). This matters because non-LLM HTTP work
 * (judge HTTP servers, sandbox callbacks) sometimes flows through the same
 * `fetch` and shouldn't be intercepted.
 */
export function createReplayFetch(
  cache: ReplayCache,
  opts: ReplayFetchOptions = {},
): typeof fetch {
  const onMiss = opts.onMiss ?? 'throw'
  const fallback = opts.fallbackFetch ?? (globalThis.fetch?.bind(globalThis))

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!/\/chat\/completions(?:[?#].*)?$/.test(url)) {
      if (!fallback) throw new Error(`replay fetch: non-completions URL ${url} but no fallbackFetch configured`)
      return fallback(input as RequestInfo, init)
    }
    let bodyParsed: unknown
    if (init?.body && typeof init.body === 'string') {
      try { bodyParsed = JSON.parse(init.body) } catch { /* raw body, not JSON */ }
    }
    const hit = bodyParsed === undefined ? undefined : await cache.lookup(bodyParsed)
    if (hit) {
      opts.onHit?.({ url, provider: hit.request.provider, model: hit.request.model })
      const status = hit.response.statusCode ?? 200
      const headers = new Headers(Object.entries(hit.response.responseHeaders ?? { 'Content-Type': 'application/json' }))
      const bodyText = typeof hit.response.responseBody === 'string'
        ? hit.response.responseBody
        : JSON.stringify(hit.response.responseBody ?? {})
      return new Response(bodyText, { status, headers })
    }
    opts.onMissNotify?.({ url, requestBody: bodyParsed })
    if (onMiss === 'throw') {
      const key = bodyParsed === undefined ? '<unparseable>' : await keyFromBody(bodyParsed)
      throw new ReplayCacheMissError(url, key)
    }
    if (onMiss === 'fail-closed') {
      return new Response(JSON.stringify({ error: 'replay_cache_miss' }), { status: 599 })
    }
    if (!fallback) throw new Error('replay fetch: onMiss=fallback but no fallbackFetch configured')
    return fallback(input as RequestInfo, init)
  }) as typeof fetch
}

/**
 * Convenience iterator over `(request, response)` pairs in a sink — for
 * post-hoc scoring that doesn't need a `fetch` shim. The judge or scorer
 * runs purely in-process over cached LLM outputs.
 */
export async function* iterateRawCalls(
  sink: RawProviderSink,
  filter: { runId?: string; spanId?: string } = {},
): AsyncGenerator<ReplayCacheEntry> {
  if (!sink.list) {
    throw new Error('iterateRawCalls: sink must implement list().')
  }
  const events = await sink.list(filter)
  const cache = await ReplayCache.fromEvents(events)
  for (const entry of cache['byKey'].values()) yield entry
}

// ── Hashing ──────────────────────────────────────────────────────────────

/**
 * Canonical request key.
 *
 * `model + messages + temperature + max_tokens|max_completion_tokens +
 * response_format` are the dimensions that affect the response shape.
 * Other fields (timestamp headers, provider-specific metadata) are
 * intentionally excluded so a request hashes the same across re-runs.
 */
async function requestKey(event: RawProviderEvent): Promise<string> {
  return keyFromBody(event.requestBody)
}

async function keyFromBody(body: unknown): Promise<string> {
  if (body == null || typeof body !== 'object') return hashJson({ raw: String(body) })
  const b = body as Record<string, unknown>
  const reduced = canonicalize({
    model: b.model ?? null,
    messages: b.messages ?? null,
    temperature: b.temperature ?? null,
    max_tokens: b.max_tokens ?? null,
    max_completion_tokens: b.max_completion_tokens ?? null,
    response_format: b.response_format ?? null,
  })
  return hashJson(reduced)
}
