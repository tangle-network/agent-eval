import { combineAbortSignals } from '../abort-signal'
import { costForTokenPricing } from '../cost-ledger'
import { assertServedModel as assertServedModelIdentity } from '../integrity/served-model'
import { newRecordId } from '../record-id'
import {
  defaultProviderRedactor,
  type ProviderRedactor,
  providerFromBaseUrl,
  type RawProviderEvent,
  type RawProviderSink,
} from '../trace/raw-provider-sink'
import { providerReportedCost } from './accounting'
import type { LlmCallRequest, LlmCallResult, LlmClientOptions } from './contract'
import { LlmCallError } from './errors'
import {
  backoffMs,
  DEFAULT_TIMEOUT_MS,
  deadlineExceeded,
  isTransientLlmError,
  pacingStateFor,
  parseRetryAfter,
  RETRYABLE_STATUS,
  resolveMaximumAttempts,
  resolveMinIntervalMs,
  sleep,
} from './resilience'
import {
  buildBody,
  buildHeaders,
  isSchemaRejection,
  isTemperatureOneRejection,
  parseWireLogprobs,
  parseWireToolCalls,
  providerTokenCount,
} from './wire'

/**
 * Low-level call. Returns raw content + usage + cost. Retries on transient
 * failures; does NOT degrade schema here — callers that want graceful
 * degrade use `callLlmJson`.
 */
export async function callLlm(
  req: LlmCallRequest,
  opts: LlmClientOptions = {},
): Promise<LlmCallResult> {
  return callLlmAttempts(req, opts, false)
}

/** One retry owner for raw and structured calls. Fallback changes the next
 * request, not the attempt allowance, deadline origin, or raw-event sequence. */
/** What one call shares across its attempts: the resolved options, pacing, deadline and the request as it now stands. */
interface AttemptRun {
  readonly req: LlmCallRequest
  readonly opts: LlmClientOptions
  readonly allowSchemaFallback: boolean
  readonly baseUrl: string
  readonly url: string
  readonly timeoutMs: number
  readonly maximumAttempts: number
  readonly minIntervalMs: number
  readonly pacing: ReturnType<typeof pacingStateFor>
  readonly headers: ReturnType<typeof buildHeaders>
  readonly provider: string
  readonly deadlineStart: number
  readonly remainingMs: () => number
  readonly retryDelay: (ms: number) => Promise<void>
  effectiveRequest: LlmCallRequest
  lastErr: unknown
}

/** How one attempt ended without a result or a thrown error. */
type AttemptOutcome =
  | { kind: 'result'; result: LlmCallResult }
  | { kind: 'retry' }
  | { kind: 'exhausted' }

/** Which of an attempt's raw events were already written, so the failure path records at most one error. */
interface AttemptState {
  dispatched: boolean
  errorRecorded: boolean
}

const ENDPOINT = '/chat/completions'

function startAttemptRun(
  req: LlmCallRequest,
  opts: LlmClientOptions,
  allowSchemaFallback: boolean,
): AttemptRun {
  // No default endpoint. This client is internal to the `agent-eval` binary
  // and the loopback optimizer proxy; both name their endpoint explicitly, and
  // a fallback would let a misconfigured caller bill an unintended provider.
  if (!opts.baseUrl) throw new Error('callLlm: opts.baseUrl is required')
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const deadlineMs = opts.deadlineMs
  const deadlineStart = Date.now()
  const remainingMs = () =>
    deadlineMs === undefined ? Infinity : Math.max(0, deadlineMs - (Date.now() - deadlineStart))
  const run: AttemptRun = {
    req,
    opts,
    allowSchemaFallback,
    baseUrl,
    url: `${baseUrl}${ENDPOINT}`,
    timeoutMs: req.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maximumAttempts: resolveMaximumAttempts(opts.maximumAttempts),
    minIntervalMs: resolveMinIntervalMs(opts.minIntervalMs),
    pacing: pacingStateFor(opts),
    headers: buildHeaders(opts),
    provider: opts.provider ?? providerFromBaseUrl(baseUrl),
    deadlineStart,
    remainingMs,
    retryDelay: (ms) => sleep(Math.min(ms, remainingMs()), opts.signal),
    effectiveRequest: req,
    lastErr: undefined,
  }
  if (opts.customTokenPricing) {
    costForTokenPricing(opts.customTokenPricing, { inputTokens: 0, outputTokens: 0 })
  }
  return run
}

