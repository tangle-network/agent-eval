/**
 * The continuation's model call: one chat completion on router.tangle.tools,
 * with the served id, the token usage and a priced cost recorded per call.
 *
 * Two rules keep a partial measurement from reading as a complete one:
 *
 *   - a response that reports no usage returns `usage: null`, so the rollout's
 *     `captured` flag clears rather than being filled with zeros
 *   - a model with no local price returns `costUsd: null`, which makes the
 *     whole rollout's cost `uncaptured` rather than a sum that is too small
 *
 * The router's published per-token rates are the price source. They are read
 * once from `/v1/models` at start-up rather than hard-coded, so a rate change
 * cannot silently misprice a run.
 */

import type { RunTokenUsage } from '../src/run-record'
import type {
  ContinuationModel,
  ContinuationModelRequest,
  ContinuationModelResponse,
} from '../src/trace-repair'

const ROUTER = process.env.TBR_FL_ROUTER ?? 'https://router.tangle.tools/v1'
const REQUEST_TIMEOUT_MS = Number(process.env.TBR_FL_TIMEOUT_MS ?? '180000')
const MAX_ATTEMPTS = Number(process.env.TBR_FL_ATTEMPTS ?? '4')

export interface ModelPricing {
  /** USD per prompt token. */
  prompt: number
  /** USD per completion token, reasoning tokens included. */
  completion: number
}

interface RouterUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
}

interface RouterChoice {
  message?: { content?: string | null }
  finish_reason?: string | null
}

interface RouterResponse {
  model?: string
  choices?: RouterChoice[]
  usage?: RouterUsage
  error?: { message?: string; code?: string }
}

const pricingCache = new Map<string, ModelPricing>()

/**
 * Whether the served id is the model the policy asked for.
 *
 * The router lists ids both bare and vendor-prefixed (`glm-5.2` and
 * `z-ai/glm-5.2`) and answers with one form or the other, so the comparison is
 * on the final path segment. It is not a fuzzy match: `deepseek-v4-flash` does
 * not satisfy a request for `deepseek-v3.2` under this rule.
 */
export function servedMatches(requested: string, served: string): boolean {
  const tail = (id: string): string => id.split('/').pop()!.toLowerCase()
  return tail(requested) === tail(served)
}

function apiKey(): string {
  const key = process.env.TANGLE_API_KEY
  if (!key) throw new Error('TANGLE_API_KEY is required for the continuation model')
  return key
}

/** Per-token rates the router publishes for `model`. Throws when it publishes none. */
export async function fetchPricing(model: string): Promise<ModelPricing> {
  const cached = pricingCache.get(model)
  if (cached) return cached
  const response = await fetch(`${ROUTER}/models`, {
    headers: { authorization: `Bearer ${apiKey()}` },
  })
  if (!response.ok) throw new Error(`router model list failed: HTTP ${response.status}`)
  const body = (await response.json()) as {
    data: { id: string; pricing?: { prompt?: string; completion?: string } }[]
  }
  for (const entry of body.data) {
    const prompt = Number(entry.pricing?.prompt)
    const completion = Number(entry.pricing?.completion)
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      pricingCache.set(entry.id, { prompt, completion })
    }
  }
  const found = pricingCache.get(model)
  if (!found) throw new Error(`router publishes no per-token price for ${model}`)
  return found
}

function toRunTokenUsage(usage: RouterUsage | undefined): RunTokenUsage | null {
  if (!usage) return null
  const input = usage.prompt_tokens
  const output = usage.completion_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return null
  const record: RunTokenUsage = { input, output }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number') record.reasoning = reasoning
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number') record.cached = cached
  return record
}

/**
 * Retries on transport failure and on the router's own 5xx, which it returns
 * for transient upstream capacity. A request that never succeeds throws, and
 * `runContinuation` records the rollout as `model-error` with the message.
 */
async function post(request: ContinuationModelRequest): Promise<RouterResponse> {
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${ROUTER}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          seed: request.seed,
        }),
      })
      const text = await response.text()
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`
        if (response.status >= 500 || response.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 5_000))
          continue
        }
        throw new Error(lastError)
      }
      return JSON.parse(text) as RouterResponse
    } catch (error) {
      lastError = (error as Error).message
      if (attempt === MAX_ATTEMPTS) break
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`router call failed after ${MAX_ATTEMPTS} attempts: ${lastError}`)
}

/** The router answered with a different model than the policy pinned. */
export class ModelSubstitutionError extends Error {}

export function routerContinuationModel(label = ''): ContinuationModel {
  return async (request: ContinuationModelRequest): Promise<ContinuationModelResponse> => {
    const startedMs = Date.now()
    const body = await post(request)
    if (body.error) throw new Error(`router error: ${body.error.code}: ${body.error.message}`)
    const choice = body.choices?.[0]
    const content = choice?.message?.content
    if (typeof content !== 'string') {
      throw new Error(`router returned no message content for ${request.model}`)
    }
    const served = body.model
    if (typeof served !== 'string' || served.length === 0) {
      throw new Error('router returned no served model id; provenance cannot be recorded')
    }
    // The router can answer a request for one model with another. Measured:
    // `deepseek/deepseek-v3.2` was served by `deepseek-v4-flash`. A pinned
    // policy that silently ran a substitute would name the wrong model in every
    // number it produced, so a substitution stops the rollout.
    if (!servedMatches(request.model, served)) {
      throw new ModelSubstitutionError(
        `policy pinned ${request.model}, router served ${served}`,
      )
    }
    // Priced on what was served, never on what was asked for.
    const pricing = await fetchPricing(served)
    const usage = toRunTokenUsage(body.usage)
    // One line per call, so a run that takes hours shows where it is rather
    // than going dark between rollouts.
    process.stderr.write(
      `${new Date().toISOString()} call${label ? ` ${label}` : ''} served=${served} ` +
        `${Date.now() - startedMs}ms in=${usage?.input ?? 'null'} out=${usage?.output ?? 'null'} ` +
        `finish=${choice?.finish_reason ?? 'null'}\n`,
    )
    return {
      content,
      servedModel: served,
      usage,
      costUsd:
        usage === null ? null : usage.input * pricing.prompt + usage.output * pricing.completion,
      finishReason: choice?.finish_reason ?? null,
    }
  }
}
