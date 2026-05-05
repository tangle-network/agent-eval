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
  /** Per-call timeout, default 60s. */
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
  /** Raw response body. */
  raw: Record<string, unknown>
}

export class LlmCallError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly model: string,
  ) {
    super(message)
    this.name = 'LlmCallError'
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
  /** Max retry attempts on retriable errors. Default 3 (1 initial + 2 retries). */
  maxRetries?: number
  /** Fetch implementation — defaults to global `fetch`. Override for custom transport (e.g. tests). */
  fetch?: typeof fetch
}

// ─── Internals ──────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://router.tangle.tools/v1'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RETRIES = 3

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

function isRetryableError(err: unknown): boolean {
  if (err instanceof LlmCallError) return RETRYABLE_STATUS.has(err.status)
  if (err instanceof Error) {
    return (
      err.name === 'AbortError' ||
      err.name === 'TimeoutError' ||
      /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err.message)
    )
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

function backoffMs(attempt: number): number {
  // 500ms, 1s, 2s, 4s, ...
  return Math.min(500 * Math.pow(2, attempt), 16_000)
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
  if (req.maxTokens != null) body.max_tokens = req.maxTokens

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  const starts = [...stripped.matchAll(/[\[{]/g)].map((match) => match.index).filter((index) => index != null)
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
  const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const fetchFn = opts.fetch ?? globalThis.fetch
  const headers = buildHeaders(opts)

  let lastErr: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()

    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildBody(req, false)),
        signal: controller.signal,
      })
      clearTimeout(timeoutHandle)

      if (!res.ok) {
        const body = await res.text()
        const err = new LlmCallError(
          `LLM call ${res.status}: ${body.slice(0, 300)}`,
          res.status,
          body,
          req.model,
        )
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries - 1) {
          lastErr = err
          const retryAfter = parseRetryAfter(res.headers)
          await sleep(retryAfter ?? backoffMs(attempt))
          continue
        }
        throw err
      }

      const json = (await res.json()) as Record<string, unknown>
      const choice = (json.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]
      const usageRaw = (json.usage as Record<string, unknown> | undefined) ?? {}
      const costFromProxy = (json._response_cost ?? json.cost_usd) as number | undefined

      return {
        content: choice?.message?.content ?? '',
        usage: {
          promptTokens: Number(usageRaw.prompt_tokens ?? 0),
          completionTokens: Number(usageRaw.completion_tokens ?? 0),
          totalTokens: Number(usageRaw.total_tokens ?? 0),
          cachedPromptTokens:
            usageRaw.prompt_tokens_details &&
            typeof usageRaw.prompt_tokens_details === 'object'
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
      if (attempt < maxRetries - 1 && isRetryableError(err)) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
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
