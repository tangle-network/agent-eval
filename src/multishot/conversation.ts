// The multishot conversation's two legs, separable from the loop that orders
// them.
//
// `runMultishot` orders the legs as a plain turn loop. A caller that orders
// them another way — a Runtime flow graph, a scheduler, a replay harness —
// drives the same legs through `runMultishotConversation`, so the transcript,
// artifacts, tool-call count, driver point of view and cost accounting stay
// this package's single implementation.
//
// agent-eval owns no model transport: every leg runs on a MultishotTransport
// the caller supplies, so no provider credential enters this package.

import { withCellSpend } from '../matrix'
import { estimateMultishotCost } from './cost'
import { defaultDelegationTools } from './default-tools'
import type { RunMultishotOptions } from './multishot'
import { defaultShapeFromProfile } from './shape-defaults'
import {
  type MultishotArtifact,
  MultishotDriverEmptyError,
  MultishotFatalToolError,
  type MultishotMessage,
  type MultishotPersona,
  type MultishotResult,
} from './types'

/** Prompt and completion tokens one leg reported. */
export interface MultishotLegTokens {
  input: number
  output: number
}

/** One conversation's state and legs. Each leg appends to the shared
 *  transcript; the caller decides the order in which legs run. */
export interface MultishotConversation {
  /** Agent turns the conversation is configured for (`opts.maxTurns ?? 10`). */
  readonly maxTurns: number
  /** The model the agent leg runs on. */
  readonly agentModel: string
  /** The primary simulated-user model. */
  readonly driverModel: string
  /** The persona's first message, already in the transcript. */
  readonly opener: string
  /** The simulated user's system prompt. */
  readonly driverSystemPrompt: string
  /** One agent turn: inference, inline tool execution and follow-up inference,
   *  until the agent answers without tools. Throws on abort, on a fatal tool
   *  error and on the per-turn tool dispatch cap. */
  agentTurn(turn: number): Promise<{ tokens: MultishotLegTokens }>
  /** The simulated user's reply to the transcript so far, appended for the
   *  next agent turn. Retries an empty reply once per model, rotates through
   *  the fallback models, then throws `MultishotDriverEmptyError`. */
  driverTurn(turn: number): Promise<{ content: string; tokens: MultishotLegTokens }>
}

/** Orders the legs of one conversation. Resolves when the conversation is done. */
export type MultishotConversationDriver = (conversation: MultishotConversation) => Promise<void>

interface ConversationMeter {
  costUsd: number
  startedAt: number
  /** True once a call contributed a fabricated `0` — no provider cost and no
   *  usage to price. `costUsd` is a subtotal from that point on. */
  uncaptured: boolean
}

/**
 * Run one multishot conversation whose leg order `drive` decides.
 *
 * Returns the conversation's `MultishotResult`. When any leg or `drive` throws,
 * the error is rethrown carrying the spend so far (`withCellSpend`), so a
 * matrix bills the failed cell for the turns it already paid for.
 */
export async function runMultishotConversation<TPersona extends MultishotPersona>(
  opts: RunMultishotOptions<TPersona>,
  drive: MultishotConversationDriver,
): Promise<MultishotResult> {
  const meter: ConversationMeter = { costUsd: 0, startedAt: Date.now(), uncaptured: false }
  try {
    const state = openConversation(opts, meter)
    await drive(state.conversation)
    return {
      transcript: state.transcript,
      artifacts: state.artifacts,
      toolCalls: state.toolCalls(),
      durationMs: Date.now() - meter.startedAt,
      costUsd: meter.costUsd,
      // A shot that priced every call reports a complete estimate. One that had
      // a call the router priced at nothing reports a subtotal, so the cell is
      // recorded as under-counted rather than as a complete estimate.
      costProvenance: meter.uncaptured
        ? { kind: 'uncaptured', usd: null }
        : { kind: 'estimated', usd: meter.costUsd },
    }
  } catch (err) {
    throw withCellSpend(err, {
      costUsd: meter.costUsd,
      durationMs: Date.now() - meter.startedAt,
      kind: meter.uncaptured ? 'uncaptured' : 'estimated',
    })
  }
}