function deadlineError(run: AttemptRun): Error | DOMException {
  return run.lastErr instanceof Error
    ? run.lastErr
    : new DOMException('callLlm deadline exceeded', 'TimeoutError')
}

/** Write one raw provider event for this attempt. Does nothing without a sink. */
async function recordAttemptEvent(
  run: AttemptRun,
  attempt: number,
  fields: Pick<RawProviderEvent, 'direction' | 'timestamp'> & Partial<RawProviderEvent>,
): Promise<void> {
  const { opts } = run
  if (!opts.rawSink) return
  await recordRaw(opts.rawSink, opts.redactor ?? defaultProviderRedactor, {
    eventId: newRecordId(),
    runId: opts.traceContext?.runId,
    spanId: opts.traceContext?.spanId,
    provider: run.provider,
    model: run.req.model,
    endpoint: ENDPOINT,
    baseUrl: run.baseUrl,
    attemptIndex: attempt,
    ...fields,
    redactedFields: [],
  })
}

/** Wait for this client's pacing slot. Every wake rechecks, so concurrent waiters cannot dispatch a catch-up burst. */
async function awaitPacingSlot(run: AttemptRun): Promise<void> {
  const { opts, pacing, minIntervalMs } = run
  while (true) {
    opts.signal?.throwIfAborted()
    if (deadlineExceeded(run.deadlineStart, opts.deadlineMs)) throw deadlineError(run)
    const waitMs =
      pacing.lastStartedAt === undefined ? 0 : pacing.lastStartedAt + minIntervalMs - Date.now()
    if (waitMs <= 0) return
    await run.retryDelay(waitMs)
  }
}

/** Answer a non-2xx response: retry with an adjusted request or after a wait, give up, or throw its error. */
async function handleHttpFailure(
  run: AttemptRun,
  attempt: number,
  res: Response,
  body: string,
  responseHeaders: Record<string, string> | undefined,
  started: number,
  state: AttemptState,
): Promise<AttemptOutcome> {
  const { req, opts, maximumAttempts, deadlineStart } = run
  await recordAttemptEvent(run, attempt, {
    direction: 'error',
    timestamp: Date.now(),
    durationMs: Date.now() - started,
    statusCode: res.status,
    responseHeaders,
    responseBody: body,
    errorMessage: `HTTP ${res.status}`,
  })
  if (opts.rawSink) state.errorRecorded = true
  const err = new LlmCallError(
    `LLM call failed with HTTP ${res.status}`,
    res.status,
    body,
    req.model,
  )
  const canRetry =
    attempt < maximumAttempts - 1 && !deadlineExceeded(deadlineStart, opts.deadlineMs)
  if (
    isTemperatureOneRejection(res.status, body) &&
    run.effectiveRequest.temperature !== 1 &&
    canRetry
  ) {
    run.lastErr = err
    run.effectiveRequest = { ...run.effectiveRequest, temperature: 1 }
    return { kind: 'retry' }
  }
  if (
    run.allowSchemaFallback &&
    opts.jsonSchemaTransport !== 'json-object' &&
    run.effectiveRequest.jsonSchema &&
    isSchemaRejection(res.status, body) &&
    canRetry
  ) {
    run.lastErr = err
    run.effectiveRequest = { ...run.effectiveRequest, jsonMode: true, jsonSchema: undefined }
    return { kind: 'retry' }
  }
  if (RETRYABLE_STATUS.has(res.status) && canRetry) {
    run.lastErr = err
    const wait = parseRetryAfter(res.headers) ?? backoffMs(attempt)
    // A wait the deadline cannot cover ends the call with this answer. Sleeping to the
    // deadline let a timer that fired a millisecond early start one more attempt with no time
    // left, whose abort replaced the server's status (agent-eval publish run 37238259408).
    if (wait >= run.remainingMs()) {
      // A caller abort that landed while the answer was recorded still wins, as the
      // retry wait would have reported it.
      opts.signal?.throwIfAborted()
      return { kind: 'exhausted' }
    }
    await run.retryDelay(wait)
    return { kind: 'retry' }
  }
  throw err
}

