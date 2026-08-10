import { describe, expect, it } from 'vitest'
import type { DefaultVerdict, VerdictCertification } from './verdict'
import type { CheckerOutcome, VerificationStrategySource } from './verification-strategy'
import { VERIFICATION_STRATEGIES, VERIFICATION_STRATEGY_SOURCES } from './verification-strategy'

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
