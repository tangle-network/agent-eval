/**
 * What happened to a change, supplied by the caller, and the join that attaches
 * it to the procedure invocations of the session that produced the change.
 *
 * A turn-level signal predicts an operator's correction poorly; a change is the
 * unit that has an outcome. The caller says, per change (a commit or a pull
 * request, named by one reference string), whether it merged, whether its gate
 * passed on the first try, and whether a fix to it followed. Any of the three
 * can be unknown, and unknown is never read as `false`.
 */

import { ValidationError } from '../errors'

/** A later merged change that fixes this one lands within this many days. */
export const HOTFIX_WINDOW_DAYS = 7

export interface ChangeOutcome {
  /** The change's reference, as the session reader names it: `owner/repo#123` for a pull request. */
  ref: string
  /** null: not known. */
  merged: boolean | null
  /** The gate passed on its first run. null: no gate result, or not known. */
  gateGreenFirstTry: boolean | null
  /**
   * A later merged change fixed this one within `hotfixWindowDays`. `false`
   * asserts the whole window was observed with no such fix; null means the
   * window was still open or the fixes were not searched.
   */
  hotfixed: boolean | null
  /** The window `hotfixed` was judged over. Must be {@link HOTFIX_WINDOW_DAYS}. */
  hotfixWindowDays: number
}

/** A change's outcome as the registry reads it: each field is the caller's, or unknown. */
export interface ChangeOutcomeReading {
  ref: string
  merged: boolean | null
  gateGreenFirstTry: boolean | null
  hotfixed: boolean | null
}

export interface ChangeOutcomeIndex {
  byRef: ReadonlyMap<string, ChangeOutcomeReading>
  /** Outcomes whose window is not the 7-day one: their `hotfixed` is read as unknown. */
  otherWindow: number
  duplicates: number
}

/**
 * Index outcomes by change reference. An outcome judged over another window
 * keeps `merged` and `gateGreenFirstTry` and loses `hotfixed`: a 3-day and a
 * 14-day "no fix" are different claims, and the registry has one definition.
 * Two outcomes for one reference must agree; a reference given twice with
 * different readings throws.
 */
export function indexChangeOutcomes(outcomes: Iterable<ChangeOutcome>): ChangeOutcomeIndex {
  const byRef = new Map<string, ChangeOutcomeReading>()
  let otherWindow = 0
  let duplicates = 0
  for (const outcome of outcomes) {
    if (typeof outcome.ref !== 'string' || outcome.ref === '') {
      throw new ValidationError('a change outcome needs a non-empty ref')
    }
    const sameWindow = outcome.hotfixWindowDays === HOTFIX_WINDOW_DAYS
    if (!sameWindow) otherWindow += 1
    const reading: ChangeOutcomeReading = {
      ref: outcome.ref,
      merged: outcome.merged,
      gateGreenFirstTry: outcome.gateGreenFirstTry,
      hotfixed: sameWindow ? outcome.hotfixed : null,
    }
    const known = byRef.get(outcome.ref)
    if (known !== undefined) {
      duplicates += 1
      if (JSON.stringify(known) !== JSON.stringify(reading)) {
        throw new ValidationError(`change ${outcome.ref} has two different outcomes`)
      }
      continue
    }
    byRef.set(outcome.ref, reading)
  }
  return { byRef, otherWindow, duplicates }
}

/** One invocation's changes with their outcomes. */
export type InvocationChanges =
  /** The session reader does not record changes: the join has no evidence either way. */
  | { status: 'not-recorded' }
  /** The reader looked, and neither the session nor an ancestor produced a change. */
  | { status: 'none' }
  | {
      status: 'joined'
      /** Changes of the invocation's own session and of the sessions that spawned it. */
      refs: string[]
      /** Outcomes the caller supplied for those changes; a change absent here has none. */
      outcomes: ChangeOutcomeReading[]
    }

export interface SessionChanges {
  parentSessionId: string | null
  /** undefined: the reader does not record changes. */
  refs: readonly string[] | undefined
}

/**
 * The changes an invocation produced: those of its session, and of every
 * session that spawned it, since a subagent's work belongs to the change its
 * parent shipped. A session absent from `sessions` ends the walk, and a cycle
 * in the parent links is cut where it repeats.
 */
export function joinInvocationToChanges(
  sessionId: string,
  sessions: ReadonlyMap<string, SessionChanges>,
  outcomes: ChangeOutcomeIndex,
): InvocationChanges {
  const refs = new Set<string>()
  let recorded = false
  const visited = new Set<string>()
  for (
    let current: string | null = sessionId;
    current !== null && !visited.has(current);
    current = sessions.get(current)?.parentSessionId ?? null
  ) {
    visited.add(current)
    const session = sessions.get(current)
    if (session?.refs === undefined) continue
    recorded = true
    for (const ref of session.refs) refs.add(ref)
  }
  if (!recorded) return { status: 'not-recorded' }
  if (refs.size === 0) return { status: 'none' }
  const sorted = [...refs].sort()
  return {
    status: 'joined',
    refs: sorted,
    outcomes: sorted.flatMap((ref) => {
      const reading = outcomes.byRef.get(ref)
      return reading === undefined ? [] : [reading]
    }),
  }
}
