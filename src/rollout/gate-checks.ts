/**
 * THE canonical list of anti-Goodhart gate checks, plus the TOTAL policy every
 * entry point has to declare over it.
 *
 * Four rounds of adversarial review found the same defect four times, and it
 * was never the check itself: it was the COMPOSITION. `validateRolloutLine`
 * composed one check, `assertMinted` composed two, `assertRewardGate` composed
 * two of the three, `assertGateReport` composed its own pair — each by hand, in
 * its own file. So a check added to the package applied wherever its author
 * happened to remember, and the guard that forgot it looked exactly like the
 * guard that didn't. The last leak was literally that: `assertRewardGate`
 * composed `reward-relationship` + `gated-evidence` and not `unscreened-reward`,
 * so a never-screened positive reward that `assertMinted` correctly REFUSED
 * walked through all four waist exporters at full value.
 *
 * The fix is to make hand-composition impossible rather than to add a third
 * call to the two places that had two:
 *
 *   - `GATE_CHECKS` is a TOTAL map over `GateCheckId`. A new id with no
 *     implementation does not compile.
 *   - `GatePolicy` is a TOTAL map over `GateCheckId`. Every entry point
 *     declares one, so a new id makes EVERY entry point's policy a type error
 *     until it is wired. Wiring it means writing `enforced`, `repairedBy(...)`
 *     or `omittedBecause(...)` — and the last two force a written reason, so a
 *     silent gap is not expressible.
 *   - every check carries a `tripwire`: the minimal outcome it must refuse.
 *     `gate-checks.test.ts` feeds each tripwire to every entry point that
 *     declares `enforced` and requires a rejection, so wiring a check to the
 *     wrong disposition is a TEST failure even when it type-checks.
 *
 * Adding a check is therefore: append the id, write the check, and the compiler
 * enumerates every place that has to decide about it.
 */

import type { GatedEvidence, RolloutOutcome, RolloutStep } from './schema'

/**
 * Every gate check in the package, in the order they are applied.
 *
 * Order is load-bearing only for which message a caller sees first: a line that
 * trips two checks reports the earlier one, and `reward-relationship` is first
 * because it is the invariant the other three protect.
 */
export const GATE_CHECK_IDS = [
  'reward-relationship',
  'gated-evidence',
  'undeclared-step-payload',
  'unscreened-reward',
] as const

export type GateCheckId = (typeof GATE_CHECK_IDS)[number]

/**
 * An outcome as it reaches a check.
 *
 * Deliberately accepts a raw record as well as the typed shape: the checks are
 * the RUNTIME half of the gate, and the callers they exist for — JSON off a
 * ledger, a plain-JavaScript consumer of the published package — arrive with no
 * types at all. `Partial` because a tripwire states only the fields it trips on.
 */
export type GateCheckedOutcome = Partial<RolloutOutcome> | Readonly<Record<string, unknown>>

/**
 * What a gate check reads: the reward-bearing surface of ONE LINE.
 *
 * For three rounds the subject was the OUTCOME alone, and that assumption is
 * what produced the next leak rather than any missing check: `steps[]` sits on
 * the LINE, outside `outcome`, so a per-step reward on a gated line was read by
 * no check at all while `toRewardRows` copied it out verbatim — through the
 * MINTED door, not merely the raw one. Widening the subject is what makes
 * "somewhere else on the line" a place the checks can see.
 *
 * `outcome` is REQUIRED, and that is the point: a bare `RolloutOutcome` is then
 * not assignable to a subject, so every call site that used to pass one is a
 * COMPILE error until it passes the line instead. A subject with an optional
 * `outcome` would have let the old call sites keep compiling while silently
 * checking nothing — the exact failure this module exists to make impossible.
 */
export interface GateSubject {
  outcome: GateCheckedOutcome
  /** The line's trajectory steps, when it carries any. */
  steps?: unknown
}

/** One untyped field read off the outcome, so every check narrows from the same place. */
const field = (subject: GateSubject, name: string): unknown =>
  (subject.outcome as Readonly<Record<string, unknown>>)?.[name]

