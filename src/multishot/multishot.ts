// Multi-turn driver-agent simulation with inline tool execution.
//
// The driver = LLM acting as the persona (reactive, non-deterministic).
// The agent = the product agent under test (router call with profile's
// systemPrompt + the configured tools).
// Tool calls execute inline via the configured executors and feed back
// into the agent's message log so the agent integrates the result.

import type { AgentProfile } from '@tangle-network/agent-interface'
import { defaultDelegationTools } from './default-tools'
import {
  defaultRouterBaseUrl,
  estimateRouterCost,
  requireRouterApiKey,
  routerCompletion,
} from './router'
import {
  type MultishotArtifact,
  MultishotDriverEmptyError,
  type MultishotMessage,
  type MultishotPersona,
  type MultishotResult,
  type MultishotShape,
  type MultishotToolDefinition,
  type MultishotToolExecutor,
} from './types'

export interface RunMultishotOptions<TPersona extends MultishotPersona> {
  profile: AgentProfile
  persona: TPersona
  shape: MultishotShape<TPersona>
  /** Tool definitions advertised to the agent. Defaults to delegate_research + delegate_code. */
  tools?: MultishotToolDefinition[]
  /** Map from tool name → executor invoked inline when the agent emits a tool_call. */
  toolExecutors?: Record<string, MultishotToolExecutor>
  /** Map from tool name → artifact type label written into MultishotArtifact.type.
   *  Tools without a mapping still execute, but their results aren't surfaced as
   *  typed artifacts (only as tool messages in the transcript). */
  artifactTypeFor?: (toolName: string) => string | undefined
  maxTurns?: number
  agentModel?: string
  driverModel?: string
  apiKey?: string
  baseUrl?: string
  signal?: AbortSignal
}

export async function runMultishot<TPersona extends MultishotPersona>(
  opts: RunMultishotOptions<TPersona>,
): Promise<MultishotResult> {
  const apiKey = opts.apiKey ?? requireRouterApiKey()
  const baseUrl = opts.baseUrl ?? defaultRouterBaseUrl()
  const maxTurns = opts.maxTurns ?? 10
  const agentModel = opts.agentModel ?? 'openai/gpt-5.4'
  const driverModel = opts.driverModel ?? 'openai/gpt-4o-mini'

  const bundle =
    opts.tools && opts.toolExecutors
      ? {
          tools: opts.tools,
          executors: opts.toolExecutors,
          artifactTypeFor: opts.artifactTypeFor ?? (() => undefined),
        }
      : defaultDelegationTools()
  const tools = opts.tools ?? bundle.tools
  const executors = opts.toolExecutors ?? bundle.executors
  const artifactTypeFor = opts.artifactTypeFor ?? bundle.artifactTypeFor

  const start = Date.now()
  const transcript: MultishotMessage[] = []
  const artifacts: MultishotArtifact[] = []
  let toolCalls = 0
  let totalCostUsd = 0

  const opener = opts.shape.buildOpener(opts.persona)
  transcript.push({ role: 'user', content: opener })

  const systemPrompt = opts.profile.prompt?.systemPrompt ?? ''
  const agentMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: opener },
  ]

  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal?.aborted) throw new Error('multishot aborted')

    const { message: agentMsg, usage: agentUsage } = await routerCompletion({
      apiKey,
      baseUrl,
      model: agentModel,
      messages: agentMessages,
      tools,
      temperature: 0.7,
      maxTokens: 2500,
      signal: opts.signal,
    })
    totalCostUsd += estimateRouterCost(agentModel, agentUsage)

    const agentText = (agentMsg.content ?? '').trim()
    const agentToolCalls = (agentMsg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: (() => {
        try {
          return JSON.parse(tc.function.arguments) as Record<string, unknown>
        } catch {
          return {} as Record<string, unknown>
        }
      })(),
    }))

    agentMessages.push({
      role: 'assistant',
      content: agentText || null,
      ...(agentMsg.tool_calls?.length ? { tool_calls: agentMsg.tool_calls } : {}),
    })
    transcript.push({
      role: 'assistant',
      content: agentText,
      toolCalls: agentToolCalls.length > 0 ? agentToolCalls : undefined,
    })

    for (const tc of agentToolCalls) {
      toolCalls++
      let toolResult = ''
      try {
        const executor = executors[tc.name]
        if (!executor) {
          toolResult = JSON.stringify({ error: `unknown tool ${tc.name}` })
        } else {
          const r = await executor(tc.args, { apiKey, baseUrl, signal: opts.signal })
          toolResult = r.content
          totalCostUsd += r.costUsd
          const artifactType = artifactTypeFor(tc.name)
          if (artifactType) {
            artifacts.push({
              type: artifactType,
              turn,
              invocation: { name: tc.name, args: tc.args },
              content: toolResult,
            })
          }
        }
      } catch (err) {
        toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      }
      agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult || 'done' })
      transcript.push({ role: 'tool', content: toolResult || 'done', toolCallId: tc.id })
    }

    // If the agent emitted tool_calls, give it a follow-up turn to integrate the results.
    if (agentToolCalls.length > 0) {
      const followUp = await routerCompletion({
        apiKey,
        baseUrl,
        model: agentModel,
        messages: agentMessages,
        temperature: 0.7,
        maxTokens: 2000,
        signal: opts.signal,
      })
      totalCostUsd += estimateRouterCost(agentModel, followUp.usage)
      const followUpText = (followUp.message.content ?? '').trim()
      agentMessages.push({ role: 'assistant', content: followUpText })
      transcript.push({ role: 'assistant', content: followUpText })
    }

    if (turn < maxTurns - 1) {
      const driver = await driverTurn({
        apiKey,
        baseUrl,
        persona: opts.persona,
        shape: opts.shape,
        transcript,
        turn,
        model: driverModel,
        signal: opts.signal,
      })
      totalCostUsd += driver.costUsd
      agentMessages.push({ role: 'user', content: driver.content })
      transcript.push({ role: 'user', content: driver.content })
    }
  }

  return { transcript, artifacts, toolCalls, durationMs: Date.now() - start, costUsd: totalCostUsd }
}

async function driverTurn<TPersona extends MultishotPersona>(opts: {
  apiKey: string
  baseUrl: string
  persona: TPersona
  shape: MultishotShape<TPersona>
  transcript: MultishotMessage[]
  turn: number
  model: string
  signal?: AbortSignal
}): Promise<{ content: string; costUsd: number }> {
  const driverSystem = opts.shape.buildDriverSystemPrompt(opts.persona)

  // Translate transcript to driver POV: agent's `assistant` messages become
  // `user` (the agent talking TO the driver); the driver's prior `user`
  // messages become `assistant` (the driver's prior responses).
  const driverMessages: Array<Record<string, unknown>> = [{ role: 'system', content: driverSystem }]
  for (const msg of opts.transcript) {
    if (msg.role === 'tool') continue
    if (msg.role === 'assistant') driverMessages.push({ role: 'user', content: msg.content })
    else if (msg.role === 'user') driverMessages.push({ role: 'assistant', content: msg.content })
  }

  // Driver must never go silent. Retry once on empty content; then fail loud.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { message, usage } = await routerCompletion({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      messages: driverMessages,
      temperature: 0.9,
      maxTokens: 600,
      signal: opts.signal,
    })
    const content = (message.content ?? '').trim()
    if (content.length > 0) return { content, costUsd: estimateRouterCost(opts.model, usage) }
  }
  throw new MultishotDriverEmptyError(opts.turn)
}
