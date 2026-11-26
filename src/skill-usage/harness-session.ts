/**
 * A normalized harness session as a skill session record.
 *
 * `@tangle-network/harness-sessions` owns what a session's tool calls, model
 * calls and usage are for every harness it reads. This module only puts them in
 * recorded order and marks which of them invoke a skill. How a harness marks a
 * skill is the one thing that differs, so it comes in as {@link HarnessSkillMarkers}.
 */

import type { HarnessSession, SessionToolCall, TokenUsage } from '@tangle-network/harness-sessions'
import type { CostUsage } from '../cost-ledger/contract'
import type {
  SessionChange,
  SessionUserTurn,
  SkillInvocationEvent,
  SkillInvoker,
  SkillSessionEvent,
  SkillSessionRecord,
} from './session-record'
import { skillBodySha256 } from './skill-file'

/** The text a harness loaded for one invocation, without harness framing or caller arguments. */
export interface LoadedSkillText {
  body: string
  /** The skill file it was loaded from, when the record names it. */
  skillFile: string | null
}

/** An invocation that is not a tool call: a typed command or a harness preload. */
export interface MessageSkillInvocation {
  skill: string
  invoker: Exclude<SkillInvoker, 'agent'>
  loaded: LoadedSkillText | null
}

/** How one harness marks skill invocations in a normalized session. */
export interface HarnessSkillMarkers {
  /** The skill a tool call invokes, or null when it invokes none. */
  skillOfToolCall?: (call: SessionToolCall) => string | null
  /**
   * The skill file a tool call read, for a harness that loads a skill by
   * reading its file. The call is then the invocation; the session holds no
   * loaded text a version can come from, so the report reads the file.
   */
  skillFileOfToolCall?: (call: SessionToolCall) => string | null
  /** Hook ids of tool calls, by the id the session recorded the call under; see {@link SkillSessionRecord.callAliases}. */
  callAliases?: Readonly<Record<string, string>>
  /** Loaded text by the id of the tool call it answers. */
  loadedByCallId?: ReadonlyMap<string, LoadedSkillText>
  /** Invocations that are not tool calls, by the id of the message that carries them. */
  invocationsByMessageId?: ReadonlyMap<string, MessageSkillInvocation>
  /**
   * The changes a tool call produced, as references. Giving this marks the
   * session's `changes` as read, so a session with none records an empty list.
   */
  changesOfToolCall?: (call: SessionToolCall) => readonly string[]
  /** The subagent type a tool call starts, or null when it starts none or the call does not say. */
  subagentOfToolCall?: (call: SessionToolCall) => string | null
}

/** A response's usage as the cost ledger prices it; null unless input and output are both recorded. */
function costUsage(usage: TokenUsage | null): CostUsage | null {
  if (usage === null || usage.input === null || usage.output === null) return null
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead === null ? {} : { cachedTokens: usage.cacheRead }),
    ...(usage.cacheWrite === null ? {} : { cacheWriteTokens: usage.cacheWrite }),
  }
}

function invocation(
  fields: Pick<SkillInvocationEvent, 'callId' | 'skill' | 'invoker' | 'at' | 'failed'>,
  loaded: LoadedSkillText | null | undefined,
  skillFile: string | null = null,
): SkillInvocationEvent {
  return {
    kind: 'skill',
    ...fields,
    version:
      loaded == null ? null : { bodySha256: skillBodySha256(loaded.body), source: 'session' },
    skillFile: loaded?.skillFile ?? skillFile,
  }
}

/**
 * Project a normalized session into recorded order.
 *
 * Without markers the record carries tool and model calls and no invocations,
 * which is the honest reading of a harness whose sessions do not mark them.
 * Calls the session copied from a parent fork are left out: they are the
 * parent's work. A call the session lists but no message places is appended
 * after the placed ones and named in `gaps`.
 */
