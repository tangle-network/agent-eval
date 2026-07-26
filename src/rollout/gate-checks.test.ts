import { describe, expect, it } from 'vitest'
import { malformedRolloutLine } from './fixtures'
import {
  GATE_CHECK_IDS,
  GATE_CHECKS,
  GATE_POLICIES,
  type GateCheckId,
  type GateEntryPoint,
  type GateSubject,
  gateErrors,
  payloadIsPopulated,
  readReward,
} from './gate-checks'
import {
  assertMinted,
  assertRewardGate,
  type MintedRolloutLine,
  type RolloutOutcome,
  type RolloutStep,
  validateRolloutLine,
} from './schema'

/**
 * The mechanism suite: it does not test what the three checks say, it tests that
 * every entry point is FORCED to decide about every check.
 *
 * Four adversarial rounds all found the same defect — a guard that composed some
 * of the checks — and the reason it kept recurring is that composition was a
 * memory task performed independently in four files. The registry makes the
 * decision total at the type level; this suite makes it total at RUN time too,
 * because a cast (`as GatePolicy`) or a hand-written `Record<string, …>` can get
 * around the compiler and a silent gap is exactly what must not survive.
 */

/** A valid outcome, so a tripwire states only the fields it trips on. */
const CLEAN_OUTCOME: RolloutOutcome = {
  reward: 0,
  reward_source: 'judge',
  verdict: null,
  metrics: {},
  is_completed: true,
  is_truncated: false,
  error: null,
  realness_gated: false,
}

/** A full line carrying one tripwire's subject — outcome fields AND steps. */
const lineFrom = (subject: GateSubject): unknown =>
  malformedRolloutLine({
    outcome: { ...CLEAN_OUTCOME, ...(subject.outcome as Partial<RolloutOutcome>) },
    ...(subject.steps === undefined ? {} : { steps: subject.steps as RolloutStep[] }),
  })

/** The clean subject, for the "leaves a clean line alone" direction. */
const CLEAN_SUBJECT: GateSubject = { outcome: CLEAN_OUTCOME }

describe('the gate-check registry is total', () => {
  it('implements exactly the declared ids, each under its own key', () => {
    expect(Object.keys(GATE_CHECKS).sort()).toEqual([...GATE_CHECK_IDS].sort())
    for (const id of GATE_CHECK_IDS) expect(GATE_CHECKS[id].id).toBe(id)
  })

  it('gives every check a one-sentence statement of what it refuses', () => {
    for (const id of GATE_CHECK_IDS) expect(GATE_CHECKS[id].refuses.length).toBeGreaterThan(20)
  })

  it('gives every check at least one tripwire, and every tripwire trips it', () => {
    for (const id of GATE_CHECK_IDS) {
      const check = GATE_CHECKS[id]
      expect(check.tripwires.length, `${id} states no tripwire`).toBeGreaterThan(0)
      check.tripwires.forEach((tripwire, i) => {
        expect(
          check.errors(tripwire),
          `${id} tripwire[${i}] does not trip its own check`,
        ).not.toEqual([])
      })
    }
  })

  it('leaves a clean line alone under every check', () => {
    for (const id of GATE_CHECK_IDS) expect(GATE_CHECKS[id].errors(CLEAN_SUBJECT)).toEqual([])
  })

  /**
   * The hole every one of the four rounds had, stated once as a law.
   *
   * A check whose predicate is `typeof x === 'number' && x > 0` answers "clean"
   * for `"0.95"`, and the callers the runtime backstop exists for — plain
   * JavaScript, JSON off a ledger — are precisely the ones who send that. So no
   * check is allowed to read a value it cannot classify as anything.
   */
  it('never reads an unclassifiable reward as clean', () => {
    for (const unreadable of ['0.95', '2', true, {}, [], Number.NaN]) {
      expect(readReward(unreadable).kind, `${JSON.stringify(unreadable)} read as clean`).toBe(
        'unreadable',
      )
      expect(
        GATE_CHECKS['reward-relationship'].errors({
          outcome: { reward: unreadable as never, realness_gated: true },
        }),
        `a gated line carrying reward ${JSON.stringify(unreadable)} was admitted`,
      ).not.toEqual([])
    }
    // …while every value it CAN classify keeps its existing meaning.
    expect(readReward(0).kind).toBe('cleared')
    expect(readReward(-1).kind).toBe('cleared')
    expect(readReward(null).kind).toBe('absent')
    expect(readReward(undefined).kind).toBe('absent')
    expect(readReward(5e-324).kind).toBe('positive')
    expect(readReward(Number.POSITIVE_INFINITY).kind).toBe('positive')
  })

  it('never reads a non-record payload as empty', () => {
    // `Object.keys(0.95)` is `[]`, which is how a primitive `metrics` shipped.
    for (const populated of [0.95, 12, true, 'ab', '', [1], { a: 1 }]) {
      expect(payloadIsPopulated(populated), `${JSON.stringify(populated)} read as empty`).toBe(true)
    }
    for (const empty of [undefined, null, {}]) {
      expect(payloadIsPopulated(empty)).toBe(false)
    }
  })
})

