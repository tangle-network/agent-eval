/**
 * Provider configuration for the `agent-eval` binary.
 *
 * This is the ONE place in the package that turns an environment credential
 * into a model transport, and it exists only inside the binary. The `agent-eval`
 * server is a deployed process whose caller is a JSON-RPC or HTTP client in
 * another language, so it cannot be handed a `ChatClient`; it reads its own
 * credential the way every server does. The library never does: a TypeScript
 * consumer binds its own transport and agent-eval holds no provider key.
 */

import { type ChatClient, createChatClient } from './analyst/chat-client'

export interface CliLlmConfig {
  /** Judge transport for the wire handlers. Absent when no provider is configured. */
  chat?: ChatClient
  model?: string
}

/** The endpoint the binary resolved from its environment. */
export interface CliProviderRoute {
  baseUrl: string
  apiKey: string
  model?: string
}

/**
 * Environment precedence for the binary's provider route, with no client built.
 *
 * Both halves are required: a base URL without a key, or a key without an
 * endpoint, is a half-configured server. `/v1/judge` then refuses with
 * `llm_not_configured` instead of calling an unintended endpoint.
 */
export function resolveCliProviderRoute(
  env: NodeJS.ProcessEnv = process.env,
): CliProviderRoute | undefined {
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

  if (!baseUrl || !apiKey) return undefined
  return { baseUrl, apiKey, ...(model ? { model } : {}) }
}

export function resolveCliLlmConfig(env: NodeJS.ProcessEnv = process.env): CliLlmConfig {
  const route = resolveCliProviderRoute(env)
  if (!route) return {}
  return {
    chat: cliChatClient({ baseUrl: route.baseUrl, apiKey: route.apiKey }, route.model),
    ...(route.model ? { model: route.model } : {}),
  }
}

/**
 * The binary's transport IS the published one — `createChatClient({ transport:
 * 'openai-compatible' })` — so the server and a library consumer cannot drift
 * onto two different clients for the same endpoint.
 *
 * The one thing kept local is the error text. A generic "no model on the
 * request" tells a server operator nothing; this names the variable to set.
 */
function cliChatClient(
  route: { baseUrl: string; apiKey: string },
  defaultModel: string | undefined,
): ChatClient {
  const client = createChatClient({
    transport: 'openai-compatible',
    baseUrl: route.baseUrl,
    apiKey: route.apiKey,
    ...(defaultModel ? { defaultModel } : {}),
  })
  return {
    ...client,
    chat: (req, callOpts) => {
      if (!req.model && !defaultModel) {
        throw new Error(
          'agent-eval: no model on the request and no AGENT_EVAL_LLM_MODEL configured',
        )
      }
      return client.chat(req, callOpts)
    },
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
