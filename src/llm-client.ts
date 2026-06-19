/**
 * LLM client with graceful degrade.
 *
 * OpenAI-compatible `/v1/chat/completions` client with:
 *   - Exponential-backoff retry on 429 + 5xx gateway errors (502/503/504).
 *   - Retry on transient network errors (fetch failed, AbortError, ECONNRESET).
 *   - Graceful json_schema → json_object degrade on 400 with schema-reject body.
 *   - Fenced-JSON stripping (```json ... ```) for models that wrap structured output.
 *   - Configurable base URL + api key / bearer, works with LiteLLM proxies, OpenAI
 *     directly, cli-bridge subscriptions, and any router that speaks the spec.
 *
 * Usage:
 *   const { value, result } = await callLlmJson<MyType>(
 *     { model: 'gpt-4o', messages: [...], jsonSchema: { name: 'x', schema: {...} } },
 *     { baseUrl: 'https://router.tangle.tools/v1', apiKey: process.env.KEY },
 *   )
 *
 * This is THE llm-calling seam for agent-eval primitives that need structured
 * output (semantic concept judge, reviewer directives, critic scores). Primitives
 * that need free-form text use `callLlm` and parse output themselves.
 */

import { AgentEvalError, CaptureIntegrityError } from './errors'
import {
  defaultProviderRedactor,
  type ProviderRedactor,
  providerFromBaseUrl,
  type RawProviderEvent,
  type RawProviderSink,
} from './trace/raw-provider-sink'

// ─── Types ──────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  /**
   * Either a plain text content string OR a multimodal content array
   * (text + image_url parts) for vision-capable models.
   */
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
      >
}

export interface LlmCallRequest {
  model: string
  messages: LlmMessage[]
  /** Optional JSON-mode response format (response_format: json_object). */
  jsonMode?: boolean
  /** Optional structured output via JSON Schema. Falls back to json_object on 400. */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  temperature?: number
  maxTokens?: number
  /** Per-call timeout, default 300s. */
  timeoutMs?: number
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Proxies populate this when prompt caching is on. */
  cachedPromptTokens?: number
}

export interface LlmCallResult {
  /** The text content of the first choice. Empty string if none. */
  content: string
  usage: LlmUsage
  /**
   * Cost in USD. Pulled from proxy's `_response_cost` field when present;
   * `null` when neither the proxy nor the caller can derive it.
   */
  costUsd: number | null
  /** Model name actually used (echoed from response). */
  model: string
  /** Wall-clock duration of the HTTP call (last attempt, if retried). */
  durationMs: number
  /**
   * `finish_reason` echoed from the first choice (`stop`, `length`,
   * `content_filter`, `tool_calls`, ...). `null` when the provider omits it.
   * Exposed so a free-form `callLlm` caller CAN detect a truncated answer
   * (`length`) instead of treating a cut-off completion as complete. Note:
   * `callLlm` does not itself reject on it — acting on this signal is the
   * caller's responsibility (in-repo free-form drivers do not yet enforce it).
   */
  finishReason?: string | null
  /**
   * True when `content.trim()` is empty. An empty completion is a silent zero
   * for free-form `callLlm` callers; this flag is the signal a caller can
   * inspect to fail loud rather than proceed on an empty string. `callLlm`
   * surfaces it but does not throw on it.
   */
  contentEmpty?: boolean
  /** Raw response body. */
  raw: Record<string, unknown>
}

export class LlmCallError extends AgentEvalError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly model: string,
  ) {
    super('judge', message)
  }
}

