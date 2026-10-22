import { describe, expect, it, vi } from 'vitest'
import { type DefaultVerdict, type VerdictCertification } from './verdict'
import type {
  CheckerOutcome,
  EquivalenceArm,
  EquivalenceChecker,
  EquivalenceCheckSpec,
  VerificationStrategySource,
} from './verification-strategy'
import {
  defineEquivalenceCheck,
  EquivalenceProtocolError,
  runEquivalenceCheck,
  VERIFICATION_STRATEGIES,
  VERIFICATION_STRATEGY_SOURCES,
} from './verification-strategy'

// The BCWW pilot's kernel certification, verbatim shape: lean4 + Mathlib
// pin, the one prose-argued assumption, the evidence digest.
const kernelCertification: VerdictCertification = {
  strategy: 'proof-kernel',
  checker: { name: 'lean4', version: '4.33.0', pins: { mathlib: 'db584cd6d46c' } },
  assumptions: ['diagonal embedding (classical → quantum) argued in prose, not formalized'],
  evidenceDigest: 'sha256:1f4c9d2ab0e6c3a5d7f80b1e2c4a6d8f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
}

const judgeCertification: VerdictCertification = {
  strategy: 'judge',
  checker: { name: 'claude-fable-5', version: '2026-08' },
  assumptions: ['judge shares the graded policy model family'],
  evidenceDigest: 'sha256:9e8d7c6b5a493827161504f3e2d1c0b9a8f7e6d5c4b3a2918070605040302010',
}

describe('verification-strategy family', () => {
  it('carries the four open-family members and the six answer-key members, exactly', () => {
    expect([...VERIFICATION_STRATEGY_SOURCES].sort()).toEqual(
      [
        'compile',
        'test',
        'schema',
        'sandbox',
        'judge',
        'composite',
        'proof-kernel',
        'invariant',
        'replication',
        'agreement',
      ].sort(),
    )
  })

  it('documents a failure mode for every member — no member is exempt from having one', () => {
    for (const source of VERIFICATION_STRATEGY_SOURCES) {
      const profile = VERIFICATION_STRATEGIES[source]
      expect(
        profile.failureMode.length,
        `${source} must document its failure mode`,
      ).toBeGreaterThan(10)
      expect(['deterministic', 'probabilistic', 'inherited']).toContain(profile.determinism)
    }
  })

  it('keeps the deterministic/probabilistic axis: kernel-class members deterministic, agreement and judge probabilistic', () => {
    expect(VERIFICATION_STRATEGIES['proof-kernel'].determinism).toBe('deterministic')
    expect(VERIFICATION_STRATEGIES.invariant.determinism).toBe('deterministic')
    expect(VERIFICATION_STRATEGIES.replication.determinism).toBe('deterministic')
    expect(VERIFICATION_STRATEGIES.agreement.determinism).toBe('probabilistic')
    expect(VERIFICATION_STRATEGIES.judge.determinism).toBe('probabilistic')
    expect(VERIFICATION_STRATEGIES.composite.determinism).toBe('inherited')
  })

  it('checker outcomes are a discriminated union: the error is only reachable on failure', () => {
    const pass: CheckerOutcome<{ theorem: string }> = {
      succeeded: true,
      value: { theorem: 'statement_equivalence' },
    }
    const fail: CheckerOutcome<{ theorem: string }> = {
      succeeded: false,
      error: 'kernel timeout after 300s in Check.lean',
    }
    for (const outcome of [pass, fail]) {
      if (outcome.succeeded) {
        expect(outcome.value.theorem).toBe('statement_equivalence')
      } else {
        expect(outcome.error).toContain('kernel timeout')
      }
    }
  })
})

describe('verdict certification', () => {
  it('round-trips through JSON without loss', () => {
    const verdict: DefaultVerdict = {
      valid: true,
      score: 1,
      notes: 'kernel-checked equivalence',
      certification: kernelCertification,
    }
    const revived = JSON.parse(JSON.stringify(verdict)) as DefaultVerdict
    expect(revived).toEqual(verdict)
    expect(revived.certification?.checker.pins?.mathlib).toBe('db584cd6d46c')
    expect(revived.certification?.assumptions).toHaveLength(1)
  })

  it('a kernel-certified and a judge-certified verdict are distinguishable by a consumer that cares', () => {
    const kernelVerdict: DefaultVerdict = {
      valid: true,
      score: 1,
      certification: kernelCertification,
    }
    const judgeVerdict: DefaultVerdict = {
      valid: true,
      score: 1,
      certification: judgeCertification,
    }

    // Identical on the pre-epistemics surface…
    expect(kernelVerdict.valid).toBe(judgeVerdict.valid)
    expect(kernelVerdict.score).toBe(judgeVerdict.score)

    // …separable on the certification, down to the checker identity.
    const weight = (v: DefaultVerdict): 'kernel-grade' | 'judge-grade' | 'uncertified' => {
      if (v.certification === undefined) return 'uncertified'
      return v.certification.strategy === 'proof-kernel' ? 'kernel-grade' : 'judge-grade'
    }
    expect(weight(kernelVerdict)).toBe('kernel-grade')
    expect(weight(judgeVerdict)).toBe('judge-grade')
    expect(weight({ valid: true, score: 1 })).toBe('uncertified')
    expect(kernelVerdict.certification?.checker.name).not.toBe(
      judgeVerdict.certification?.checker.name,
    )
  })

  it('is invisible to a consumer that does not read it', () => {
    // A consumer written against the bare shape: reads valid + score only.
    const indifferentConsumer = (v: DefaultVerdict): number => (v.valid ? v.score : 0)

    // An old-shape literal still satisfies DefaultVerdict — the field is additive.
    const preExisting: DefaultVerdict = { valid: true, score: 0.5, notes: 'no certification' }
    const certified: DefaultVerdict = {
      valid: true,
      score: 0.5,
      certification: kernelCertification,
    }

    expect(indifferentConsumer(preExisting)).toBe(0.5)
    expect(indifferentConsumer(certified)).toBe(0.5)
  })

  it('the failure mode of the certifying strategy is queryable from the certification alone', () => {
    const surfaced = VERIFICATION_STRATEGIES[kernelCertification.strategy].failureMode
    expect(surfaced).toContain('formalization gap')
  })
})

describe('open union — existing consumers compile unchanged', () => {
  it('every answer-key literal remains assignable next to the four open-family members', () => {
    const sources: VerificationStrategySource[] = [
      'compile',
      'test',
      'schema',
      'sandbox',
      'judge',
      'composite',
      'proof-kernel',
      'invariant',
      'replication',
      'agreement',
    ]
    expect(new Set(sources).size).toBe(10)
  })
})

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


