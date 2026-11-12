import { ValidationError } from '../errors'
import type { ChatMessage, RolloutNativeCapture } from './schema'

/** Never recover missing calls from tool names, span order or argument summaries. */
export function requireToolLinkage(messages: readonly ChatMessage[], context: string): void {
  const seen = new Set<string>()
  const pending = new Map<string, string>()
  const refuse: (detail: string) => never = (detail) => {
    throw new ValidationError(`${context}: ${detail}`)
  }
  for (const message of messages) {
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
        refuse('tool calls must be captured on an assistant message')
      }
      if (pending.size > 0) refuse('new tool calls precede the prior invocation results')
      for (const call of message.tool_calls) {
        if (
          !call ||
          typeof call.id !== 'string' ||
          call.id.length === 0 ||
          seen.has(call.id) ||
          call.type !== 'function' ||
          !call.function ||
          typeof call.function.name !== 'string' ||
          call.function.name.length === 0 ||
          typeof call.function.arguments !== 'string'
        ) {
          refuse('missing, duplicate or malformed tool invocation')
        }
        seen.add(call.id)
        pending.set(call.id, call.function.name)
      }
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id
      if (typeof id !== 'string' || !pending.has(id)) {
        refuse('tool result has no captured invocation (or answers it more than once)')
      }
      if (message.name !== undefined && message.name !== pending.get(id)) {
        refuse('tool result name does not match its invocation')
      }
      pending.delete(id)
    } else if (message.tool_call_id !== undefined) {
      refuse('tool_call_id is only valid on a tool result')
    } else if (pending.size > 0 && message.tool_calls === undefined) {
      refuse('conversation advances before all tool results were captured')
    }
  }
  if (pending.size > 0) refuse('tool invocation has no captured result')
}

/** Only the same execution and immutable binding can share a capture repair. */
export function sameNativeCaptureIdentity(
  left: RolloutNativeCapture,
  right: RolloutNativeCapture,
): boolean {
  return (
    left.root_id !== null &&
    left.attempt_id !== null &&
    left.task_ref !== null &&
    left.execution_index === right.execution_index &&
    left.root_id === right.root_id &&
    left.attempt_id === right.attempt_id &&
    left.task_ref === right.task_ref &&
    left.result_ref === right.result_ref
  )
}

/** A repair must point forward to a verified receipt for that exact invocation. */
export function unresolvedNativeCaptures(
  captures: readonly RolloutNativeCapture[],
): RolloutNativeCapture[] {
  return captures.filter(
    (capture, index) =>
      !capture.verified &&
      !captures
        .slice(index + 1)
        .some(
          (later) =>
            capture.resolved_by === later.evidence_ref &&
            later.verified &&
            sameNativeCaptureIdentity(capture, later),
        ),
  )
}