export interface GateCheck {
  id: GateCheckId
  /** One sentence: what this check refuses. */
  refuses: string
  /** One dotted-path message per defect; `[]` when the line is clean. */
  errors: (subject: GateSubject) => string[]
  /**
   * Every minimal subject that MUST trip `errors` — the executable form of
   * `refuses`, and the reason a check cannot be added without being provable.
   * The calibration test feeds each one to every entry point declaring
   * `enforced`.
   *
   * A LIST rather than one case: a check that refuses two distinct populations
   * (a positive reward AND a reward it cannot read as a number) proved able to
   * hold for the first while silently passing the second, so each population
   * states its own tripwire and each is exercised separately.
   */
  tripwires: GateSubject[]
}

// ---------------------------------------------------------------------------
// Total readers. Every "is this positive?" / "is this populated?" question the
// checks ask goes through one of these.
// ---------------------------------------------------------------------------

/**
 * How the gate reads one `outcome.reward`.
 *
 * TOTAL over `unknown`, with an explicit `unreadable` case, because the
 * recurring defect across four rounds was a hand-written type test whose
 * NEGATIVE branch silently passed: `typeof reward !== 'number' || !(reward > 0)`
 * returned "clean" for `reward: "0.95"`, so a plain-JavaScript producer that
 * stringifies its numbers — the exact population the runtime backstop exists
 * for — shipped a gamed run at full value through three waist exporters.
 *
 * A value the gate cannot read as a number is not evidence the reward is
 * cleared; it is the absence of that evidence, and the gate fails closed on it.
 */
export type RewardReading =
  /** `null`/`undefined` — a labeled gap, which is never a positive signal. */
  | { kind: 'absent' }
  /** A number at or below zero: the gate's own verdict, applied. */
  | { kind: 'cleared' }
  /** A number above zero, `Infinity` and the 5e-324 denormal included. */
  | { kind: 'positive'; shown: string }
  /** Anything the wire format does not permit here, plus `NaN`. */
  | { kind: 'unreadable'; shown: string }

export function readReward(value: unknown): RewardReading {
  if (value === null || value === undefined) return { kind: 'absent' }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { kind: 'unreadable', shown: 'NaN' }
    return value > 0 ? { kind: 'positive', shown: String(value) } : { kind: 'cleared' }
  }
  return {
    kind: 'unreadable',
    shown: `${JSON.stringify(value) ?? String(value)} (${typeof value})`,
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Whether a reward-derived field carries anything at all.
 *
 * The previous emptiness test was `Object.keys(value).length > 0`, which reads
 * `[]` for a NUMBER, a BOOLEAN and the empty string — so `metrics: 0.95` on a
 * gated line counted as empty and shipped verbatim in the verifiers format's
 * per-rubric score dict. `Object.keys` being total over primitives is not the
 * same property as being CORRECT over them.
 *
 * The rule that has no such hole: only `undefined`, `null` and a record with no
 * keys are empty. Everything else is payload, whatever its type.
 */
export function payloadIsPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (isPlainRecord(value)) return Object.keys(value).length > 0
  return true
}

/**
 * Every key `tangle.rollout.v1` declares on a step, as a TOTAL map over the
 * interface: a field added to `RolloutStep` and not to this list does not
 * compile, so the list cannot silently fall behind the schema it mirrors.
 *
 * This is the producer's OWN classification, which is the only partition
 * `gatedEvidenceOf` accepts — a key-name heuristic ("strip anything matching
 * /reward|score/") holds until someone names a field `credit` and the next
 * per-step signal ships at full value.
 */
const DECLARED_STEP_KEYS: { readonly [K in keyof Required<RolloutStep>]: true } = {
  kind: true,
  name: true,
  input: true,
  output: true,
  status: true,
  durationMs: true,
  llm_call_count: true,
  prompt_token_ids: true,
  completion_token_ids: true,
  logprobs: true,
}

/**
 * The part of `steps` the wire format has no name for — a per-step reward, a
 * per-step score, whatever a producer decided to hang there.
 *
 * `undefined` when the steps carry nothing undeclared.
 */