function openConversation<TPersona extends MultishotPersona>(
  opts: RunMultishotOptions<TPersona>,
  meter: ConversationMeter,
): {
  conversation: MultishotConversation
  transcript: MultishotMessage[]
  artifacts: MultishotArtifact[]
  toolCalls: () => number
} {
  const maxTurns = opts.maxTurns ?? 10
  const maxToolDispatches = opts.maxToolDispatches ?? 4
  const agentModel = opts.agentModel ?? 'openai/gpt-5.4'
  const driverModel = opts.driverModel ?? 'openai/gpt-4o-mini'
  const driverModels = [driverModel, ...(opts.driverFallbackModels ?? [])]
  const agentMaxTokens = opts.agentMaxTokens ?? 2500
  const toolFollowupMaxTokens = opts.toolFollowupMaxTokens ?? 2000
  const driverMaxTokens = opts.driverMaxTokens ?? 600

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

  const agentTransport = opts.agentTransport
  const driverTransport = opts.driverTransport
  const toolTransport = opts.toolTransport ?? agentTransport

  const shape = defaultShapeFromProfile(opts.profile, opts.shape)

  const transcript: MultishotMessage[] = []
  const artifacts: MultishotArtifact[] = []
  let toolCalls = 0

  const opener = shape.buildOpener(opts.persona)
  transcript.push({ role: 'user', content: opener })

  const systemPrompt = [opts.profile.prompt?.systemPrompt, opts.profile.prompt?.appendSystemPrompt]
    .filter((value): value is string => Boolean(value))
    .join('\n\n')
  const agentMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: opener },
  ]
  const driverSystemPrompt = shape.buildDriverSystemPrompt(opts.persona)

  async function agentTurn(turn: number): Promise<{ tokens: MultishotLegTokens }> {
    if (opts.signal?.aborted) throw new Error('multishot aborted')
    const tokens = { input: 0, output: 0 }
    let dispatchesThisTurn = 0
    while (true) {
      const {
        message: agentMsg,
        usage: agentUsage,
        costUsd: agentCostUsd,
      } = await agentTransport({
        model: agentModel,
        messages: agentMessages,
        tools,
        temperature: 0.7,
        maxTokens: dispatchesThisTurn === 0 ? agentMaxTokens : toolFollowupMaxTokens,
        signal: opts.signal,
      })
      meter.costUsd += agentCostUsd ?? estimateMultishotCost(agentModel, agentUsage)
      if (agentCostUsd === undefined && agentUsage === undefined) meter.uncaptured = true
      tokens.input += agentUsage?.prompt_tokens ?? 0
      tokens.output += agentUsage?.completion_tokens ?? 0

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

      if (agentToolCalls.length === 0) break
      dispatchesThisTurn += agentToolCalls.length
      if (dispatchesThisTurn > maxToolDispatches) {
        throw new Error(
          `multishot: tool dispatch cap exceeded (${dispatchesThisTurn}/${maxToolDispatches}) on turn ${turn}`,
        )
      }

      for (const tc of agentToolCalls) {
        toolCalls++
        let toolResult = ''
        try {
          const executor = executors[tc.name]
          if (!executor) {
            toolResult = JSON.stringify({ error: `unknown tool ${tc.name}` })
          } else {
            const r = await executor(tc.args, { transport: toolTransport, signal: opts.signal })
            toolResult = r.content
            meter.costUsd += r.costUsd
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
          if (err instanceof MultishotFatalToolError) throw err
          toolResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
        }
        agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult || 'done' })
        transcript.push({ role: 'tool', content: toolResult || 'done', toolCallId: tc.id })
      }
    }
    return { tokens }
  }

  // Every driver attempt is charged, including the empty ones that force a
  // retry and the ones that precede `MultishotDriverEmptyError`: those calls
  // billed the provider whether or not their content was usable.
  async function driverTurn(
    turn: number,
  ): Promise<{ content: string; tokens: MultishotLegTokens }> {
    // Driver point of view: the agent's `assistant` messages become `user`
    // (the agent talking TO the driver); the driver's prior `user` messages
    // become `assistant` (the driver's prior responses).
    const driverMessages: Array<Record<string, unknown>> = [
      { role: 'system', content: driverSystemPrompt },
    ]
    for (const msg of transcript) {
      if (msg.role === 'tool') continue
      const content = driverVisibleContent(msg)
      if (!content) continue
      if (msg.role === 'assistant') driverMessages.push({ role: 'user', content })
      else if (msg.role === 'user') driverMessages.push({ role: 'assistant', content })
    }

    // The driver must never go silent. Retry once on empty content; then fail loud.
    const tokens = { input: 0, output: 0 }
    for (const model of driverModels) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const { message, usage, costUsd } = await driverTransport({
          model,
          messages: driverMessages,
          temperature: 0.9,
          maxTokens: driverMaxTokens,
          signal: opts.signal,
        })
        meter.costUsd += costUsd ?? estimateMultishotCost(model, usage)
        if (costUsd === undefined && usage === undefined) meter.uncaptured = true
        tokens.input += usage?.prompt_tokens ?? 0
        tokens.output += usage?.completion_tokens ?? 0
        const content = (message.content ?? '').trim()
        if (content.length > 0) {
          agentMessages.push({ role: 'user', content })
          transcript.push({ role: 'user', content })
          return { content, tokens }
        }
      }
    }
    throw new MultishotDriverEmptyError(turn)
  }

  return {
    conversation: {
      maxTurns,
      agentModel,
      driverModel,
      opener,
      driverSystemPrompt,
      agentTurn,
      driverTurn,
    },
    transcript,
    artifacts,
    toolCalls: () => toolCalls,
  }
}

/** Silent tool-calling agent turns surface to the driver as
 *  "Agent called tools: …" so the simulated user can react to them. */
function driverVisibleContent(msg: MultishotMessage): string | null {
  const text = msg.content.trim()
  if (text.length > 0) return text
  if (msg.role !== 'assistant' || !msg.toolCalls?.length) return null

  const toolNames = msg.toolCalls.map((call) => call.name.trim()).filter(Boolean)
  if (toolNames.length === 0) return 'Agent called tools.'
  return `Agent called ${toolNames.length === 1 ? 'tool' : 'tools'}: ${toolNames.join(', ')}.`
}