export function skillSessionFromHarnessSession(
  session: HarnessSession,
  markers: HarnessSkillMarkers = {},
): SkillSessionRecord {
  const toolCalls = new Map(session.toolCalls.map((call) => [call.id, call]))
  const modelCalls = new Map(session.modelCalls.map((call) => [call.id, call]))
  const placedModelCalls = new Set<string>()
  const placedToolCalls = new Set<string>()
  const events: SkillSessionEvent[] = []
  const changes: SessionChange[] = []
  const turns: SessionUserTurn[] = []

  const placeModelCall = (id: string): void => {
    const call = modelCalls.get(id)
    if (call === undefined || placedModelCalls.has(id)) return
    placedModelCalls.add(id)
    // A failed response answered nothing, and a fork's inherited calls are the parent's.
    if (call.error !== null || call.inherited === true) return
    events.push({
      kind: 'model',
      id,
      at: call.at,
      model: call.servedModel,
      usage: costUsage(call.usage),
    })
  }

  const placeToolCall = (id: string): void => {
    const call = toolCalls.get(id)
    if (call === undefined || placedToolCalls.has(id)) return
    placedToolCalls.add(id)
    if (call.inherited === true) return
    const failed = call.result === null ? null : call.result.isError
    for (const ref of markers.changesOfToolCall?.(call) ?? []) {
      changes.push({ ref, callId: id, at: call.startedAt })
    }
    const skill = markers.skillOfToolCall?.(call) ?? null
    if (skill === null) {
      const subagent = markers.subagentOfToolCall?.(call) ?? null
      events.push({
        kind: 'tool',
        id,
        name: call.name,
        at: call.startedAt,
        failed,
        ...(subagent === null ? {} : { subagent }),
      })
      return
    }
    events.push(
      invocation(
        { callId: id, skill, invoker: 'agent', at: call.startedAt, failed },
        markers.loadedByCallId?.get(id),
        markers.skillFileOfToolCall?.(call) ?? null,
      ),
    )
  }

  for (const message of session.messages) {
    if (message.inherited === true) continue
    if (message.role === 'assistant') {
      if (message.modelCallId !== null) placeModelCall(message.modelCallId)
      for (const part of message.parts) {
        if (part.type === 'tool-call') placeToolCall(part.toolCallId)
      }
      continue
    }
    if (message.role === 'user' && message.actor === 'human') {
      const text = message.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n')
        .trim()
      if (text !== '') {
        turns.push({ id: message.id, at: message.at, eventIndex: events.length, text })
      }
    }
    const marker = markers.invocationsByMessageId?.get(message.id)
    if (marker !== undefined) {
      events.push(
        invocation(
          {
            callId: message.id,
            skill: marker.skill,
            invoker: marker.invoker,
            at: message.at,
            failed: null,
          },
          marker.loaded,
        ),
      )
    }
  }

  const gaps = [...session.integrity.gaps]
  // Failed responses and inherited calls produce no event, so they are not out of order.
  const unplacedModelCalls = session.modelCalls.filter(
    (call) => !placedModelCalls.has(call.id) && call.error === null && call.inherited !== true,
  )
  const unplacedToolCalls = session.toolCalls.filter(
    (call) => !placedToolCalls.has(call.id) && call.inherited !== true,
  )
  for (const call of unplacedModelCalls) placeModelCall(call.id)
  for (const call of unplacedToolCalls) placeToolCall(call.id)
  if (unplacedModelCalls.length + unplacedToolCalls.length > 0) {
    gaps.push(
      `${unplacedModelCalls.length} model calls and ${unplacedToolCalls.length} tool calls are in no message, so they are ordered after the ones that are`,
    )
  }

  return {
    harness: session.harness,
    sessionId: session.nativeSessionId,
    parentSessionId: session.parentNativeSessionId,
    endedAt: session.endedAt,
    events,
    ...(markers.changesOfToolCall === undefined ? {} : { changes }),
    ...(markers.callAliases === undefined || Object.keys(markers.callAliases).length === 0
      ? {}
      : { callAliases: markers.callAliases }),
    turns,
    gaps,
  }
}
