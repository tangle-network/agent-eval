import type { LlmClientOptions } from './llm-client'

export interface CliLlmConfig {
  client?: LlmClientOptions
  model?: string
}

export function resolveCliLlmConfig(env: NodeJS.ProcessEnv = process.env): CliLlmConfig {
  const explicitBaseUrl = nonEmpty(env.AGENT_EVAL_LLM_BASE_URL)
  const explicitApiKey = nonEmpty(env.AGENT_EVAL_LLM_API_KEY)
  const openAiApiKey = nonEmpty(env.OPENAI_API_KEY)
  const tangleApiKey = nonEmpty(env.TANGLE_API_KEY)
  const baseUrl =
    explicitBaseUrl ??
    nonEmpty(env.OPENAI_BASE_URL) ??
    nonEmpty(env.TANGLE_ROUTER_URL) ??
    (openAiApiKey ? 'https://api.openai.com/v1' : undefined) ??
    (tangleApiKey ? 'https://router.tangle.tools/v1' : undefined)
  const apiKey = explicitApiKey ?? openAiApiKey ?? tangleApiKey
  const model =
    nonEmpty(env.AGENT_EVAL_LLM_MODEL) ?? nonEmpty(env.OPENAI_MODEL) ?? nonEmpty(env.TANGLE_MODEL)

  const client =
    baseUrl || apiKey
      ? { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) }
      : undefined
  return { ...(client ? { client } : {}), ...(model ? { model } : {}) }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