export function undeclaredStepPayload(steps: unknown): unknown {
  if (steps === undefined || steps === null) return undefined
  // The format says `steps` is a list. Anything else is wholly unclassified.
  if (!Array.isArray(steps)) return steps
  const extras: Array<Record<string, unknown>> = []
  let found = false
  for (const step of steps) {
    const extra: Record<string, unknown> = {}
    if (isPlainRecord(step)) {
      for (const [key, value] of Object.entries(step)) {
        if (key in DECLARED_STEP_KEYS) continue
        extra[key] = value
        found = true
      }
    } else if (step !== undefined && step !== null) {
      // A step that is not even a record carries no declared key to keep.
      extras.push({ step } as Record<string, unknown>)
      found = true
      continue
    }
    extras.push(extra)
  }
  return found ? extras : undefined
}

/** `steps` projected down to the keys the wire format declares. */
export function declaredSteps(steps: unknown): RolloutStep[] | undefined {
  if (!Array.isArray(steps)) return undefined
  const kept: RolloutStep[] = []
  for (const step of steps) {
    if (!isPlainRecord(step)) continue
    const projected: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(step)) {
      if (key in DECLARED_STEP_KEYS) projected[key] = value
    }
    kept.push(projected as unknown as RolloutStep)
  }
  return kept
}

/**
 * THE anti-Goodhart invariant, checked as a RELATIONSHIP between two fields
 * rather than as two independent type checks.
 *
 * Everything upstream of a training export is allowed to be wrong; this is the
 * one thing that cannot be. `realness_gated: true` means the run faked its
 * success signal, so its reward is a fabrication, and a fabrication above zero
 * is precisely what a trainer would learn to reproduce. Validating only that
 * `reward` is a number and `realness_gated` is a boolean is what let a line
 * claiming `{reward: 0.95, realness_gated: true}` validate clean and walk
 * through every exporter.
 */
const rewardRelationship: GateCheck = {
  id: 'reward-relationship',
  refuses: 'a positive — or unreadable — reward on a line the authenticity screen flagged as gamed',
  tripwires: [
    { outcome: { reward: 0.95, realness_gated: true } },
    // The second population, stated separately because the check held for the
    // first while passing this one for a full round.
    { outcome: { reward: '0.95' as unknown as number, realness_gated: true } },
  ],
  errors: (subject) => {
    if (field(subject, 'realness_gated') !== true) return []
    const reading = readReward(field(subject, 'reward'))
    if (reading.kind === 'absent' || reading.kind === 'cleared') return []
    if (reading.kind === 'unreadable') {
      return [
        `outcome.reward: ${reading.shown} with outcome.realness_gated: true — the wire format ` +
          'declares this field `number | null`, so the gate cannot read this value as a number ' +
          'and cannot establish that the reward was cleared. On a run flagged as gamed that is ' +
          'not evidence of a zero, it is the absence of it, and a consumer that coerces the ' +
          'value (`"0.95"`, `"2"`) reads a positive reward off a faked success. Emit a number ' +
          'or null — `trainingReward` / `trainingScore` from `rollout/reward.ts` produce one.',
      ]
    }
    return [
      `outcome.reward: ${reading.shown} with outcome.realness_gated: true — a run flagged as ` +
        'gamed may not carry a positive reward. The anti-Goodhart gate forces the reward to 0 (a ' +
        'real verdict: the gate decided) before the line is written, so a fine-tune cannot learn ' +
        'from a faked success. Derive the reward with `trainingReward` / `trainingScore` from ' +
        '`rollout/reward.ts`, or drop the line.',
    ]
  },
}

/**
 * The reward-bearing outcome fields that are NOT the scalar: the numbers the
 * reward was computed from, and the verdict record that claimed it.
 *
 * Returned as one block rather than filtered key-by-key. A key-name heuristic
 * ("zero anything matching `layer.*` or `/score/`") is the same defect shape as
 * the line-oriented regex the AST score guard replaced: it holds until someone
 * names a metric `pass_fraction`, and the next reward-shaped key ships at full
 * value. The producer's OWN classification — "this is the scalar, that is
 * everything else" — is the only partition that cannot be out-guessed.
 */