/** Turn a parsed completion into the call result: content, tool calls, usage with its completeness, and cost. */
function parseCompletion(
  run: AttemptRun,
  json: Record<string, unknown>,
  started: number,
): LlmCallResult {
  const { req, opts } = run
  const choice = (
    json.choices as
      | Array<{
          message?: { content?: string | null; tool_calls?: unknown }
          finish_reason?: string | null
          logprobs?: { content?: unknown } | null
        }>
      | undefined
  )?.[0]
  const toolCalls = parseWireToolCalls(choice?.message?.tool_calls, req.model)
  const usageRaw =
    json.usage && typeof json.usage === 'object' && !Array.isArray(json.usage)
      ? (json.usage as Record<string, unknown>)
      : undefined
  const promptTokens = providerTokenCount(usageRaw?.prompt_tokens)
  const completionTokens = providerTokenCount(usageRaw?.completion_tokens)
  const totalTokens = providerTokenCount(usageRaw?.total_tokens)
  const completionDetails =
    usageRaw?.completion_tokens_details &&
    typeof usageRaw.completion_tokens_details === 'object' &&
    !Array.isArray(usageRaw.completion_tokens_details)
      ? (usageRaw.completion_tokens_details as Record<string, unknown>)
      : undefined
  const reasoningRaw = completionDetails?.reasoning_tokens
  const reasoningTokens = reasoningRaw === undefined ? undefined : providerTokenCount(reasoningRaw)
  const cachedRaw =
    usageRaw?.prompt_tokens_details &&
    typeof usageRaw.prompt_tokens_details === 'object' &&
    !Array.isArray(usageRaw.prompt_tokens_details)
      ? (usageRaw.prompt_tokens_details as Record<string, unknown>).cached_tokens
      : undefined
  const cachedPromptTokens = cachedRaw === undefined ? undefined : providerTokenCount(cachedRaw)
  const usageCaptured =
    promptTokens !== undefined &&
    completionTokens !== undefined &&
    (reasoningRaw === undefined ||
      (reasoningTokens !== undefined && reasoningTokens <= completionTokens)) &&
    (cachedRaw === undefined ||
      (cachedPromptTokens !== undefined && cachedPromptTokens <= promptTokens)) &&
    (totalTokens === undefined || totalTokens === promptTokens + completionTokens)
  const costFromProxy = providerReportedCost(json)
  const content = choice?.message?.content ?? ''

  const configuredCost =
    typeof costFromProxy !== 'number' && usageCaptured && opts.customTokenPricing
      ? costForTokenPricing(opts.customTokenPricing, {
          inputTokens: promptTokens! - (cachedPromptTokens ?? 0),
          ...(cachedPromptTokens ? { cachedTokens: cachedPromptTokens } : {}),
          outputTokens: completionTokens!,
        })
      : undefined

  // The echoed id, kept separate from the attribution id: a provider that
  // omits it must read as "unproven", never as "the model I asked for".
  const servedModel = typeof json.model === 'string' && json.model.trim() !== '' ? json.model : null
  if (opts.assertServedModel) {
    assertServedModelIdentity(
      req.model,
      servedModel,
      opts.assertServedModel === true ? {} : opts.assertServedModel,
    )
  }

  return {
    content,
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(req.logprobs === undefined
      ? {}
      : { logprobs: parseWireLogprobs(choice?.logprobs?.content, req.model) }),
    finishReason: choice?.finish_reason ?? null,
    contentEmpty: content.trim().length === 0,
    usage: {
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
      captured: usageCaptured,
      reasoningTokens,
      cachedPromptTokens,
    },
    costUsd: typeof costFromProxy === 'number' ? costFromProxy : (configuredCost ?? null),
    model: servedModel ?? req.model,
    servedModel,
    durationMs: Date.now() - started,
    raw: json,
  }
}

