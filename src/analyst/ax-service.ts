import type { AxAIService } from '@ax-llm/ax'
import { ai } from '@ax-llm/ax'

const configuredModels = new WeakMap<object, string>()

export interface CreateAnalystAiConfig {
  /** OpenAI-compatible API key forwarded as `Authorization: Bearer`.
   *  cli-bridge ignores the value on loopback but Ax requires a non-empty string. */
  apiKey: string
  /** OpenAI-compatible base URL — e.g. `https://router.tangle.tools/v1` or a
   *  cli-bridge loopback. */
  baseUrl: string
  /** Model id forwarded to the analyst actor + responder. */
  model: string
  /** Ax provider name. Defaults to the OpenAI-compatible client. */
  provider?: 'openai' | 'anthropic'
}

/**
 * Construct the `AxAIService` an analyst kind calls through
 * (`createTraceAnalystKind({ ai })`).
 *
 * Ax's `ai()` pins `config.model` to the OpenAI catalog enum, but every
 * OpenAI-compatible router an analyst points at (router.tangle.tools,
 * cli-bridge) accepts arbitrary model ids (claude-code/sonnet, openai/gpt-5.4,
 * …). Consumers were each re-rolling `ai({ name, apiKey, apiURL, config })`
 * behind an `as (a: any) => any` cast to dodge the enum; this is the one
 * canonical constructor so they don't have to — and don't take a direct
 * `@ax-llm/ax` dependency for it.
 */
export function createAnalystAi(config: CreateAnalystAiConfig): AxAIService {
  const model = config.model.trim()
  if (!model) throw new TypeError('createAnalystAi: model must be a non-empty string')
  const service = ai({
    name: config.provider ?? 'openai',
    apiKey: config.apiKey,
    apiURL: config.baseUrl,
    config: { model },
  })
  configuredModels.set(service as object, model)
  return service
}

export function getConfiguredAnalystModel(service: AxAIService): string | undefined {
  return configuredModels.get(service as object)
}

/** Resolve the model before paid work so every request can be bounded and attributed. */
export function resolveAnalystModel(service: AxAIService, override?: string): string {
  if (override !== undefined) {
    const model = override.trim()
    if (!model) throw new TypeError('createTraceAnalystKind: model must be a non-empty string')
    return model
  }
  const model = getConfiguredAnalystModel(service)?.trim()
  if (!model) {
    throw new TypeError(
      'createTraceAnalystKind: model is required for Ax services not created by createAnalystAi()',
    )
  }
  return model
}