export function gatedEvidenceOf(subject: GateSubject): GatedEvidence | undefined {
  const evidence: GatedEvidence = {}
  // `payloadIsPopulated`, not an inline key count: a plain-JavaScript caller can
  // hand any value here, and a non-record `metrics` is still reward-derived
  // payload. See that function for the primitives an `Object.keys` test missed.
  const metrics = field(subject, 'metrics')
  if (payloadIsPopulated(metrics)) evidence.metrics = metrics as Record<string, unknown>
  const verdict = field(subject, 'verdict')
  if (verdict !== null && verdict !== undefined) evidence.verdict = verdict
  const steps = undeclaredStepPayload(subject.steps)
  if (steps !== undefined) evidence.steps = steps
  return evidence.metrics === undefined && evidence.verdict === undefined && steps === undefined
    ? undefined
    : evidence
}

/**
 * The invariant is about the OUTCOME, not about one field of it.
 *
 * `mintRolloutRows` bulk-copied `RunRecord.outcome.raw` into `outcome.metrics`
 * with no gate, so a gated run exported `reward: 0` (correct) while the
 * deterministic per-layer scores that reward was COMPUTED FROM — the `layer.*`
 * keys `rl/verifiable-reward.ts` calls the RL training signal — shipped at 1.0,
 * in the top-level `metrics` dict of the Prime Intellect verifiers format, which
 * IS that format's per-rubric score dict. `verdict` leaks the same way into
 * `toRftItem`'s `reference.verdict`, where a grader author reads
 * `resolved: true` off a run that faked it.
 */
const gatedEvidence: GateCheck = {
  id: 'gated-evidence',
  refuses: 'the numbers a fabricated reward was computed from, riding along at reward 0',
  tripwires: [
    { outcome: { reward: 0, realness_gated: true, metrics: { 'layer.tests': 1 } } },
    // A PRIMITIVE `metrics`: `Object.keys(0.95)` is `[]`, so the emptiness test
    // this check used to run reported it clean and the verifiers format shipped
    // it as its per-rubric score dict.
    { outcome: { reward: 0, realness_gated: true, metrics: 0.95 as unknown as never } },
  ],
  errors: (subject) => {
    if (field(subject, 'realness_gated') !== true) return []
    const evidence = gatedEvidenceOf(subject)
    if (evidence === undefined) return []
    // Each check reports only the fields it owns; `steps` is `undeclared-step-payload`.
    if (evidence.metrics === undefined && evidence.verdict === undefined) return []
    const path = evidence.metrics !== undefined ? 'outcome.metrics' : 'outcome.verdict'
    return [
      `${path} is populated with outcome.realness_gated: true — a run flagged as gamed may not ` +
        'ship the numbers its fabricated reward was computed from, even at reward 0. The ' +
        'per-layer scores in `metrics` ARE the reward signal in the verifiers format, and ' +
        '`verdict` is the record that claimed the success. Mint through `assertMinted`, which ' +
        'relocates both to `provenance.gated_evidence` (see `gateGamedOutcome`), or drop the line.',
    ]
  },
}

/**
 * A reward-bearing field hung on `steps[]`, where the gate was not looking.
 *
 * The first three checks all read `outcome`, so the whole apparatus was blind to
 * anything a producer wrote elsewhere on the line — and `toRewardRows` emits
 * `steps` verbatim beside the scalar it just forced to 0. A generated corpus
 * found it in twenty cases: a gated line carrying
 * `steps: [{kind, name, reward: 0.86}]` exported `{"reward": 0, "steps":
 * [{"reward": 0.86}]}`, which is the per-step credit assignment of a run that
 * faked its success, at full value, through the MINTED door.
 *
 * `RolloutStep` declares ten keys and none of them is a reward, so the partition
 * needs no judgement call: whatever the format does not name is unclassified
 * payload, and on a gated line unclassified payload is exactly what the gate
 * refuses. `assertMinted` relocates it rather than rejecting, like the sibling
 * check, so an already-published ledger stays readable.
 */