describe('every entry point declares a disposition for every check', () => {
  const entryPoints = Object.keys(GATE_POLICIES) as GateEntryPoint[]

  it('covers the whole check list at run time, not just at compile time', () => {
    for (const entry of entryPoints) {
      expect(Object.keys(GATE_POLICIES[entry]).sort(), `${entry} policy is not total`).toEqual(
        [...GATE_CHECK_IDS].sort(),
      )
    }
  })

  it('forces every skipped check to say why, in a sentence', () => {
    for (const entry of entryPoints) {
      for (const id of GATE_CHECK_IDS) {
        const disposition = GATE_POLICIES[entry][id]
        if (disposition.kind === 'omit') {
          expect(disposition.because.length, `${entry}/${id} omits with no reason`).toBeGreaterThan(
            40,
          )
        }
        if (disposition.kind === 'repair') {
          expect(
            disposition.by.length,
            `${entry}/${id} repairs with no named repair`,
          ).toBeGreaterThan(0)
        }
      }
    }
  })

  it('leaves the runtime backstop with nothing skipped', () => {
    // `assertRewardGate` exists for callers the type system never saw, so a
    // check it skips is a check that does not run for them at all. This is the
    // exact hole the fourth round found: it composed two of the three.
    for (const id of GATE_CHECK_IDS) {
      expect(GATE_POLICIES.assertRewardGate[id].kind, `assertRewardGate skips ${id}`).toBe(
        'enforce',
      )
    }
  })
})

/**
 * The calibration that makes a forgotten wiring LOUD.
 *
 * For each check, each outcome-shaped entry point is fed a line carrying that
 * check's tripwire and must behave exactly as its declared disposition says.
 * Add a fourth check to `GATE_CHECK_IDS` and this table grows by three cases
 * automatically: `enforce` without an implementation that fires fails here, and
 * `omit`/`repair` on a check that actually still rejects fails here too.
 */
type EntryProbe = (line: unknown) => { rejected: boolean; message: string }

const OUTCOME_ENTRY_POINTS: Record<
  'validateRolloutLine' | 'assertMinted' | 'assertRewardGate',
  EntryProbe
> = {
  validateRolloutLine: (line) => {
    const errors = validateRolloutLine(line)
    return { rejected: errors.length > 0, message: errors.join('\n') }
  },
  assertMinted: (line) => {
    try {
      assertMinted(line)
      return { rejected: false, message: '' }
    } catch (err) {
      return { rejected: true, message: (err as Error).message }
    }
  },
  assertRewardGate: (line) => {
    try {
      // Cast on purpose: this entry point's whole reason to exist is the caller
      // the brand never reached, so the probe has to arrive the way they do.
      assertRewardGate(line as MintedRolloutLine, 'probe')
      return { rejected: false, message: '' }
    } catch (err) {
      return { rejected: true, message: (err as Error).message }
    }
  },
}

