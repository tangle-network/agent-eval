// Router fetch helper — single source of truth for OpenAI-compat calls
// against the Tangle router. Used by the driver, agent, judges, and the
// default tool executors.

import type { MultishotToolDefinition } from './types'

export interface RouterCompletionRequest {
  apiKey: string
  baseUrl: string
  model: string
  messages: Array<Record<string, unknown>>
  tools?: MultishotToolDefinition[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface RouterToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface RouterCompletionResponse {
  message: { content?: string | null; tool_calls?: RouterToolCall[] }
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function routerCompletion(
  req: RouterCompletionRequest,
): Promise<RouterCompletionResponse> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? 2000,
  }
  if (req.tools?.length) body.tools = req.tools
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`router ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content?: string | null; tool_calls?: RouterToolCall[] } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const choice = json.choices[0]
  if (!choice) throw new Error(`router returned no choices: ${JSON.stringify(json).slice(0, 200)}`)
  return { message: choice.message, usage: json.usage }
}

// Rough per-model cost estimator. Used for cost-ceiling enforcement.
// Underestimates Anthropic, overestimates oss models — fine for ceilings.
export function estimateRouterCost(
  model: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number },
): number {
  if (!usage) return 0
  const inputTok = usage.prompt_tokens ?? 0
  const outputTok = usage.completion_tokens ?? 0
  let inPer1k = 0.003
  let outPer1k = 0.015
  if (model.includes('gpt-4o-mini')) {
    inPer1k = 0.00015
    outPer1k = 0.0006
  } else if (model.includes('gpt-5.4') || model.includes('claude-sonnet')) {
    inPer1k = 0.003
    outPer1k = 0.015
  } else if (model.includes('kimi') || model.includes('glm') || model.includes('deepseek')) {
    inPer1k = 0.0005
    outPer1k = 0.002
  }
  return (inputTok * inPer1k + outputTok * outPer1k) / 1000
}

export function defaultRouterBaseUrl(): string {
  return (process.env.TANGLE_ROUTER_BASE_URL ?? 'https://router.tangle.tools/v1').replace(
    /\/+$/,
    '',
  )
}

export function requireRouterApiKey(): string {
  const key = process.env.TANGLE_API_KEY
  if (!key) throw new Error('multishot requires TANGLE_API_KEY (router-scoped sk-tan-* key)')
  return key
}