const undeclaredStepPayloadCheck: GateCheck = {
  id: 'undeclared-step-payload',
  refuses: 'per-step reward signal hung on a gated line’s steps, outside every field the gate read',
  tripwires: [
    {
      outcome: { reward: 0, realness_gated: true },
      steps: [{ kind: 'tool', name: 'edit', reward: 0.9 }],
    },
  ],
  errors: (subject) => {
    if (field(subject, 'realness_gated') !== true) return []
    const extra = undeclaredStepPayload(subject.steps)
    if (extra === undefined) return []
    return [
      `steps[] carries fields \`${ROLLOUT_SCHEMA_NAME}\` does not declare (${JSON.stringify(extra).slice(0, 120)}) ` +
        'with outcome.realness_gated: true — a per-step reward is training signal exactly like ' +
        'the scalar, and the exporters copy `steps` through verbatim, so zeroing `outcome.reward` ' +
        'while leaving it in place ships the gamed run’s step-level credit assignment at full ' +
        'value. Mint through `assertMinted`, which projects the steps down to the declared keys ' +
        'and relocates the rest to `provenance.gated_evidence.steps` (see `gateGamedOutcome`).',
    ]
  },
}

/** Named here rather than imported, so `gate-checks` stays free of schema cycles. */
const ROLLOUT_SCHEMA_NAME = 'tangle.rollout.v1'

/**
 * A positive reward whose producer DECLARED that no authenticity screen exists.
 *
 * `realness_gated: false` is the screen's VERDICT, so writing it with no screen
 * behind it claims "we looked and nothing fired" about a reward nobody looked
 * at. `realness_screened: false` is the producer saying so out loud, and a
 * positive reward carrying it is exactly the signal the gate exists to qualify
 * with nothing having qualified it.
 */
const unscreenedReward: GateCheck = {
  id: 'unscreened-reward',
  refuses: 'a positive reward whose producer declares that no authenticity screen ever ran',
  tripwires: [
    { outcome: { reward: 1, realness_gated: false, realness_screened: false } },
    {
      outcome: {
        reward: '2' as unknown as number,
        realness_gated: false,
        realness_screened: false,
      },
    },
  ],
  errors: (subject) => {
    if (field(subject, 'realness_screened') !== false) return []
    const reading = readReward(field(subject, 'reward'))
    if (reading.kind === 'absent' || reading.kind === 'cleared') return []
    return [
      `outcome.reward: ${reading.shown} with outcome.realness_screened: false — this producer declares ` +
        'that NO authenticity screen ran on this reward, so nothing has established the success ' +
        'is real, and an unscreened positive reward is exactly the signal the anti-Goodhart gate ' +
        'exists to qualify. Screen the run and write the verdict (`rolloutRewardFields` from a ' +
        '`RunRecord` carrying `outcome.realness`), or emit `reward: null` — an unqualified ' +
        'verdict is a labeled gap, not a measured success.',
    ]
  },
}

/**
 * The registry. Total over `GateCheckId`, so an id with no check does not
 * compile, and `GATE_CHECK_IDS` stays the single enumeration everything
 * iterates.
 */
export const GATE_CHECKS: { readonly [K in GateCheckId]: GateCheck } = {
  'reward-relationship': rewardRelationship,
  'gated-evidence': gatedEvidence,
  'undeclared-step-payload': undeclaredStepPayloadCheck,
  'unscreened-reward': unscreenedReward,
}

/**
 * What ONE entry point does about ONE check.
 *
 * `repair` and `omit` both carry a mandatory sentence, which is the mechanism
 * that keeps a legitimate omission distinguishable from a forgotten one: you
 * cannot skip a check without writing down why, and the reasons are readable
 * side by side in `GATE_POLICIES`.
 */
export type GateCheckDisposition =
  | { readonly kind: 'enforce' }
  /** Resolved by TRANSFORMING the line instead of rejecting it; `by` names the function. */
  | { readonly kind: 'repair'; readonly by: string }
  /** Deliberately not applied here; `because` states the reason. */
  | { readonly kind: 'omit'; readonly because: string }

export const enforced: GateCheckDisposition = { kind: 'enforce' }
export const repairedBy = (by: string): GateCheckDisposition => ({ kind: 'repair', by })
export const omittedBecause = (because: string): GateCheckDisposition => ({
  kind: 'omit',
  because,
})

