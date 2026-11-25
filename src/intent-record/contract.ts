/**
 * The intent record: what a person asked for, what served it, what it cost and
 * how it ended.
 *
 * An intent is the input to everything else. Any prompt counts: a task, a
 * problem, a project, information the person shares, or a correction. The
 * record holds the prompt's digest and length, never its text, so a record can
 * be kept and shared where the words cannot.
 *
 * Three things are kept apart from zero throughout: a label nobody gave, a
 * measure no event reported, and a change whose outcome nobody supplied. A
 * correction is counted after the fact as an outcome. Nothing here predicts one.
 */

import type { InvocationChanges } from '../procedure-registry/change-outcome'

export type IntentKind = 'task' | 'problem' | 'project' | 'information' | 'correction'

export const INTENT_KINDS: readonly IntentKind[] = [
  'task',
  'problem',
  'project',
  'information',
  'correction',
]

/**
 * How a prompt says when it is finished. `stated`: the prompt names a done
 * line. `inferred`: it names none and the labeler supplied one. `none`: the
 * labeler found none to state or infer.
 */
export type IntentDoneBasis = 'stated' | 'inferred' | 'none'

/**
 * What a labeler says of one typed turn. Each field is the labeler's or null:
 * a labeler that did not look says null, and null is never read as `false`.
 */
export interface IntentTurnLabel {
  /** Who labeled: a model, a lexical rule, a person. Carried onto the record. */
  source: string
  kind: IntentKind | null
  done: IntentDoneBasis | null
  /** The turn tells the agent its last work was wrong. */
  correction: boolean | null
  /** The turn asks again for what an open intent already asked. */
  reask: boolean | null
}

/** One typed turn, as a labeler reads it. The text is private: do not keep it. */
export interface IntentTurn {
  harness: string
  sessionId: string
  /** Position among the session's typed turns, from 0. */
  index: number
  at: string | null
  text: string
  /** The turn before this one in the session, when there is one. */
  previousText: string | null
}

/** The labeler is the caller's: a model pass, a lexical rule, a person's labels looked up by turn. */
export type IntentLabeler = (turn: IntentTurn) => IntentTurnLabel | null | Promise<IntentTurnLabel | null>

export interface IntentCost {
  /** Tokens of the model calls in the intent's span; null where any call recorded no usage, or there was none. */
  tokens: number | null
  /** null where any call could not be priced: unknown, not free. */
  usd: number | null
  /** From the intent's turn to the turn that closed it, or the session's end. */
  wallMs: number | null
  modelCalls: number
}

export type IntentClosedBy = 'next-intent' | 'session-end'

/** What the evidence for `reachedDone` is. `none`: nothing says. */
export type IntentEndEvidence = 'change-outcome' | 'moved-on' | 'none'

export interface IntentEnd {
  /** The opening turn and every turn attached to it. */
  userTurns: number
  /** Corrections after the opening turn. null when a following turn's label did not say. */
  corrections: number | null
  reasks: number | null
  closedBy: IntentClosedBy
  /**
   * The intent reached its done line. From the outcome of its changes when they
   * have one (merged, and no fix within the window); else true when the person
   * moved on to another intent; else null. A session that simply ends says nothing.
   */
  reachedDone: boolean | null
  /** The change the intent produced did not merge. Never inferred from silence. */
  abandoned: boolean | null
  evidence: IntentEndEvidence
}

export interface IntentRecord {
  /** sha256 of the harness, session and the opening turn's id. */
  intentId: string
  harness: string
  sessionId: string
  at: string | null
  prompt: { sha256: string; chars: number }
  /** The opening turn's label; null when no labeler said anything of it. */
  label: Pick<IntentTurnLabel, 'source' | 'kind' | 'done'> | null
  /** Registry keys of the procedure versions invoked in the intent's span, in this session and in the subagents it spawned. */
  procedures: string[]
  cost: IntentCost
  end: IntentEnd
  /** The changes produced in the intent's span, in this session, with the outcomes supplied for them. */
  changes: InvocationChanges
}

export interface IntentKindSummary {
  /** null: intents no labeler gave a kind. */
  kind: IntentKind | null
  intents: number
  /** `reachedDone` is known. */
  knownEnd: number
  knownEndShare: number | null
  /** The correction count is known. */
  knownCorrections: number
  joinedToChange: number
  withChangeOutcome: number
}

export interface IntentReport {
  intents: IntentRecord[]
  summary: {
    intents: number
    sessionsWithTurns: number
    /** Sessions whose reader does not tell a person's turn from other messages. */
    sessionsWithoutTurns: number
    /** Intents whose opening turn a labeler labeled. */
    labeled: number
    knownEnd: number
    knownEndShare: number | null
    byKind: IntentKindSummary[]
  }
  notes: string[]
}
