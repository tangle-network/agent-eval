/**
 * The two named score derivations every consumer must choose between.
 *
 * The anti-Goodhart gate (`outcome.realness.gated`) only holds if it is
 * impossible to read a run's score WITHOUT deciding whether the gate applies.
 * A bare `outcome.holdoutScore ?? outcome.searchScore` makes that decision
 * invisible — and silently answers "no gate", which is the wrong default on
 * every path that produces training data. So the expression lives here, once,
 * behind two names that force the caller to state the intent:
 *
 *   - `trainingScore` / `trainingReward` — GATED. Anything that becomes
 *     training data, or a reward a trainer consumes, uses these.
 *   - `observedScore` — RAW. Analysis, reporting, and reward-hack DETECTION
 *     need the ungated number; that is how a gamed run is visible at all.
 *
 * A leaf module on purpose: it imports only the `RunRecord` type, so gate and
 * reporting code can depend on it without pulling in the trace store that
 * `mint.ts` needs.
 */

import type { RunRecord } from '../run-record'

/**
 * Which split's score wins when a record carries both. `'holdout'` is the
 * canonical "real signal" default; `'search'` exists because some callers
 * deliberately score on the search split when both are present.
 */
export type ScorePreference = 'holdout' | 'search'

/** Only the outcome is read, so every accessor here accepts anything carrying one. */
type Scored = Pick<RunRecord, 'outcome'>

/** True when the authenticity gate flagged the run as gamed (`realness.gated`). */
export function isRealnessGated(record: Scored): boolean {
  return record.outcome.realness?.gated === true
}

/**
 * The RAW score recorded on ONE split, with no cross-split fallback and no
 * anti-Goodhart gate.
 *
 * The narrowest of the three raw readers, and the one every split-scoped
 * consumer wants: a per-split report, a promotion gate, or a paired comparison
 * asks "what did this run score on the split I am summarising", and answering
 * it with the other split's number silently mixes populations. `undefined` =
 * that split was never scored.
 *
 * Same warning as `observedScore`: this INCLUDES runs flagged as gamed. Never
 * feed it into training data.
 */
export function observedSplitScore(record: Scored, split: ScorePreference): number | undefined {
  return split === 'search' ? record.outcome.searchScore : record.outcome.holdoutScore
}

/**
 * The RAW split score the run carries, with NO anti-Goodhart gate applied.
 *
 * INCLUDES RUNS FLAGGED AS GAMED (`outcome.realness.gated === true`); NEVER
 * feed this into training data — a fine-tune that sees it learns from gamed
 * successes. It is exported anyway because analysis, reporting, and
 * reward-hacking detection legitimately need the ungated number: forcing a
 * gamed run to 0 collapses the proxy signal toward ground truth and makes a
 * detector report "clean" on exactly the population that is being gamed.
 *
 * Returns `undefined` when the record carries neither score — an unscored run
 * is a labeled gap, not a measured zero, and each caller picks its own
 * sentinel (`?? 0`, `?? null`, skip, throw). Non-finite values are returned
 * as-is; callers that care keep their own `Number.isFinite` guard.
 */
export function observedScore(
  record: Scored,
  prefer: ScorePreference = 'holdout',
): number | undefined {
  const other: ScorePreference = prefer === 'search' ? 'holdout' : 'search'
  return observedSplitScore(record, prefer) ?? observedSplitScore(record, other)
}

/** Which split actually carried the score, or that none did. */
export type ScoreOrigin = 'holdout' | 'search' | 'unscored'

/**
 * Where `observedScore` / `trainingScore` read their number from — the
 * provenance label a rollout line's `reward_source` is built from, and the
 * only supported way to ask "was this run scored at all" without respelling
 * the field access.
 */
export function scoreOrigin(record: Scored, prefer: ScorePreference = 'holdout'): ScoreOrigin {
  const other: ScorePreference = prefer === 'search' ? 'holdout' : 'search'
  if (observedSplitScore(record, prefer) !== undefined) return prefer
  if (observedSplitScore(record, other) !== undefined) return other
  return 'unscored'
}

/**
 * The GATED score — the only derivation allowed to reach training data.
 *
 * A realness-gated run scores 0 no matter what it claims, so a fine-tune
 * cannot learn from a gamed success. An unscored run stays `undefined` (a
 * labeled gap), keeping "we never measured this" distinct from "we measured
 * zero"; callers that need a number apply their own sentinel.
 */
export function trainingScore(
  record: Scored,
  prefer: ScorePreference = 'holdout',
): number | undefined {
  if (isRealnessGated(record)) return 0
  return observedScore(record, prefer)
}

