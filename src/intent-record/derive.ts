/**
 * Intent records from recorded sessions.
 *
 * A session's typed turns are cut into intents. A turn that a labeler calls a
 * correction or a re-ask attaches to the intent already open; any other turn
 * opens a new one and closes the open one. A turn nobody labeled opens a new
 * intent, and the intent it closes then cannot say how many corrections it
 * drew. The span of an intent runs from its opening turn to the turn that
 * closes it, or to the session's end, and its cost and procedures are those of
 * the events in that span.
 */

import { createHash } from 'node:crypto'
import type { InvocationChanges } from '../procedure-registry/change-outcome'
import type { SessionChange, SkillSessionRecord, SkillUsageReportOptions } from '../skill-usage'
import { afterInvocation, instant } from '../skill-usage/report'
import type {
  IntentCost,
  IntentLabeler,
  IntentRecord,
  IntentTurnLabel,
} from './contract'

interface Thread {
  openedAtIndex: number
  startEvent: number
  startAt: string | null
  promptSha256: string
  promptChars: number
  turnId: string
  label: IntentTurnLabel | null
  userTurns: number
  corrections: number
  reasks: number
  correctionsKnown: boolean
  reasksKnown: boolean
  endEvent: number
  endAt: string | null
  closedBy: 'next-intent' | 'session-end'
}

/** An intent before its procedures and outcomes are joined. */
export interface IntentDraft {
  record: Omit<IntentRecord, 'procedures' | 'changes' | 'end'> & {
    end: Omit<IntentRecord['end'], 'reachedDone' | 'abandoned' | 'evidence'>
  }
  /** Events [from, to) of the session. */
  span: { from: number; to: number }
  /** The span's instants, for work done in subagents. `to` null: open. */
  window: { from: string | null; to: string | null }
  /** Changes whose tool call is in the span. undefined: the reader records none. */
  changeRefs: string[] | undefined
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function isCorrection(label: IntentTurnLabel | null): boolean | null {
  if (label === null) return null
  if (label.kind === 'correction') return true
  return label.correction
}

function cost(
  session: SkillSessionRecord,
  thread: Thread,
  options: SkillUsageReportOptions,
): IntentCost {
  const after = afterInvocation(
    session,
    thread.startEvent - 1,
    thread.startAt,
    options,
    { eventIndex: thread.endEvent, at: thread.endAt },
  )
  return {
    tokens: after.modelCalls > 0 && after.modelCallsWithoutUsage === 0 ? after.tokens.total : null,
    usd: after.pricedModelCalls > 0 && after.unpricedModelCalls === 0 ? after.costUsd : null,
    wallMs: after.wallMs,
    modelCalls: after.modelCalls,
  }
}

function refsInSpan(
  session: SkillSessionRecord,
  from: number,
  to: number,
): string[] | undefined {
  if (session.changes === undefined) return undefined
  const position = new Map<string, number>()
  session.events.forEach((event, index) => {
    if (event.kind === 'tool') position.set(event.id, index)
    else if (event.kind === 'skill') position.set(event.callId, index)
  })
  const refs = new Set<string>()
  for (const change of session.changes as SessionChange[]) {
    const index = position.get(change.callId)
    if (index !== undefined && index >= from && index < to) refs.add(change.ref)
  }
  return [...refs].sort()
}

/**
 * Cut one session's typed turns into intents. Returns none when the reader
 * records no typed turns, and the caller counts that session apart.
 */
export async function deriveSessionIntents(
  session: SkillSessionRecord,
  labeler: IntentLabeler | undefined,
  options: SkillUsageReportOptions,
): Promise<IntentDraft[] | null> {
  if (session.turns === undefined) return null
  const threads: Thread[] = []
  let open: Thread | null = null
  let previousText: string | null = null

  const close = (
    thread: Thread,
    by: 'next-intent' | 'session-end',
    at: string | null,
    event: number,
  ): void => {
    thread.closedBy = by
    thread.endAt = at
    thread.endEvent = event
  }

  for (const [index, turn] of session.turns.entries()) {
    if (options.sinceMs !== undefined) {
      const at = instant(turn.at)
      if (at === null || at < options.sinceMs) continue
    }
    const label =
      labeler === undefined
        ? null
        : await labeler({
            harness: session.harness,
            sessionId: session.sessionId,
            index,
            at: turn.at,
            text: turn.text,
            previousText,
          })
    previousText = turn.text
    const correction = isCorrection(label)
    const reask = label === null ? null : label.reask
    const attaches = open !== null && (correction === true || reask === true)
    if (open !== null) {
      // Every turn after an intent says whether it corrected or re-asked it.
      if (correction === null) open.correctionsKnown = false
      else if (correction) open.corrections += 1
      if (reask === null) open.reasksKnown = false
      else if (reask) open.reasks += 1
    }
    if (attaches && open !== null) {
      open.userTurns += 1
      continue
    }
    if (open !== null) close(open, 'next-intent', turn.at, turn.eventIndex)
    open = {
      openedAtIndex: index,
      startEvent: turn.eventIndex,
      startAt: turn.at,
      promptSha256: sha256(turn.text),
      promptChars: turn.text.length,
      turnId: turn.id,
      label,
      userTurns: 1,
      corrections: 0,
      reasks: 0,
      correctionsKnown: true,
      reasksKnown: true,
      endEvent: session.events.length,
      endAt: session.endedAt,
      closedBy: 'session-end',
    }
    threads.push(open)
  }

  return threads.map((thread) => {
    const intentId = sha256(`${session.harness}\u0000${session.sessionId}\u0000${thread.turnId}`)
    return {
      record: {
        intentId,
        harness: session.harness,
        sessionId: session.sessionId,
        at: thread.startAt,
        prompt: { sha256: thread.promptSha256, chars: thread.promptChars },
        label:
          thread.label === null
            ? null
            : { source: thread.label.source, kind: thread.label.kind, done: thread.label.done },
        cost: cost(session, thread, options),
        end: {
          userTurns: thread.userTurns,
          corrections: thread.correctionsKnown ? thread.corrections : null,
          reasks: thread.reasksKnown ? thread.reasks : null,
          closedBy: thread.closedBy,
        },
      },
      span: { from: thread.startEvent, to: thread.endEvent },
      window: { from: thread.startAt, to: thread.closedBy === 'next-intent' ? thread.endAt : null },
      changeRefs: refsInSpan(session, thread.startEvent, thread.endEvent),
    }
  })
}

/** Whether a change reading says the change reached its done line: merged and not fixed within the window. */
export function changesReachedDone(
  changes: InvocationChanges,
): { reachedDone: boolean | null; abandoned: boolean | null } {
  if (changes.status !== 'joined' || changes.outcomes.length === 0) {
    return { reachedDone: null, abandoned: null }
  }
  const outcomes = changes.outcomes
  const unmerged = outcomes.some((outcome) => outcome.merged === false)
  const fixed = outcomes.some((outcome) => outcome.merged === true && outcome.hotfixed === true)
  const clean = outcomes.every((outcome) => outcome.merged === true && outcome.hotfixed === false)
  return {
    reachedDone: unmerged || fixed ? false : clean ? true : null,
    abandoned: unmerged ? true : outcomes.every((o) => o.merged === true) ? false : null,
  }
}
