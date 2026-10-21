import { describe, expect, it } from 'vitest'

import {
  GATE_CHECK_IDS,
  GATE_POLICIES,
  type GateCheckId,
  type GateEntryPoint,
} from './gate-checks'


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
