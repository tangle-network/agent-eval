/**
 * The spans a trace contract reads from a recorded harness session.
 *
 * A session becomes one root span for the session, one LLM span per assistant
 * message that answered with text, and one TOOL span per tool call, in the
 * session's recorded order. A tool span carries the call's arguments as `args`
 * and its input and result text as `input.value` and `output.value`; an LLM
 * span carries its text as `output.value`. Calls and messages a fork copied
 * from its parent are the parent's work and are left out.
 */

import type { HarnessSession } from '@tangle-network/harness-sessions'
import type { ContractSpan } from './types'

function epochMs(at: string | null): number | undefined {
  if (at === null) return undefined
  const value = Date.parse(at)
  return Number.isFinite(value) ? value : undefined
}

function timed(start: string | null, end: string | null): Pick<ContractSpan, 'startedAt' | 'endedAt'> {
  const startedAt = epochMs(start)
  const endedAt = epochMs(end) ?? startedAt
  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

export function contractSpansFromHarnessSession(session: HarnessSession): ContractSpan[] {
  const root = `session:${session.nativeSessionId}`
  const spans: ContractSpan[] = [
    {
      spanId: root,
      parentSpanId: null,
      name: 'session',
      kind: 'AGENT',
      ...timed(session.startedAt, session.endedAt),
      attributes: { 'session.harness': session.harness },
    },
  ]
  const calls = new Map(session.toolCalls.map((call) => [call.id, call]))
  const placed = new Set<string>()
  const toolSpan = (id: string): void => {
    const call = calls.get(id)
    if (call === undefined || placed.has(id) || call.inherited === true) return
    placed.add(id)
    const input = call.inputText ?? JSON.stringify(call.input ?? null)
    spans.push({
      spanId: `tool:${call.id}`,
      parentSpanId: root,
      name: call.name,
      kind: 'TOOL',
      toolName: call.name,
      ...timed(call.startedAt, call.endedAt ?? call.result?.at ?? null),
      ...(call.status === 'error' || call.result?.isError === true
        ? { status: 'error' }
        : call.status === 'completed'
          ? { status: 'ok' }
          : {}),
      args: call.input,
      attributes: {
        'input.value': input,
        ...(call.result?.text ? { 'output.value': call.result.text } : {}),
      },
    })
  }
  for (const message of session.messages) {
    if (message.inherited === true || message.role !== 'assistant') continue
    const text = message.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .trim()
    if (text !== '') {
      spans.push({
        spanId: `llm:${message.id}`,
        parentSpanId: root,
        name: 'llm.call',
        kind: 'LLM',
        ...timed(message.at, message.at),
        attributes: { 'output.value': text },
      })
    }
    for (const part of message.parts) if (part.type === 'tool-call') toolSpan(part.toolCallId)
  }
  for (const call of session.toolCalls) toolSpan(call.id)
  return spans
}
