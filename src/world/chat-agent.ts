// A model-backed agent for the world: one chat-completions tool loop per
// session. The system prompt is the agent under test's own; the first user
// message is the scenario brief, the date and the notes the agent saved.
// Nothing from an earlier session's conversation is replayed.

import type { ChatClient } from '../analyst/chat-client'
import { ValidationError } from '../errors'
import type { LlmMessage, LlmToolDefinition } from '../llm-client'
import type { WorldAgent, WorldSession } from './types'

/** What one model call returned, without its text. */
export interface ChatWorldResponse {
  /** Model id the provider echoed; null when it echoed none. */
  servedModel: string | null
  finishReason: string | null
  toolCalls: number
  contentChars: number
  completionTokens: number
  reasoningTokens: number | null
}

export interface ChatWorldSessionTranscript {
  session: number
  day: number
  /** Every message of the session, the system prompt included. */
  messages: LlmMessage[]
  /** One entry per model call, empty completions included. */
  responses: ChatWorldResponse[]
  /** `answered`: the model replied in words without a tool call. `turn_limit`:
   *  it was cut off. `empty`: it kept returning neither words nor a tool call.
   *  `failed`: a model call threw, and the driver records the session's error. */
  ended: 'answered' | 'turn_limit' | 'empty' | 'failed'
}

export interface ChatWorldAgentOptions {
  client: ChatClient
  /** Default: the client's default model. */
  model?: string
  /** System prompt of the agent under test. */
  systemPrompt: string
  /** The first user message of a session. Default: `worldSessionPrompt`. A
   *  binding that adds its product's own per-turn context wraps that. */
  sessionPrompt?: (session: WorldSession) => string
  /** Model calls one session may make. Default 16. */
  maxTurnsPerSession?: number
  /** Times in a row an empty completion, neither words nor a tool call, is
   *  asked again before the session ends as `empty`. Default 2. */
  emptyRetries?: number
  maxTokens?: number
  temperature?: number
  /** Called with each finished session's transcript. */
  onSession?: (transcript: ChatWorldSessionTranscript) => Promise<void> | void
}

/** The first user message of a session: all the agent is given. */
export function worldSessionPrompt(session: WorldSession): string {
  const notes = Object.entries(session.notes)
  return [
    session.brief,
    '',
    `Today is ${session.date}: day ${session.day}, review ${session.index + 1}. ${session.daysLeft} days are left.`,
    notes.length === 0
      ? 'You have saved no notes.'
      : `Notes you saved earlier:\n${notes.map(([key, text]) => `[${key}]\n${text}`).join('\n\n')}`,
    '',
    'Read the state with the tools, act if the evidence supports it, and save what you will need next time. When you are done for this review, reply in plain text with what you did and why.',
  ].join('\n')
}

/** An agent that plays each session as a tool loop against a chat model. */
export function chatWorldAgent(opts: ChatWorldAgentOptions): WorldAgent {
  const maxTurns = opts.maxTurnsPerSession ?? 16
  const emptyRetries = opts.emptyRetries ?? 2
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new ValidationError('chatWorldAgent: maxTurnsPerSession must be a positive integer')
  }
  if (!Number.isSafeInteger(emptyRetries) || emptyRetries < 0) {
    throw new ValidationError('chatWorldAgent: emptyRetries must be a non-negative integer')
  }
  return async (session) => {
    const tools: LlmToolDefinition[] = session.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }))
    const messages: LlmMessage[] = [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: (opts.sessionPrompt ?? worldSessionPrompt)(session) },
    ]
    const transcript: ChatWorldSessionTranscript = {
      session: session.index,
      day: session.day,
      messages,
      responses: [],
      ended: 'turn_limit',
    }
    let emptyInARow = 0
    try {
      while (transcript.responses.length < maxTurns) {
        const response = await opts.client.chat({
          ...(opts.model ? { model: opts.model } : {}),
          messages,
          tools,
          toolChoice: 'auto',
          ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        })
        const calls = response.toolCalls ?? []
        transcript.responses.push({
          servedModel: response.servedModel ?? null,
          finishReason: response.finishReason ?? null,
          toolCalls: calls.length,
          contentChars: response.content.length,
          completionTokens: response.usage.completionTokens,
          reasoningTokens: response.usage.reasoningTokens ?? null,
        })
        if (calls.length === 0 && response.content.trim() === '') {
          // Neither an answer nor an action. Ending the session here would
          // score a provider hiccup as the agent choosing to do nothing.
          emptyInARow += 1
          if (emptyInARow > emptyRetries) {
            transcript.ended = 'empty'
            break
          }
          continue
        }
        emptyInARow = 0
        messages.push({
          role: 'assistant',
          content: response.content,
          ...(calls.length > 0 ? { toolCalls: calls } : {}),
        })
        if (calls.length === 0) {
          transcript.ended = 'answered'
          break
        }
        for (const call of calls) {
          let input: unknown
          try {
            input = call.argumentsJson.trim() === '' ? {} : JSON.parse(call.argumentsJson)
          } catch {
            // Passed through as text, so the world refuses it and logs the attempt.
            input = call.argumentsJson
          }
          const result = session.call(call.name, input)
          messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) })
        }
      }
    } catch (error) {
      transcript.ended = 'failed'
      throw error
    } finally {
      await opts.onSession?.(transcript)
    }
  }
}
