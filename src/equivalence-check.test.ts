import { describe, expect, it, vi } from 'vitest'
import type {
  EquivalenceArm,
  EquivalenceChecker,
  EquivalenceCheckSpec,
  EquivalenceObligation,
} from './equivalence-check'
import {
  buildEquivalenceRecord,
  defineEquivalenceCheck,
  EquivalenceProtocolError,
  runEquivalenceCheck,
} from './equivalence-check'

// The BCWW pilot shape: arm A from the paper's LaTeX, arm B from the
// campaign's artifacts, both blind, kernel-checked equivalent.
const spec: EquivalenceCheckSpec = {
  source: 'proof-kernel',
  artifact: 'arXiv:1507.05650 inequality (4.6) + five-atom counterexample record',
  arms: 2,
  blind: true,
}

const armA: EquivalenceArm = {
  armId: 'A-paper',
  statement: 'theorem Ineq46 (v : Finset Party → ℝ) : ... -- from arXiv LaTeX display eqn:cd2',
  derivedFrom: 'arXiv:1507.05650 LaTeX source, display eqn:cd2',
  blindness: { toOtherArms: true, toOutcome: true },
}

const armB: EquivalenceArm = {
  armId: 'B-campaign',
  statement: 'def CampaignTestedInequality : Prop := ∀ p, IsPMF p → bcwwL p ≤ 0',
  derivedFrom: 'discovery-lab KB pages + standalone verifier source',
  blindness: { toOtherArms: true, toOutcome: true },
}

const kernelEvidenceDigest =
  'sha256:aa11bb22cc33dd44ee55ff667788990011223344556677889900aabbccddeeff'

const provedObligation: EquivalenceObligation = {
  status: 'proved',
  checker: { name: 'lean4', version: '4.33.0', pins: { mathlib: 'db584cd6d46c' } },
  evidenceDigest: kernelEvidenceDigest,
}

const kernelChecker = (
  outcome: Awaited<ReturnType<EquivalenceChecker['check']>>,
): EquivalenceChecker => ({
  strategy: 'proof-kernel',
  identity: { name: 'lean4', version: '4.33.0', pins: { mathlib: 'db584cd6d46c' } },
  determinism: 'deterministic',
  check: vi.fn(async () => outcome),
})

const expectRefusal = (fn: () => unknown, code: EquivalenceProtocolError['code']): void => {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(EquivalenceProtocolError)
  expect((thrown as EquivalenceProtocolError).code).toBe(code)
}

describe('defineEquivalenceCheck', () => {
  it('accepts and freezes the two-arm blind spec', () => {
    const definition = defineEquivalenceCheck(spec)
    expect(definition.spec).toEqual(spec)
    expect(Object.isFrozen(definition.spec)).toBe(true)
  })

  it('refuses any arm count other than 2 — an N-arm design is a different protocol', () => {
    expectRefusal(() => defineEquivalenceCheck({ ...spec, arms: 3 as unknown as 2 }), 'arm-count')
  })

  it('refuses blind: false — a non-blind run is no check at all', () => {
    expectRefusal(
      () => defineEquivalenceCheck({ ...spec, blind: false as unknown as true }),
      'not-blind',
    )
  })

  it('refuses an empty artifact and an unknown strategy source', () => {
    expectRefusal(() => defineEquivalenceCheck({ ...spec, artifact: '  ' }), 'empty-field')
    expectRefusal(
      () =>
        defineEquivalenceCheck({
          ...spec,
          source: 'vibes' as unknown as EquivalenceCheckSpec['source'],
        }),
      'unknown-source',
    )
  })
})