export interface LlmClientOptions {
  /** Base URL (without trailing slash). Must end at the `/v1` prefix. */
  baseUrl?: string
  /** Bearer token — either `apiKey` or `bearer` populates `Authorization: Bearer ...`. */
  apiKey?: string
  bearer?: string
  /** Override for the `Authorization` header (e.g. `X-Auth: ...`). Takes precedence over apiKey/bearer. */
  authHeader?: { name: string; value: string }
  /** Default timeout in ms. Per-call can override. */
  defaultTimeoutMs?: number
  /**
   * Caller-supplied abort signal — e.g. a campaign-wide cancel. Linked to
   * each attempt's per-attempt timeout controller, so aborting it cancels
   * the in-flight fetch. A caller abort is FATAL: it is not retried even
   * though an AbortError otherwise matches the transient patterns.
   */
  signal?: AbortSignal
  /**
   * Cross-attempt wall-clock budget in ms, measured from the first attempt.
   * Before launching each attempt the loop checks the remaining budget and
   * stops retrying once it is exhausted, rather than waiting the full
   * per-attempt timeout on every retry. Bounds total time independent of
   * `maxRetries` × `timeoutMs`.
   */
  deadlineMs?: number
  /** Max retry attempts on retriable errors. Default 3 (1 initial + 2 retries). */
  maxRetries?: number
  /** Fetch implementation — defaults to global `fetch`. Override for custom transport (e.g. tests). */
  fetch?: typeof fetch
  /**
   * Optional raw HTTP capture sink. When provided, every request, response,
   * and error (across all retry attempts) is recorded to the sink, with auth
   * headers and credential-shaped body fields redacted by default. This is
   * the layer-1 forensics primitive: structured `LlmSpan`s record intent,
   * raw events record what actually crossed the wire.
   */
  rawSink?: RawProviderSink
  /**
   * Logical provider id attached to raw events. When omitted, derived from
   * `baseUrl` via `providerFromBaseUrl`.
   */
  provider?: string
  /** Trace context attached to raw events; populated by emitter-aware callers. */
  traceContext?: { runId?: string; spanId?: string }
  /** Override the redaction strategy for this call. Defaults to `defaultProviderRedactor`. */
  redactor?: ProviderRedactor
}

// ─── Internals ──────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://router.tangle.tools/v1'
// Flagship / reasoning models routinely take several minutes on large prompts (a
// reflection over many failures, a long tool transcript). A tight cap aborts a
// legitimately-slow but healthy call — and because every retry attempt re-uses
// the same window, such a model aborts on ALL attempts and the loop throws. The
// default is generous enough to let those complete, bounded enough that a truly
// hung call still fails over after retries, and tunable per deployment via
// TANGLE_LLM_TIMEOUT_MS. Per-call `req.timeoutMs` / `opts.defaultTimeoutMs`
// still win for callers that know their model's latency.
const DEFAULT_TIMEOUT_MS = Number(process.env.TANGLE_LLM_TIMEOUT_MS) || 300_000
const DEFAULT_MAX_RETRIES = Number(process.env.TANGLE_LLM_MAX_RETRIES) || 3

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

/**
 * Transient transport/network error signatures, matched against an error's
 * name, message, and `code`. Covers fetch/undici network failures, aborts
 * and timeouts, and — critically — HTTP/2 transport faults a keep-alive
 * connection raises mid-response: `terminated`, `NGHTTP2_INTERNAL_ERROR`,
 * `UND_ERR_*`, `other side closed`. Those last ones carry no clean HTTP
 * status; unrecognised, they escape the retry loop and surface as an
 * uncaught rejection.
 */
const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /AbortError/i,
  /TimeoutError/i,
  /this operation was aborted/i,
  /fetch failed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /stream.*ended.*unexpectedly/i,
  /terminated/i,
  /other side closed/i,
  /NGHTTP2/i,
  /UND_ERR/i,
]

/**
 * True when an error is a transient transport/network fault worth retrying,
 * as opposed to a deterministic failure (4xx schema reject, JSON parse) that
 * a retry cannot fix. Inspects `LlmCallError.status`, then the error's
 * name/message/code, then recurses into `error.cause` — undici nests the
 * real socket fault one or more levels under `.cause`.
 *
 * This is THE retry classifier for the package: `callLlm` and
 * `withJudgeRetry` both route through it, so a connection-class error is
 * treated identically whether it surfaces in the HTTP client or a
 * TCloud-backed judge.
 */