/** Total over `GateCheckId`: a new check makes every policy literal a type error. */
export type GatePolicy = { readonly [K in GateCheckId]: GateCheckDisposition }

/**
 * Every entry point that decides about the gate, and what it decides.
 *
 * Read this as the package's gate policy in one screen. The four entry points
 * are not interchangeable — a validator that rejects, a mint funnel that
 * repairs, a runtime backstop for untyped callers, and a release certifier over
 * emitted rows — and the dispositions say which is which.
 */
export const GATE_POLICIES = {
  /**
   * The schema validator. Rejects the reward relationship and NOTHING ELSE, on
   * purpose: it runs on every line read off disk, and the other two conditions
   * describe artifacts that already exist.
   */
  validateRolloutLine: {
    // Stays a REJECTION rather than a transformation. A caller emitting
    // `{reward: 0.95, realness_gated: true}` is a producer defect and has to
    // fail loudly; laundering it into `reward: 0` here would hide the producer,
    // which is the actual bug.
    'reward-relationship': enforced,
    'gated-evidence': omittedBecause(
      'a ledger written before the relocation existed carries `metrics` on its gated lines; ' +
        'rejecting those would make every already-published artifact unreadable. The condition ' +
        'is REPAIRED at `assertMinted` (`gateGamedOutcome`) instead, which is the only door into ' +
        'the training path, so the artifact stays readable and the leak still closes.',
    ),
    'undeclared-step-payload': omittedBecause(
      'identical reasoning to `gated-evidence`, one field over: a foreign or pre-unification ' +
        'ledger may carry producer-invented keys on its steps, and refusing to READ those files ' +
        'buys nothing the relocation at `assertMinted` does not already buy. Promotion into ' +
        'training is where it closes.',
    ),
    'unscreened-reward': omittedBecause(
      'supervision-journal rows legitimately carry an unscreened positive reward (there is no ' +
        '`RunRecord.outcome.realness` behind them) and must stay writable, readable and ' +
        'reportable. Only PROMOTION into training is closed, at `assertMinted`.',
    ),
  },
  /**
   * The mint funnel — the single door every `MintedRolloutLine` passes. Validates
   * first (so the reward relationship has already been rejected), then refuses
   * what cannot be repaired, then repairs what can.
   */
  assertMinted: {
    // Re-run after `assertRolloutLine`, which already rejected it. Cheap, and it
    // makes this entry point independently complete rather than complete only
    // because of what it happens to call first.
    'reward-relationship': enforced,
    'gated-evidence': repairedBy('gateGamedOutcome'),
    'undeclared-step-payload': repairedBy('gateGamedOutcome'),
    'unscreened-reward': enforced,
  },
  /**
   * The runtime backstop, and the one entry point with no license to omit
   * anything: it exists for callers the type system never saw (plain JavaScript
   * handing an object literal to a published exporter), so a check it skips is a
   * check that does not run at all for them. This is where the fourth leak was.
   */
  assertRewardGate: {
    'reward-relationship': enforced,
    'gated-evidence': enforced,
    'undeclared-step-payload': enforced,
    'unscreened-reward': enforced,
  },
  /**
   * The release certifier. Same checks, measured over the rows a release is
   * ABOUT TO WRITE rather than over one line's outcome — see `REPORT_MEASURES`
   * in `release/gate-report.ts`, which is the second total map this policy
   * drives.
   */
  assertGateReport: {
    'reward-relationship': enforced,
    'gated-evidence': enforced,
    'undeclared-step-payload': enforced,
    'unscreened-reward': enforced,
  },
} as const satisfies Record<string, GatePolicy>

/** Every entry point that declares a gate policy. */
export type GateEntryPoint = keyof typeof GATE_POLICIES

/**
 * Run the checks one entry point enforces. The ONLY way an entry point should
 * obtain gate errors — hand-composing two of the three is the bug this module
 * exists to remove.
 */
export function gateErrors(subject: GateSubject, policy: GatePolicy): string[] {
  const errors: string[] = []
  for (const id of GATE_CHECK_IDS) {
    if (policy[id].kind !== 'enforce') continue
    errors.push(...GATE_CHECKS[id].errors(subject))
  }
  return errors
}
