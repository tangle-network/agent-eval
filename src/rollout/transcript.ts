import { ValidationError } from '../errors'
import { isRecord } from '../llm-client/json'
import type { ChatMessage } from './schema'

/** Attempt-bound native transcript verification, with its retained source references. */
export interface RolloutNativeCapture {
  execution_index: number
  /** A later verified receipt repaired this explicitly unavailable capture, preserving its audit record. */
  resolved_by?: string
  evidence_ref: string
  root_id: string | null
  attempt_id: string | null
  task_ref: string | null
  result_ref: string | null
  transcript_ref: string | null
  verified: boolean
  gap: string | null
  native_session_ids: string[]
}

export function validateNativeCaptures(value: unknown, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('provenance.native_captures: expected array')
    return
  }
  for (const [index, capture] of value.entries()) {
    if (
      !isRecord(capture) ||
      typeof capture.evidence_ref !== 'string' ||
      typeof capture.execution_index !== 'number' ||
      !Number.isSafeInteger(capture.execution_index) ||
      capture.execution_index < 0 ||
      (capture.resolved_by !== undefined && typeof capture.resolved_by !== 'string') ||
      !['root_id', 'attempt_id', 'task_ref', 'result_ref', 'transcript_ref', 'gap'].every(
        (field) => capture[field] === null || typeof capture[field] === 'string',
      ) ||
      typeof capture.verified !== 'boolean' ||
      capture.verified !== (capture.gap === null) ||
      !Array.isArray(capture.native_session_ids) ||
      !capture.native_session_ids.every((id) => typeof id === 'string')
    )
      errors.push(`provenance.native_captures[${index}]: invalid native transcript evidence`)
  }
}

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
