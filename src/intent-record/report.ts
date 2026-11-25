/** Join intent drafts to the procedure versions that served them and the outcomes of their changes. */

import type { ChangeOutcomeIndex, InvocationChanges } from '../procedure-registry/change-outcome'
import { instant } from '../skill-usage/report'
import { INTENT_KINDS, type IntentKind, type IntentRecord, type IntentReport } from './contract'
import { changesReachedDone, type IntentDraft } from './derive'

/** One counted procedure invocation, placed in its session. */
export interface SessionInvocation {
  /** The event's position in the session. */
  index: number
  at: string | null
  /** The registry key of the version that ran. */
  key: string
}

export interface SessionIntents {
  sessionId: string
  parentSessionId: string | null
  /** null: the reader records no typed turns. */
  drafts: IntentDraft[] | null
  invocations: SessionInvocation[]
}

const NOTES = [
  'Intents are cut from typed turns: a turn a labeler calls a correction or a re-ask attaches to the open intent, and any other turn, labeled or not, opens a new one. Without labels every turn is its own intent and no intent knows its corrections.',
  'An intent joins the changes whose tool call lies in its span, in its own session only. Work and changes in subagents count toward the procedures that served it, by time, and not toward its cost or changes.',
  'reachedDone comes from the outcome of the intent’s changes when they have one, else is true when the person moved on to another intent, else unknown. A session that ends says nothing.',
]

function joinChanges(refs: string[] | undefined, outcomes: ChangeOutcomeIndex): InvocationChanges {
  if (refs === undefined) return { status: 'not-recorded' }
  if (refs.length === 0) return { status: 'none' }
  return {
    status: 'joined',
    refs,
    outcomes: refs.flatMap((ref) => {
      const reading = outcomes.byRef.get(ref)
      return reading === undefined ? [] : [reading]
    }),
  }
}

export function buildIntentReport(
  sessions: readonly SessionIntents[],
  outcomes: ChangeOutcomeIndex,
): IntentReport {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  // Work in a subagent belongs to the intents of the sessions that spawned it, when it ran inside their span.
  const inherited = new Map<IntentDraft, Set<string>>()
  for (const session of sessions) {
    for (
      let parent = session.parentSessionId, hops = 0;
      parent !== null && hops < 64;
      parent = byId.get(parent)?.parentSessionId ?? null, hops++
    ) {
      for (const draft of byId.get(parent)?.drafts ?? []) {
        const from = instant(draft.window.from)
        const to = instant(draft.window.to)
        if (from === null) continue
        for (const invocation of session.invocations) {
          const at = instant(invocation.at)
          if (at === null || at < from || (to !== null && at >= to)) continue
          const keys = inherited.get(draft) ?? new Set<string>()
          keys.add(invocation.key)
          inherited.set(draft, keys)
        }
      }
    }
  }

  const intents: IntentRecord[] = []
  let sessionsWithTurns = 0
  let sessionsWithoutTurns = 0
  for (const session of sessions) {
    if (session.drafts === null) {
      sessionsWithoutTurns += 1
      continue
    }
    sessionsWithTurns += 1
    for (const draft of session.drafts) {
      const keys = new Set(inherited.get(draft))
      for (const invocation of session.invocations) {
        if (invocation.index >= draft.span.from && invocation.index < draft.span.to) {
          keys.add(invocation.key)
        }
      }
      const changes = joinChanges(draft.changeRefs, outcomes)
      const fromChanges = changesReachedDone(changes)
      const movedOn = draft.record.end.closedBy === 'next-intent'
      const evidence =
        fromChanges.reachedDone !== null ? 'change-outcome' : movedOn ? 'moved-on' : 'none'
      intents.push({
        ...draft.record,
        procedures: [...keys].sort(),
        end: {
          ...draft.record.end,
          reachedDone: fromChanges.reachedDone ?? (movedOn ? true : null),
          abandoned: fromChanges.abandoned,
          evidence,
        },
        changes,
      })
    }
  }

  const kinds: Array<IntentKind | null> = [...INTENT_KINDS, null]
  const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole)
  const known = (record: IntentRecord): boolean => record.end.reachedDone !== null
  return {
    intents,
    summary: {
      intents: intents.length,
      sessionsWithTurns,
      sessionsWithoutTurns,
      labeled: intents.filter((record) => record.label !== null).length,
      knownEnd: intents.filter(known).length,
      knownEndShare: share(intents.filter(known).length, intents.length),
      byKind: kinds.map((kind) => {
        const of = intents.filter((record) => (record.label?.kind ?? null) === kind)
        return {
          kind,
          intents: of.length,
          knownEnd: of.filter(known).length,
          knownEndShare: share(of.filter(known).length, of.length),
          knownCorrections: of.filter((record) => record.end.corrections !== null).length,
          joinedToChange: of.filter((record) => record.changes.status === 'joined').length,
          withChangeOutcome: of.filter(
            (record) => record.changes.status === 'joined' && record.changes.outcomes.length > 0,
          ).length,
        }
      }),
    },
    notes: [...NOTES],
  }
}