export function isTransientLlmError(err: unknown): boolean {
  return classifyTransient(err, 0)
}

function classifyTransient(err: unknown, depth: number): boolean {
  if (err instanceof LlmCallError) return RETRYABLE_STATUS.has(err.status)
  if (!(err instanceof Error)) return false
  // Foreign errors (e.g. a TCloud judge SDK error) can carry a numeric HTTP
  // status without being an LlmCallError — a retryable status is decisive.
  const status = (err as { status?: unknown }).status
  if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true
  const code = (err as { code?: unknown }).code
  const haystack = `${err.name}\n${err.message}\n${typeof code === 'string' ? code : ''}`
  if (TRANSIENT_ERROR_PATTERNS.some((p) => p.test(haystack))) return true
  const cause = (err as { cause?: unknown }).cause
  if (depth < 4 && cause instanceof Error && cause !== err) {
    return classifyTransient(cause, depth + 1)
  }
  return false
}

function parseRetryAfter(headers: Headers): number | null {
  const h = headers.get('retry-after')
  if (!h) return null
  const asNumber = Number(h)
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber * 1000
  const asDate = Date.parse(h)
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())
  return null
}

/** Exponential backoff: 500ms, 1s, 2s, 4s, ... capped at 16s. Attempt is 0-indexed. */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 16_000)
}

function buildHeaders(opts: LlmClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (opts.authHeader) {
    headers[opts.authHeader.name] = opts.authHeader.value
  } else if (opts.bearer || opts.apiKey) {
    headers.Authorization = `Bearer ${opts.bearer ?? opts.apiKey}`
  }
  return headers
}

function isSchemaRejection(status: number, body: string): boolean {
  if (status !== 400) return false
  const lower = body.toLowerCase()
  return (
    lower.includes('response_format') ||
    lower.includes('json_schema') ||
    lower.includes('is unavailable') ||
    lower.includes('not supported')
  )
}

function buildBody(req: LlmCallRequest, forceJsonObject: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0,
  }
  if (req.maxTokens != null) {
    if (usesMaxCompletionTokens(req.model)) body.max_completion_tokens = req.maxTokens
    else body.max_tokens = req.maxTokens
  }

  if (req.jsonSchema && !forceJsonObject) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
    }
  } else if (req.jsonMode || req.jsonSchema) {
    body.response_format = { type: 'json_object' }
  }

  return body
}

