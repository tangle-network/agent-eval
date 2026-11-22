// A model-backed agent for the world: one chat-completions tool loop per
// session. The system prompt is the agent under test's own; the first user
// message is the scenario brief, the date and the notes the agent saved.
// Nothing from an earlier session's conversation is replayed.

import type { ChatClient } from '../analyst/chat-client'
import { ValidationError } from '../errors'
import type { LlmMessage, LlmToolDefinition } from '../llm-client'
import type { WorldAgent, WorldSession } from './types'

export interface ChatWorldSessionTranscript {
  session: number
  day: number
  /** Every message of the session, the system prompt included. */
  messages: LlmMessage[]
  /** Model calls made. */
  turns: number
  /** `answered`: the model replied without a tool call. `turn_limit`: it was cut off. */
  ended: 'answered' | 'turn_limit'
  /** Model ids the provider echoed, in call order; null where it echoed none. */
  servedModels: Array<string | null>
}

export interface ChatWorldAgentOptions {
  client: ChatClient
  /** Default: the client's default model. */
  model?: string
  /** System prompt of the agent under test. */
  systemPrompt: string
  /** Model calls one session may make. Default 16. */
  maxTurnsPerSession?: number
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
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new ValidationError('chatWorldAgent: maxTurnsPerSession must be a positive integer')
  }
  return async (session) => {
    const tools: LlmToolDefinition[] = session.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }))
    const messages: LlmMessage[] = [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: worldSessionPrompt(session) },
    ]
    const transcript: ChatWorldSessionTranscript = {
      session: session.index,
      day: session.day,
      messages,
      turns: 0,
      ended: 'turn_limit',
      servedModels: [],
    }
    try {
      while (transcript.turns < maxTurns) {
        const response = await opts.client.chat({
          ...(opts.model ? { model: opts.model } : {}),
          messages,
          tools,
          toolChoice: 'auto',
          ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        })
        transcript.turns += 1
        transcript.servedModels.push(response.servedModel ?? null)
        const calls = response.toolCalls ?? []
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
    } finally {
      await opts.onSession?.(transcript)
    }
  }
}