/** One attempt: pace, dispatch, read the answer. A failure either becomes a retry outcome or is thrown. */
async function runAttempt(run: AttemptRun, attempt: number): Promise<AttemptOutcome> {
  const { opts } = run
  const callerSignal = opts.signal
  // A caller cancel is fatal — never retried. Checking before each attempt
  // means an already-aborted signal short-circuits without firing fetch.
  if (callerSignal?.aborted) {
    throw new DOMException('callLlm aborted by caller signal', 'AbortError')
  }
  // Stop retrying once the cross-attempt budget is spent rather than burning
  // a full per-attempt timeout on each remaining retry.
  if (deadlineExceeded(run.deadlineStart, opts.deadlineMs)) throw deadlineError(run)
  const requestBody = buildBody(
    run.effectiveRequest,
    opts.jsonSchemaTransport === 'json-object',
    opts.thinking,
  )
  const controller = new AbortController()
  const attemptSignal = combineAbortSignals(controller.signal, callerSignal)!
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let started = Date.now()
  // An attempt cancelled or timed out while queued never reached the
  // provider, so it leaves no request or error event in the raw log.
  const state: AttemptState = { dispatched: false, errorRecorded: false }
  try {
    if (run.minIntervalMs > 0) {
      await awaitPacingSlot(run)
      // Queue time consumes the operation deadline, not the HTTP timeout.
      started = Date.now()
    }
    // Claim the slot before any await so a concurrent waiter cannot take it.
    run.pacing.lastStartedAt = started
    state.dispatched = true
    timeoutHandle = setTimeout(() => controller.abort(), Math.min(run.timeoutMs, run.remainingMs()))
    await recordAttemptEvent(run, attempt, {
      direction: 'request',
      timestamp: started,
      requestHeaders: run.headers,
      requestBody,
    })
    attemptSignal.throwIfAborted()
    const res = await (opts.fetch ?? globalThis.fetch)(run.url, {
      method: 'POST',
      headers: run.headers,
      body: JSON.stringify(requestBody),
      signal: attemptSignal,
    })
    const responseHeaders = opts.rawSink ? headersToObject(res.headers) : undefined
    // Headers are not completion: the same timeout/cancellation covers either response body.
    const text = await res.text()
    attemptSignal.throwIfAborted()
    clearTimeout(timeoutHandle)

    if (!res.ok) {
      return await handleHttpFailure(run, attempt, res, text, responseHeaders, started, state)
    }

    let json: Record<string, unknown>
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch (parseErr) {
      await recordAttemptEvent(run, attempt, {
        direction: 'error',
        timestamp: Date.now(),
        durationMs: Date.now() - started,
        statusCode: res.status,
        responseHeaders,
        responseBody: text,
        errorMessage: `non-JSON response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      })
      if (opts.rawSink) state.errorRecorded = true
      throw parseErr
    }
    await recordAttemptEvent(run, attempt, {
      direction: 'response',
      timestamp: Date.now(),
      durationMs: Date.now() - started,
      statusCode: res.status,
      responseHeaders,
      responseBody: json,
    })
    return { kind: 'result', result: parseCompletion(run, json, started) }
  } catch (err) {
    clearTimeout(timeoutHandle)
    run.lastErr = err
    // Record only if neither the !res.ok branch nor the JSON.parse catch
    // already produced an error event for this attempt. Covers network
    // failures, timeouts, and aborts.
    if (state.dispatched && !state.errorRecorded) {
      await recordAttemptEvent(run, attempt, {
        direction: 'error',
        timestamp: Date.now(),
        durationMs: Date.now() - started,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
    // A caller cancel is fatal even though an AbortError matches the
    // transient patterns — a cancelled call must surface immediately, not
    // be retried against the same dead intent.
    if (callerSignal?.aborted) throw err
    const wait = backoffMs(attempt)
    if (
      attempt < run.maximumAttempts - 1 &&
      isTransientLlmError(err) &&
      !deadlineExceeded(run.deadlineStart, opts.deadlineMs) &&
      wait < run.remainingMs()
    ) {
      await run.retryDelay(wait)
      return { kind: 'retry' }
    }
    callerSignal?.throwIfAborted()
    throw err
  } finally {
    clearTimeout(timeoutHandle)
  }
}

async function callLlmAttempts(
  req: LlmCallRequest,
  opts: LlmClientOptions,
  allowSchemaFallback: boolean,
): Promise<LlmCallResult> {
  const run = startAttemptRun(req, opts, allowSchemaFallback)
  for (let attempt = 0; attempt < run.maximumAttempts; attempt++) {
    const outcome = await runAttempt(run, attempt)
    if (outcome.kind === 'result') return outcome.result
    if (outcome.kind === 'exhausted') break
  }
  throw run.lastErr instanceof Error ? run.lastErr : new Error(String(run.lastErr))
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

/** Shared schema-to-JSON-mode fallback that preserves the raw result. */
export async function callLlmStructured(
  req: LlmCallRequest,
  opts: LlmClientOptions = {},
): Promise<LlmCallResult> {
  return callLlmAttempts({ ...req, jsonMode: req.jsonMode ?? !req.jsonSchema }, opts, true)
}