function usesMaxCompletionTokens(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Combine the per-attempt timeout signal with an optional caller signal into
 * one signal the fetch listens on. Prefers the native `AbortSignal.any`; falls
 * back to manual wiring on runtimes that predate it. The caller signal is also
 * propagated to the timeout controller so aborting it cancels the in-flight
 * fetch immediately.
 */
function linkSignals(timeoutController: AbortController, caller?: AbortSignal): AbortSignal {
  if (!caller) return timeoutController.signal
  if (typeof (AbortSignal as { any?: unknown }).any === 'function') {
    return AbortSignal.any([timeoutController.signal, caller])
  }
  if (caller.aborted) {
    timeoutController.abort()
  } else {
    caller.addEventListener('abort', () => timeoutController.abort(), { once: true })
  }
  return timeoutController.signal
}

/** True once the cross-attempt wall-clock budget (if any) is exhausted. */
function deadlineExceeded(start: number, deadlineMs: number | undefined): boolean {
  return deadlineMs != null && Date.now() - start >= deadlineMs
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Strip a ```json / ``` code fence if the model emitted one.
 * Idempotent for naked JSON. Some models (claude-code via router, certain
 * deepseek models) wrap output even under json_object.
 */
export function stripFencedJson(raw: string): string {
  const trimmed = raw.trim()
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
  return m ? m[1]!.trim() : trimmed
}

export function extractJsonPayload(raw: string): string {
  const stripped = stripFencedJson(raw)
  try {
    JSON.parse(stripped)
    return stripped
  } catch {
    // Continue with balanced extraction below.
  }

  const starts = [...stripped.matchAll(/[[{]/g)]
    .map((match) => match.index)
    .filter((index) => index != null)
  for (const start of starts) {
    const candidate = extractBalancedJson(stripped, start)
    if (!candidate) continue
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // Keep scanning; earlier braces may belong to prose.
    }
  }

  return stripped
}

function extractBalancedJson(input: string, start: number): string | null {
  const opener = input[start]
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : null
  if (!closer) return null

  const stack: string[] = [closer]
  let isInString = false
  let isEscaped = false

  for (let i = start + 1; i < input.length; i++) {
    const char = input[i]!
    if (isEscaped) {
      isEscaped = false
      continue
    }
    if (char === '\\') {
      isEscaped = isInString
      continue
    }
    if (char === '"') {
      isInString = !isInString
      continue
    }
    if (isInString) continue

    if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return input.slice(start, i + 1)
    }
  }

  return null
}

/**
 * Low-level call. Returns raw content + usage + cost. Retries on transient
 * failures; does NOT degrade schema here — callers that want graceful
 * degrade use `callLlmJson`.
 */
export async function callLlm(
  req: LlmCallRequest,
  opts: LlmClientOptions = {},
): Promise<LlmCallResult> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`
  const endpoint = '/chat/completions'
  const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const fetchFn = opts.fetch ?? globalThis.fetch
  const headers = buildHeaders(opts)
  const provider = opts.provider ?? providerFromBaseUrl(baseUrl)
  const sink = opts.rawSink
  const redactor = opts.redactor ?? defaultProviderRedactor
  const traceContext = opts.traceContext
  const callerSignal = opts.signal
  const deadlineMs = opts.deadlineMs
  const deadlineStart = Date.now()

  let lastErr: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // A caller cancel is fatal — never retried. Checking before each attempt
    // means an already-aborted signal short-circuits without firing fetch.
    if (callerSignal?.aborted) {
      throw new DOMException('callLlm aborted by caller signal', 'AbortError')
    }
    // Stop retrying once the cross-attempt budget is spent rather than burning
    // a full per-attempt timeout on each remaining retry.
    if (attempt > 0 && deadlineExceeded(deadlineStart, deadlineMs)) {
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
    }
    const controller = new AbortController()
    const attemptSignal = linkSignals(controller, callerSignal)
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    const requestBody = buildBody(req, false)
    let attemptErrorRecorded = false
    if (sink) {
      await recordRaw(sink, redactor, {
        eventId: cryptoEventId(),
        runId: traceContext?.runId,
        spanId: traceContext?.spanId,
        provider,
        model: req.model,
        endpoint,
        baseUrl,
        attemptIndex: attempt,
        direction: 'request',
        timestamp: started,
        requestHeaders: headers,
        requestBody,
        redactedFields: [],
      })
    }

    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: attemptSignal,
      })
      clearTimeout(timeoutHandle)
      const responseHeaders = sink ? headersToObject(res.headers) : undefined

      if (!res.ok) {
        const body = await res.text()
        if (sink) {
          await recordRaw(sink, redactor, {
            eventId: cryptoEventId(),
            runId: traceContext?.runId,
            spanId: traceContext?.spanId,
            provider,
            model: req.model,
            endpoint,
            baseUrl,
            attemptIndex: attempt,
            direction: 'error',
            timestamp: Date.now(),
            durationMs: Date.now() - started,
            statusCode: res.status,
            responseHeaders,
            responseBody: body,
            errorMessage: `HTTP ${res.status}`,
            redactedFields: [],
          })
          attemptErrorRecorded = true
        }
        const err = new LlmCallError(
          `LLM call ${res.status}: ${body.slice(0, 300)}`,
          res.status,
          body,
          req.model,
        )
        if (
          RETRYABLE_STATUS.has(res.status) &&
          attempt < maxRetries - 1 &&
          !deadlineExceeded(deadlineStart, deadlineMs)
        ) {
          lastErr = err
          const retryAfter = parseRetryAfter(res.headers)
          await sleep(retryAfter ?? backoffMs(attempt))
          continue
        }
        throw err
      }

      const text = await res.text()
      let json: Record<string, unknown>
      try {
        json = JSON.parse(text) as Record<string, unknown>
      } catch (parseErr) {
        if (sink) {
          await recordRaw(sink, redactor, {
            eventId: cryptoEventId(),
            runId: traceContext?.runId,
            spanId: traceContext?.spanId,
            provider,
            model: req.model,
            endpoint,
            baseUrl,
            attemptIndex: attempt,
            direction: 'error',
            timestamp: Date.now(),
            durationMs: Date.now() - started,
            statusCode: res.status,
            responseHeaders,
            responseBody: text,
            errorMessage: `non-JSON response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            redactedFields: [],
          })
          attemptErrorRecorded = true
        }
        throw parseErr
      }
      if (sink) {
        await recordRaw(sink, redactor, {
          eventId: cryptoEventId(),
          runId: traceContext?.runId,
          spanId: traceContext?.spanId,
          provider,
          model: req.model,
          endpoint,
          baseUrl,
          attemptIndex: attempt,
          direction: 'response',
          timestamp: Date.now(),
          durationMs: Date.now() - started,
          statusCode: res.status,
          responseHeaders,
          responseBody: json,
          redactedFields: [],
        })
      }
      const choice = (
        json.choices as
          | Array<{ message?: { content?: string }; finish_reason?: string | null }>
          | undefined
      )?.[0]
      const usageRaw = (json.usage as Record<string, unknown> | undefined) ?? {}
      const costFromProxy = (json._response_cost ?? json.cost_usd) as number | undefined
      const content = choice?.message?.content ?? ''

      return {
        content,
        finishReason: choice?.finish_reason ?? null,
        contentEmpty: content.trim().length === 0,
        usage: {
          promptTokens: Number(usageRaw.prompt_tokens ?? 0),
          completionTokens: Number(usageRaw.completion_tokens ?? 0),
          totalTokens: Number(usageRaw.total_tokens ?? 0),
          cachedPromptTokens:
            usageRaw.prompt_tokens_details && typeof usageRaw.prompt_tokens_details === 'object'
              ? Number(
                  (usageRaw.prompt_tokens_details as Record<string, unknown>).cached_tokens ?? 0,
                )
              : undefined,
        },
        costUsd: typeof costFromProxy === 'number' ? costFromProxy : null,
        model: (json.model as string) ?? req.model,
        durationMs: Date.now() - started,
        raw: json,
      }
    } catch (err) {
      clearTimeout(timeoutHandle)
      lastErr = err
      // A caller cancel is fatal even though an AbortError matches the
      // transient patterns — a cancelled call must surface immediately, not
      // be retried against the same dead intent.
      if (callerSignal?.aborted) {
        if (sink && !attemptErrorRecorded) {
          await recordRaw(sink, redactor, {
            eventId: cryptoEventId(),
            runId: traceContext?.runId,
            spanId: traceContext?.spanId,
            provider,
            model: req.model,
            endpoint,
            baseUrl,
            attemptIndex: attempt,
            direction: 'error',
            timestamp: Date.now(),
            durationMs: Date.now() - started,
            errorMessage: err instanceof Error ? err.message : String(err),
            redactedFields: [],
          })
        }
        throw err
      }
      if (sink && !attemptErrorRecorded) {
        // Record only if neither the !res.ok branch nor the JSON.parse catch
        // already produced an error event for this attempt. Covers network
        // failures, timeouts, and aborts.
        await recordRaw(sink, redactor, {
          eventId: cryptoEventId(),
          runId: traceContext?.runId,
          spanId: traceContext?.spanId,
          provider,
          model: req.model,
          endpoint,
          baseUrl,
          attemptIndex: attempt,
          direction: 'error',
          timestamp: Date.now(),
          durationMs: Date.now() - started,
          errorMessage: err instanceof Error ? err.message : String(err),
          redactedFields: [],
        })
      }
      if (
        attempt < maxRetries - 1 &&
        isTransientLlmError(err) &&
        !deadlineExceeded(deadlineStart, deadlineMs)
      ) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function recordRaw(
  sink: RawProviderSink,
  redactor: ProviderRedactor,
  event: RawProviderEvent,
): Promise<void> {
  // Errors from sinks must not crash the LLM call. Forensic capture is
  // best-effort; the structured trace is the system of record.
  try {
    await sink.record(redactor(event))
  } catch {
    // Intentionally swallowed.
  }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function cryptoEventId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Structured-output call. Returns parsed JSON plus the raw result envelope.
 * Degrades `jsonSchema` → `jsonMode` on a 400 that names the schema param —
 * critical for deepseek-v3/v4, kimi-k2.6, and other models that don't accept
 * the `response_format.json_schema` shape but DO accept `json_object`.
 */
export async function callLlmJson<T = unknown>(
  req: LlmCallRequest,
  opts: LlmClientOptions = {},
): Promise<{ value: T; result: LlmCallResult }> {
  try {
    const result = await callLlm({ ...req, jsonMode: req.jsonMode ?? !req.jsonSchema }, opts)
    const value = parseJsonSafely<T>(result.content, result.model)
    return { value, result }
  } catch (err) {
    if (err instanceof LlmCallError && isSchemaRejection(err.status, err.body) && req.jsonSchema) {
      // Degrade to json_object + retry.
      const degradedReq: LlmCallRequest = { ...req, jsonMode: true, jsonSchema: undefined }
      const result = await callLlm(degradedReq, opts)
      const value = parseJsonSafely<T>(result.content, result.model)
      return { value, result }
    }
    throw err
  }
}

function parseJsonSafely<T>(content: string, model: string): T {
  const stripped = extractJsonPayload(content)
  try {
    return JSON.parse(stripped) as T
  } catch (err) {
    throw new Error(
      `LLM returned non-JSON content (model=${model}): ${
        err instanceof Error ? err.message : String(err)
      }\n--- raw content ---\n${content.slice(0, 800)}`,
    )
  }
}

// ─── Route assertion ────────────────────────────────────────────────────

export type LlmRouteAssertionReason =
  | 'no_explicit_base_url'
  | 'base_url_blocked'
  | 'base_url_not_allowed'
  | 'no_auth'
  | 'wrong_provider'

export class LlmRouteAssertionError extends CaptureIntegrityError {
  constructor(
    message: string,
    public readonly reason: LlmRouteAssertionReason,
    public readonly baseUrl: string,
  ) {
    super(message)
  }
}

export interface LlmRouteRequirements {
  /**
   * Throw if `opts.baseUrl` is undefined, i.e. the call would fall back to
   * `DEFAULT_BASE_URL`. Set this for evaluation runs where silently using
   * the public/free-tier router is a defect — the launch reviewer needs to
   * know exactly which provider answered.
   */
  requireExplicitBaseUrl?: boolean
  /**
   * Allowlist of acceptable base URLs. Strings match by prefix
   * (case-insensitive); RegExps test against the full base URL.
   */
  allowedBaseUrls?: Array<string | RegExp>
  /** Blocklist that takes precedence over `allowedBaseUrls`. */
  blockedBaseUrls?: Array<string | RegExp>
  /** Throw if no auth header / api key is configured. */
  requireAuth?: boolean
  /**
   * Logical provider id the configured `baseUrl` is expected to match (via
   * `providerFromBaseUrl`). Mainly useful when paired with `requireExplicitBaseUrl`.
   */
  expectedProvider?: string
}

/**
 * Fail-loud assertion that the configured LLM client points at the route
 * the caller intends. Designed for the matrix-runner preflight: invoke
 * once before any LLM call to catch misconfiguration before a sweep burns
 * dollars on the wrong provider.
 *
 * Throws `LlmRouteAssertionError`. Pure — no I/O — so it's safe to call
 * from constructors and CI gates.
 */
export function assertLlmRoute(opts: LlmClientOptions, req: LlmRouteRequirements = {}): void {
  const baseUrlExplicit = opts.baseUrl !== undefined
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

  if (req.requireExplicitBaseUrl && !baseUrlExplicit) {
    throw new LlmRouteAssertionError(
      `assertLlmRoute: requireExplicitBaseUrl set but opts.baseUrl is undefined; would fall back to ${DEFAULT_BASE_URL}.`,
      'no_explicit_base_url',
      baseUrl,
    )
  }

  if (req.blockedBaseUrls?.some((p) => matchUrl(baseUrl, p))) {
    throw new LlmRouteAssertionError(
      `assertLlmRoute: baseUrl ${baseUrl} matches a blocked pattern.`,
      'base_url_blocked',
      baseUrl,
    )
  }

  if (req.allowedBaseUrls && req.allowedBaseUrls.length > 0) {
    const ok = req.allowedBaseUrls.some((p) => matchUrl(baseUrl, p))
    if (!ok) {
      throw new LlmRouteAssertionError(
        `assertLlmRoute: baseUrl ${baseUrl} is not in the allowed list (${req.allowedBaseUrls.map(describePattern).join(', ')}).`,
        'base_url_not_allowed',
        baseUrl,
      )
    }
  }

  if (req.requireAuth && !opts.apiKey && !opts.bearer && !opts.authHeader) {
    throw new LlmRouteAssertionError(
      `assertLlmRoute: requireAuth set but no apiKey, bearer, or authHeader was supplied.`,
      'no_auth',
      baseUrl,
    )
  }

  if (req.expectedProvider) {
    const actual = opts.provider ?? providerFromBaseUrl(baseUrl)
    if (actual !== req.expectedProvider) {
      throw new LlmRouteAssertionError(
        `assertLlmRoute: expected provider ${req.expectedProvider} but baseUrl ${baseUrl} resolves to ${actual}.`,
        'wrong_provider',
        baseUrl,
      )
    }
  }
}

function matchUrl(url: string, pattern: string | RegExp): boolean {
  if (pattern instanceof RegExp) return pattern.test(url)
  return url.toLowerCase().startsWith(pattern.toLowerCase())
}

function describePattern(p: string | RegExp): string {
  return p instanceof RegExp ? p.source : p
}

/**
 * Probe whether a model is reachable. Returns latency + null error on
 * success; `ok=false` + error message on any failure (HTTP, timeout,
 * network, parse). Designed for sweep preflights — fail loud at the
 * boundary before burning a 30-leaf run on a misconfigured router.
 *
 * Sends a tiny `ping` message with `maxTokens=64`. Reasoning models
 * (glm-5.1, deepseek-v4) can burn the entire budget on internal reasoning
 * for short prompts, so don't tighten this further. We don't validate
 * content; HTTP 200 means reachable.
 */
export async function probeLlm(
  model: string,
  opts: LlmClientOptions & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const start = Date.now()
  try {
    await callLlm(
      {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 64,
        timeoutMs: opts.timeoutMs ?? 30_000,
      },
      opts,
    )
    return { ok: true, latencyMs: Date.now() - start, error: null }
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Stateful client — construct once with defaults, call many times.
 * Thin wrapper around the free functions; exists for callers that want
 * to inject a single configured instance into multiple primitives.
 */
export class LlmClient {
  constructor(private readonly opts: LlmClientOptions = {}) {}

  call(req: LlmCallRequest, per?: LlmClientOptions): Promise<LlmCallResult> {
    return callLlm(req, { ...this.opts, ...per })
  }

  callJson<T = unknown>(
    req: LlmCallRequest,
    per?: LlmClientOptions,
  ): Promise<{ value: T; result: LlmCallResult }> {
    return callLlmJson<T>(req, { ...this.opts, ...per })
  }
}
