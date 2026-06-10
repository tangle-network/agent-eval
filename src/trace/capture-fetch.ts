/**
 * `captureFetchToRawSink` — wrap a `fetch` so every request / response / error
 * against a provider is recorded into a `RawProviderSink` as the canonical
 * `RawProviderEvent` triple. The one substrate copy of the fetch-capture
 * pattern four consumers hand-roll (legal ships two copies).
 *
 * The returned value is a plain `typeof fetch` — pass it as the `fetchImpl` to
 * any OpenAI-compatible backend factory. Capture is best-effort by default: a
 * sink write that throws does NOT take down the underlying LLM call (set
 * `failClosed` to change that). Uses the existing `defaultProviderRedactor` +
 * `providerFromBaseUrl` — no new redaction policy.
 */

import { type ExtractedUsage, extractUsage, extractUsageFromSse } from './extract-usage'
import {
  defaultProviderRedactor,
  type ProviderRedactor,
  providerFromBaseUrl,
  type RawProviderDirection,
  type RawProviderEvent,
  type RawProviderSink,
} from './raw-provider-sink'

export interface CaptureFetchContext {
  /** Logical run id stamped on every captured event. Required — without it
   *  the raw events can't be paired with their parent `Run`. */
  runId: string
  /** Optional logical span id (enables span-level sink filtering). */
  spanId?: string
  /** Resolved base URL (normalised, no trailing slash). Used for the event's
   *  `baseUrl` and for endpoint-path extraction. */
  baseUrl: string
  /** Model id the caller intends to invoke. Stamped on every event. */
  model: string
  /** Provider override. When omitted, `providerFromBaseUrl(baseUrl)`. */
  provider?: string
}

export interface CaptureFetchOptions {
  /** Override the capture-time redactor. Default `defaultProviderRedactor`. */
  redactor?: ProviderRedactor
  /** Cap on captured response-body bytes; beyond it the body is truncated and
   *  `body_truncated` is added to `redactedFields`. Default 2 MiB. */
  responseBodyByteCap?: number
  /** When true, a sink-write failure propagates to the caller. Default false
   *  — capture is best-effort so a sink failure never kills the LLM call. */
  failClosed?: boolean
  /**
   * Invoked with the token usage parsed off each successful response (JSON or
   * SSE), keyed by the captured context. Lets a caller fold usage → cost without
   * re-cloning the response themselves. Not called when the response carries no
   * usage. Best-effort: a throw here is swallowed (it never kills the LLM call)
   * unless `failClosed` is set.
   */
  onUsage?: (usage: ExtractedUsage, ctx: CaptureFetchContext) => void
}

const DEFAULT_BODY_CAP = 2 * 1024 * 1024

function headersToRecord(headers: Headers | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return Object.keys(out).length > 0 ? out : undefined
}

function parseMaybeJson(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Best-effort request-body read across the `fetch` input forms. */
async function readRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<unknown> {
  if (typeof init?.body === 'string') return parseMaybeJson(init.body)
  if (init?.body != null) return undefined // streams / FormData / Blob — not captured
  if (input instanceof Request) {
    try {
      return parseMaybeJson(await input.clone().text())
    } catch {
      return undefined
    }
  }
  return undefined
}

function endpointFromUrl(url: string, baseUrl: string): string {
  const normalisedBase = baseUrl.replace(/\/+$/, '')
  if (url.startsWith(normalisedBase)) return url.slice(normalisedBase.length) || '/'
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

export function captureFetchToRawSink(
  fetch: typeof globalThis.fetch,
  sink: RawProviderSink,
  ctx: CaptureFetchContext,
  opts: CaptureFetchOptions = {},
): typeof globalThis.fetch {
  const provider = ctx.provider ?? providerFromBaseUrl(ctx.baseUrl)
  const redactor = opts.redactor ?? defaultProviderRedactor
  const bodyCap = opts.responseBodyByteCap ?? DEFAULT_BODY_CAP
  let warned = false

  const baseEvent = (direction: RawProviderDirection, endpoint: string): RawProviderEvent => ({
    eventId: crypto.randomUUID(),
    runId: ctx.runId,
    spanId: ctx.spanId,
    provider,
    model: ctx.model,
    endpoint,
    baseUrl: ctx.baseUrl,
    attemptIndex: 0, // retries are re-invocations one layer up; documented in 0.x
    direction,
    timestamp: Date.now(),
    redactedFields: [],
  })

  const record = async (event: RawProviderEvent): Promise<void> => {
    try {
      await sink.record(redactor(event))
    } catch (err) {
      if (opts.failClosed) throw err
      if (!warned) {
        warned = true
        console.warn(
          `captureFetchToRawSink: sink.record failed (capture is best-effort) — ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const endpoint = endpointFromUrl(url, ctx.baseUrl)

    const reqHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    await record({
      ...baseEvent('request', endpoint),
      requestHeaders: { ...headersToRecord(reqHeaders), 'x-http-method': method },
      requestBody: await readRequestBody(input, init),
    })

    const start = Date.now()
    let response: Response
    try {
      response = await fetch(input, init)
    } catch (err) {
      await record({
        ...baseEvent('error', endpoint),
        durationMs: Date.now() - start,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    // Read the body off a clone so the caller still consumes the original.
    let responseBody: unknown
    let rawText: string | undefined
    const redactedFields: string[] = []
    try {
      rawText = await response.clone().text()
      if (rawText.length > bodyCap) {
        responseBody = rawText.slice(0, bodyCap)
        redactedFields.push('body_truncated')
      } else {
        responseBody = parseMaybeJson(rawText)
      }
    } catch {
      responseBody = undefined
    }

    if (opts.onUsage && rawText !== undefined) {
      // Reuse the body already read for capture; no extra clone. JSON first,
      // then SSE accumulation. A throw in the consumer's callback is swallowed
      // (best-effort) unless failClosed is set — the LLM call must not die here.
      try {
        const parsedForUsage = parseMaybeJson(rawText)
        const usage =
          extractUsage(parsedForUsage) ??
          (typeof parsedForUsage === 'string' ? extractUsageFromSse(rawText) : null)
        if (usage) opts.onUsage(usage, ctx)
      } catch (err) {
        if (opts.failClosed) throw err
      }
    }

    await record({
      ...baseEvent('response', endpoint),
      durationMs: Date.now() - start,
      statusCode: response.status,
      responseHeaders: headersToRecord(response.headers),
      responseBody,
      redactedFields,
    })

    return response
  }
}