describe('buildEquivalenceRecord — the record the pilot produced by hand', () => {
  it('assembles the two blind statements + proved obligation, and round-trips through JSON', () => {
    const definition = defineEquivalenceCheck(spec)
    const record = buildEquivalenceRecord(definition, [armA, armB], provedObligation)

    expect(record.arms[0].derivedFrom).toContain('arXiv')
    expect(record.arms[1].derivedFrom).toContain('discovery-lab')
    expect(record.obligation.status).toBe('proved')
    expect(record.obligation.checker.pins?.mathlib).toBe('db584cd6d46c')

    const revived = JSON.parse(JSON.stringify(record)) as typeof record
    expect(revived).toEqual(record)
  })

  it('refuses an arm that saw the other statement — the check is invalid, not weaker', () => {
    const definition = defineEquivalenceCheck(spec)
    const peeked: EquivalenceArm = { ...armB, blindness: { toOtherArms: false, toOutcome: true } }
    expectRefusal(
      () => buildEquivalenceRecord(definition, [armA, peeked], provedObligation),
      'arm-saw-other',
    )
  })

  it('refuses an arm that saw the outcome before committing', () => {
    const definition = defineEquivalenceCheck(spec)
    const steered: EquivalenceArm = { ...armA, blindness: { toOtherArms: true, toOutcome: false } }
    expectRefusal(
      () => buildEquivalenceRecord(definition, [steered, armB], provedObligation),
      'arm-saw-outcome',
    )
  })

  it('refuses duplicate arm ids and empty statements', () => {
    const definition = defineEquivalenceCheck(spec)
    expectRefusal(
      () =>
        buildEquivalenceRecord(
          definition,
          [armA, { ...armB, armId: armA.armId }],
          provedObligation,
        ),
      'duplicate-arm-id',
    )
    expectRefusal(
      () =>
        buildEquivalenceRecord(definition, [{ ...armA, statement: ' ' }, armB], provedObligation),
      'empty-field',
    )
  })

  it('refuses a refutation without its separating witness', () => {
    const definition = defineEquivalenceCheck(spec)
    expectRefusal(
      () =>
        buildEquivalenceRecord(definition, [armA, armB], {
          ...provedObligation,
          status: 'refuted-with-separating-witness',
        }),
      'witness-missing',
    )
  })

  it('refuses a proof carrying a separating witness — the two claims contradict', () => {
    const definition = defineEquivalenceCheck(spec)
    expectRefusal(
      () =>
        buildEquivalenceRecord(definition, [armA, armB], {
          ...provedObligation,
          separatingWitness: 'uniform distribution on atoms {1,2,3,7,8}',
        }),
      'witness-on-proved',
    )
  })

  it('refuses an unresolved obligation with no reason, and a proved one with no evidence digest', () => {
    const definition = defineEquivalenceCheck(spec)
    expectRefusal(
      () =>
        buildEquivalenceRecord(definition, [armA, armB], {
          status: 'unresolved',
          checker: provedObligation.checker,
        }),
      'reason-missing',
    )
    expectRefusal(
      () =>
        buildEquivalenceRecord(definition, [armA, armB], {
          status: 'proved',
          checker: provedObligation.checker,
        }),
      'evidence-missing',
    )
  })

  it('accepts a refutation with its witness — a statement mismatch is a successful outcome', () => {
    const definition = defineEquivalenceCheck(spec)
    const record = buildEquivalenceRecord(definition, [armA, armB], {
      status: 'refuted-with-separating-witness',
      separatingWitness: 'entropy vector v with S_AB flipped in sign between the two statements',
      checker: provedObligation.checker,
      evidenceDigest: kernelEvidenceDigest,
    })
    expect(record.obligation.separatingWitness).toContain('S_AB')
  })
})

describe('runEquivalenceCheck — execution binds through the strategy-checker port', () => {
  it('discharges a proved obligation from a succeeded checker outcome', async () => {
    const definition = defineEquivalenceCheck(spec)
    const checker = kernelChecker({
      succeeded: true,
      value: { status: 'proved', evidenceDigest: kernelEvidenceDigest },
    })
    const record = await runEquivalenceCheck(definition, [armA, armB], checker)
    expect(record.obligation.status).toBe('proved')
    expect(record.obligation.checker.name).toBe('lean4')
    expect(checker.check).toHaveBeenCalledWith({
      artifact: spec.artifact,
      statements: [armA.statement, armB.statement],
    })
  })

  it('records a checker failure as unresolved WITH the full error text — never a silent verdict', async () => {
    const definition = defineEquivalenceCheck(spec)
    const checker = kernelChecker({
      succeeded: false,
      error: 'lake build failed: unknown package store path',
    })
    const record = await runEquivalenceCheck(definition, [armA, armB], checker)
    expect(record.obligation.status).toBe('unresolved')
    expect(record.obligation.unresolvedReason).toContain('lake build failed')
  })

  it('refuses a checker whose strategy differs from the spec source, before the checker runs', async () => {
    const definition = defineEquivalenceCheck(spec)
    const judge: EquivalenceChecker = {
      ...kernelChecker({
        succeeded: true,
        value: { status: 'proved', evidenceDigest: kernelEvidenceDigest },
      }),
      strategy: 'judge',
    }
    await expect(runEquivalenceCheck(definition, [armA, armB], judge)).rejects.toMatchObject({
      code: 'checker-strategy-mismatch',
    })
    expect(judge.check).not.toHaveBeenCalled()
  })

  it('refuses a non-blind arm before spending anything on the checker', async () => {
    const definition = defineEquivalenceCheck(spec)
    const checker = kernelChecker({
      succeeded: true,
      value: { status: 'proved', evidenceDigest: kernelEvidenceDigest },
    })
    const peeked: EquivalenceArm = { ...armB, blindness: { toOtherArms: false, toOutcome: true } }
    await expect(runEquivalenceCheck(definition, [armA, peeked], checker)).rejects.toMatchObject({
      code: 'arm-saw-other',
    })
    expect(checker.check).not.toHaveBeenCalled()
  })
})
