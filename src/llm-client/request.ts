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
async function callLlmAttempts(
  req: LlmCallRequest,
  opts: LlmClientOptions,
  allowSchemaFallback: boolean,
): Promise<LlmCallResult> {
  // No default endpoint. This client is internal to the `agent-eval` binary
  // and the loopback optimizer proxy; both name their endpoint explicitly, and
  // a fallback would let a misconfigured caller bill an unintended provider.
  if (!opts.baseUrl) throw new Error('callLlm: opts.baseUrl is required')
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`
  const endpoint = '/chat/completions'
  const timeoutMs = req.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maximumAttempts = resolveMaximumAttempts(opts.maximumAttempts)
  const minIntervalMs = resolveMinIntervalMs(opts.minIntervalMs)
  const pacing = pacingStateFor(opts)
  const fetchFn = opts.fetch ?? globalThis.fetch
  const headers = buildHeaders(opts)
  const provider = opts.provider ?? providerFromBaseUrl(baseUrl)
  const sink = opts.rawSink
  const redactor = opts.redactor ?? defaultProviderRedactor
  const traceContext = opts.traceContext
  const callerSignal = opts.signal
  const deadlineMs = opts.deadlineMs
  const deadlineStart = Date.now()
  if (opts.customTokenPricing) {
    costForTokenPricing(opts.customTokenPricing, { inputTokens: 0, outputTokens: 0 })
  }

  let lastErr: unknown
  let effectiveRequest = req
  const remainingMs = () =>
    deadlineMs === undefined ? Infinity : Math.max(0, deadlineMs - (Date.now() - deadlineStart))
  const retryDelay = (ms: number) => sleep(Math.min(ms, remainingMs()), callerSignal)
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    // A caller cancel is fatal — never retried. Checking before each attempt
    // means an already-aborted signal short-circuits without firing fetch.
    if (callerSignal?.aborted) {
      throw new DOMException('callLlm aborted by caller signal', 'AbortError')
    }
    // Stop retrying once the cross-attempt budget is spent rather than burning
    // a full per-attempt timeout on each remaining retry.
    if (deadlineExceeded(deadlineStart, deadlineMs)) {
      throw lastErr instanceof Error
        ? lastErr
        : new DOMException('callLlm deadline exceeded', 'TimeoutError')
    }
    const requestBody = buildBody(
      effectiveRequest,
      opts.jsonSchemaTransport === 'json-object',
      opts.thinking,
    )
    const controller = new AbortController()
    const attemptSignal = combineAbortSignals(controller.signal, callerSignal)!
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let started = Date.now()
    // An attempt cancelled or timed out while queued never reached the
    // provider, so it leaves no request or error event in the raw log.
    let dispatched = false
    let attemptErrorRecorded = false
    try {
      if (minIntervalMs > 0) {
        // Recheck after every wake: concurrent waiters must not dispatch a
        // catch-up burst.
        while (true) {
          callerSignal?.throwIfAborted()
          if (deadlineExceeded(deadlineStart, deadlineMs)) {
            throw lastErr instanceof Error
              ? lastErr
              : new DOMException('callLlm deadline exceeded', 'TimeoutError')
          }
          const waitMs =
            pacing.lastStartedAt === undefined
              ? 0
              : pacing.lastStartedAt + minIntervalMs - Date.now()
          if (waitMs <= 0) break
          await retryDelay(waitMs)
        }
        // Queue time consumes the operation deadline, not the HTTP timeout.
        started = Date.now()
      }
      // Claim the slot before any await so a concurrent waiter cannot take it.
      pacing.lastStartedAt = started
      dispatched = true
      timeoutHandle = setTimeout(() => controller.abort(), Math.min(timeoutMs, remainingMs()))
      if (sink) {
        await recordRaw(sink, redactor, {
          eventId: newRecordId(),
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
      attemptSignal.throwIfAborted()
      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: attemptSignal,
      })
      const responseHeaders = sink ? headersToObject(res.headers) : undefined
      // Headers are not completion: the same timeout/cancellation covers either response body.
      const text = await res.text()
      attemptSignal.throwIfAborted()
      clearTimeout(timeoutHandle)

      if (!res.ok) {
        const body = text
        if (sink) {
          await recordRaw(sink, redactor, {
            eventId: newRecordId(),
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
          `LLM call failed with HTTP ${res.status}`,
          res.status,
          body,
          req.model,
        )
        if (
          isTemperatureOneRejection(res.status, body) &&
          effectiveRequest.temperature !== 1 &&
          attempt < maximumAttempts - 1 &&
          !deadlineExceeded(deadlineStart, deadlineMs)
        ) {
          lastErr = err
          effectiveRequest = { ...effectiveRequest, temperature: 1 }
          continue
        }
        if (
          allowSchemaFallback &&
          opts.jsonSchemaTransport !== 'json-object' &&
          effectiveRequest.jsonSchema &&
          isSchemaRejection(res.status, body) &&
          attempt < maximumAttempts - 1 &&
          !deadlineExceeded(deadlineStart, deadlineMs)
        ) {
          lastErr = err
          effectiveRequest = { ...effectiveRequest, jsonMode: true, jsonSchema: undefined }
          continue
        }
        if (
          RETRYABLE_STATUS.has(res.status) &&
          attempt < maximumAttempts - 1 &&
          !deadlineExceeded(deadlineStart, deadlineMs)
        ) {
          lastErr = err
          const retryAfter = parseRetryAfter(res.headers)
          const wait = retryAfter ?? backoffMs(attempt)
          // A wait the deadline cannot cover ends the call with this answer. Sleeping to the
          // deadline let a timer that fired a millisecond early start one more attempt with no time
          // left, whose abort replaced the server's status (agent-eval publish run 37238259408).
          if (wait >= remainingMs()) {
            // A caller abort that landed while the answer was recorded still wins, as the
            // retry wait would have reported it.
            callerSignal?.throwIfAborted()
            break
          }
          await retryDelay(wait)
          continue
        }
        throw err
      }

      let json: Record<string, unknown>
      try {
        json = JSON.parse(text) as Record<string, unknown>
      } catch (parseErr) {
        if (sink) {
          await recordRaw(sink, redactor, {
            eventId: newRecordId(),
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
          eventId: newRecordId(),
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
      const reasoningTokens =
        reasoningRaw === undefined ? undefined : providerTokenCount(reasoningRaw)
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
      const servedModel =
        typeof json.model === 'string' && json.model.trim() !== '' ? json.model : null
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
    } catch (err) {
      clearTimeout(timeoutHandle)
      lastErr = err
      // A caller cancel is fatal even though an AbortError matches the
      // transient patterns — a cancelled call must surface immediately, not
      // be retried against the same dead intent.
      if (callerSignal?.aborted) {
        if (sink && dispatched && !attemptErrorRecorded) {
          await recordRaw(sink, redactor, {
            eventId: newRecordId(),
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
      if (sink && dispatched && !attemptErrorRecorded) {
        // Record only if neither the !res.ok branch nor the JSON.parse catch
        // already produced an error event for this attempt. Covers network
        // failures, timeouts, and aborts.
        await recordRaw(sink, redactor, {
          eventId: newRecordId(),
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
      const wait = backoffMs(attempt)
      if (
        attempt < maximumAttempts - 1 &&
        isTransientLlmError(err) &&
        !deadlineExceeded(deadlineStart, deadlineMs) &&
        wait < remainingMs()
      ) {
        await retryDelay(wait)
        continue
      }
      callerSignal?.throwIfAborted()
      throw err
    } finally {
      clearTimeout(timeoutHandle)
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

/** Shared schema-to-JSON-mode fallback that preserves the raw result. */
export async function callLlmStructured(
  req: LlmCallRequest,
  opts: LlmClientOptions = {},
): Promise<LlmCallResult> {
  return callLlmAttempts({ ...req, jsonMode: req.jsonMode ?? !req.jsonSchema }, opts, true)
}