/**
 * `{reward, gated}` as written onto a minted `RolloutLine` — `trainingScore`
 * plus the flag itself, so the gate travels into the exported row and a
 * downstream filter can drop or down-weight the line.
 *
 * An unscored record yields `reward: null`, matching the schema's "no verdict
 * exists — a labeled gap, never 0" rule. It previously collapsed to 0, which
 * made a run nobody graded indistinguishable from one graded as a total
 * failure, and taught any trainer reading the row that the trajectory was bad.
 * A gated run still yields 0, because that IS a verdict: the gate decided.
 */
export function trainingReward(record: Scored): { reward: number | null; gated: boolean } {
  return { reward: trainingScore(record) ?? null, gated: isRealnessGated(record) }
}

/** @deprecated Renamed to `trainingReward`, which now pairs with `observedScore`. */
export const rolloutReward = trainingReward

/**
 * A reward the CALLER computed, with the gate applied on top.
 *
 * Several published exporters accept a `rewardOf` hook so a consumer can drive
 * training off a verifiable signal instead of the headline judge score. That is
 * a real feature and the gate does not remove it — but a reward derived from a
 * gamed run is a gamed reward whatever its source, so it falls to 0 exactly
 * like the score it replaced.
 *
 * It lives here because the same hook exists under the same name in two
 * modules, and for a while only one of them gated it: `rl/exporters.toGrpoRows`
 * forced a gated run to 0 while `rl/preferences.extractPreferences` handed the
 * caller's number straight through, which put a gamed run on the CHOSEN side of
 * every DPO pair against its honest sibling. Two same-named hooks with
 * different gating behaviour was the defect; one implementation is the fix.
 *
 * `null` means "no reward" and is preserved: a non-finite or absent value is a
 * gap, and a gap is not a zero.
 */
export function trainingRewardOverride(record: Scored, value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return isRealnessGated(record) ? 0 : value
}

/**
 * The two fields a rollout line's `outcome` has to state TOGETHER — the reward
 * and whether the authenticity gate fired on it.
 *
 * Stating them together is the point. `realness_gated` is optional on the wire,
 * so a producer that wrote `reward` and simply never thought about the flag
 * emitted a row on which `isLineRealnessGated` is structurally false — which is
 * how a second minting door existed for every supervisor and worker row without
 * anyone noticing it had never consulted the gate.
 */
export interface RolloutRewardFields {
  reward: number | null
  realness_gated: boolean
  /**
   * Whether a screen RAN, as distinct from its verdict. Omitted when the
   * producer cannot tell — see `unscreenedRewardFields` and the field's own doc
   * on `RolloutOutcome`.
   */
  realness_screened?: boolean
}

/**
 * `trainingReward` in the line's own field names — what `mintRolloutRows`
 * writes onto every row it produces.
 *
 * `realness_screened: true` is written only when the record actually carries an
 * `outcome.realness` verdict, i.e. a screen genuinely ran and reported. A
 * record without one gets the field OMITTED rather than `false`: the record
 * cannot distinguish "the screen ran elsewhere and this pipeline did not record
 * it" from "no screen exists", and `false` is a load-bearing claim that
 * `assertMinted` refuses on. Absent = unknown, which is the truth here.
 */
export function rolloutRewardFields(record: Scored): RolloutRewardFields {
  const { reward, gated } = trainingReward(record)
  const screened = record.outcome.realness !== undefined
  return { reward, realness_gated: gated, ...(screened ? { realness_screened: true } : {}) }
}

/**
 * The same fields for a producer that has a graded score but NO `RunRecord`
 * behind it — a supervision journal, a harness session store, any second
 * intake. There is no `outcome.realness` to consult, so no authenticity screen
 * has run on this score.
 *
 * `realness_gated: false` alone was the WRONG way to say that. `false` is the
 * gate's VERDICT, and a verdict is a claim that somebody looked; on this path
 * nobody did, so the row asserted "screened and clean" about a score that had
 * never been screened at all — indistinguishable on the wire from a genuinely
 * clean one, which is exactly what an adversary needs. The two claims are now
 * carried by two fields:
 *
 *   - `realness_screened: false` — no screen ran. Explicit, not inferable from
 *     absence, and impossible to read as "clean" because it is not the gate's
 *     verdict field.
 *   - `realness_gated: false` — no gate fired, which is trivially true when no
 *     gate ran, and is what a consumer filtering on the flag expects to see.
 *
 * `assertMinted` REFUSES a line carrying `realness_screened: false` with a
 * reward above zero, so these rows can be written, read, reported and analysed,
 * but a positive one cannot become training data until something screens it.
 *
 * A separate function from `rolloutRewardFields` on purpose: picking this one
 * is a producer declaring that its rewards were never screened.
 */
export function unscreenedRewardFields(score: number | null): RolloutRewardFields {
  return { reward: score, realness_gated: false, realness_screened: false }
}
