import type { AxAIService } from '@ax-llm/ax'
import { ai } from '@ax-llm/ax'

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
  return ai({
    name: config.provider ?? 'openai',
    apiKey: config.apiKey,
    apiURL: config.baseUrl,
    config: { model: config.model },
  })
}