describe('each entry point does what its policy says, check by check', () => {
  const entries = Object.keys(OUTCOME_ENTRY_POINTS) as Array<keyof typeof OUTCOME_ENTRY_POINTS>
  // EVERY tripwire, not one per check: a check that refuses two populations held
  // for the first and passed the second for a whole round.
  const cases = entries.flatMap((entry) =>
    GATE_CHECK_IDS.flatMap((id) =>
      GATE_CHECKS[id].tripwires.map((tripwire, i) => ({ entry, id, i, tripwire })),
    ),
  )

  it.each(cases)('$entry — $id [$i]', ({ entry, id, tripwire }) => {
    const disposition = GATE_POLICIES[entry][id]
    const line = lineFrom(tripwire)
    const probe = OUTCOME_ENTRY_POINTS[entry](line)
    const gateMessage = GATE_CHECKS[id].errors(tripwire)[0]!

    // Some tripwires are ALSO schema-invalid — `reward: "0.95"` violates
    // `number|null`, and that is the point of them: the runtime backstop has no
    // schema validation in front of it, so it is the only entry point where a
    // plain-JavaScript caller's value reaches a check at all. At the entry
    // points that DO validate first, the schema legitimately rejects them
    // before the gate is consulted, so the assertion below is about the REASON
    // and never merely about whether something threw.
    const schemaValid = validateRolloutLine(line).every((e) => e === gateMessage)

    if (disposition.kind === 'enforce') {
      expect(probe.rejected, `${entry} declares it enforces ${id} but admitted its tripwire`).toBe(
        true,
      )
      if (schemaValid) {
        // Rejected for THIS reason, not incidentally by some other check.
        expect(probe.message).toContain(gateMessage)
      }
    } else {
      expect(
        probe.message,
        `${entry} declares it ${disposition.kind}s ${id} but rejected its tripwire for that reason`,
      ).not.toContain(gateMessage)
      if (schemaValid) {
        expect(
          probe.rejected,
          `${entry} declares it ${disposition.kind}s ${id} but rejected a schema-valid tripwire`,
        ).toBe(false)
      }
    }
  })

  it('repairs rather than rejects, and the repair actually removes the payload', () => {
    // The one non-`enforce` disposition that has to DO something: `assertMinted`
    // relocates the gated evidence instead of refusing the line, so an already
    // published ledger stays readable and still cannot leak.
    expect(GATE_POLICIES.assertMinted['gated-evidence']).toEqual({
      kind: 'repair',
      by: 'gateGamedOutcome',
    })
    const minted = assertMinted(lineFrom(GATE_CHECKS['gated-evidence'].tripwires[0]!))
    expect(minted.outcome.metrics).toEqual({})
    expect(minted.provenance.gated_evidence?.metrics).toEqual({ 'layer.tests': 1 })
  })

  it('relocates the undeclared per-step payload and keeps the trajectory', () => {
    expect(GATE_POLICIES.assertMinted['undeclared-step-payload']).toEqual({
      kind: 'repair',
      by: 'gateGamedOutcome',
    })
    const minted = assertMinted(lineFrom(GATE_CHECKS['undeclared-step-payload'].tripwires[0]!))
    // The step SURVIVES — a gamed trajectory is the labeled example a gaming
    // detector trains on — with only the undeclared reward field taken off it.
    expect(minted.steps).toEqual([{ kind: 'tool', name: 'edit' }])
    expect(minted.provenance.gated_evidence?.steps).toEqual([{ reward: 0.9 }])
  })
})

describe('gateErrors runs the policy, not a hand-written list', () => {
  it('reports only what the policy enforces', () => {
    const subject: GateSubject = {
      outcome: { ...CLEAN_OUTCOME, reward: 1, realness_screened: false },
    }
    // The validator deliberately lets a supervision-journal row through…
    expect(gateErrors(subject, GATE_POLICIES.validateRolloutLine)).toEqual([])
    // …and the training-path doors deliberately do not.
    expect(gateErrors(subject, GATE_POLICIES.assertMinted)).toHaveLength(1)
    expect(gateErrors(subject, GATE_POLICIES.assertRewardGate)).toHaveLength(1)
  })

  it('accumulates every enforced check that fires, not just the first', () => {
    const both: Partial<RolloutOutcome> = {
      reward: 0.95,
      realness_gated: true,
      metrics: { 'layer.tests': 1 },
    }
    expect(
      gateErrors(
        { outcome: { ...CLEAN_OUTCOME, ...both }, steps: [{ kind: 'tool', name: 'e', reward: 1 }] },
        GATE_POLICIES.assertRewardGate,
      ),
    ).toHaveLength(3)
  })

  /**
   * The subject is the LINE, not the outcome — proved behaviourally, because the
   * type-level half (`GateSubject.outcome` being required) is what stops a stale
   * call site compiling, and this is what stops a NEW one passing the outcome
   * inside a correctly-shaped subject and losing `steps` again.
   */
  it('reads fields that live outside `outcome`', () => {
    const gated = { ...CLEAN_OUTCOME, realness_gated: true }
    expect(gateErrors({ outcome: gated }, GATE_POLICIES.assertRewardGate)).toEqual([])
    expect(
      gateErrors(
        { outcome: gated, steps: [{ kind: 'tool', name: 'edit', reward: 0.9 }] },
        GATE_POLICIES.assertRewardGate,
      ),
    ).toHaveLength(1)
  })
})

/**
 * `GATE_CHECK_IDS` is the enumeration everything iterates, so it is also the
 * thing a future author edits. This pins the current membership: adding an id
 * here is a deliberate act that shows up in a diff next to the four policies it
 * forces open.
 */
describe('the canonical list', () => {
  it('is exactly the checks the package enforces today', () => {
    const ids: GateCheckId[] = [
      'reward-relationship',
      'gated-evidence',
      'undeclared-step-payload',
      'unscreened-reward',
    ]
    expect([...GATE_CHECK_IDS]).toEqual(ids)
  })
})
