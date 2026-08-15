/**
 * Certify a result that has no answer key.
 *
 * Run with: pnpm tsx examples/verify-without-an-answer-key/index.ts
 *
 * A held-out test suite is one member of a family of ten verification
 * strategies, not the family itself. Each member has a documented way it can
 * certify a wrong result. This example reads those failure modes, then runs
 * the blind two-arm statement-equivalence protocol against an injected
 * checker.
 */

import {
  type EquivalenceArm,
  type EquivalenceChecker,
  defineEquivalenceCheck,
  runEquivalenceCheck,
  VERIFICATION_STRATEGIES,
} from '../../src/index'

for (const member of ['test', 'proof-kernel', 'agreement'] as const) {
  const profile = VERIFICATION_STRATEGIES[member]
  console.log(`${member.padEnd(13)} ${profile.determinism.padEnd(14)} ${profile.failureMode}`)
}

// The formal claim two people are asked to state, independently.
const definition = defineEquivalenceCheck({
  source: 'proof-kernel',
  artifact: 'arXiv:1507.05650 inequality (4.6)',
  arms: 2,
  blind: true,
})

const arms: [EquivalenceArm, EquivalenceArm] = [
  {
    armId: 'from-the-paper',
    statement: 'theorem bcww (x y : Real) : x * y <= (x ^ 2 + y ^ 2) / 2',
    derivedFrom: 'the published LaTeX source',
    blindness: { toOtherArms: true, toOutcome: true },
  },
  {
    armId: 'from-the-artifacts',
    statement: 'theorem bcww (a b : Real) : a * b <= (a ^ 2 + b ^ 2) / 2',
    derivedFrom: "the campaign's produced artifacts",
    blindness: { toOtherArms: true, toOutcome: true },
  },
]

/**
 * The package ships the port, never the checker. A real binding runs a proof
 * assistant here and returns its kernel's answer. This stand-in accepts the
 * two statements when they differ only by bound-variable names.
 */
const checker: EquivalenceChecker = {
  strategy: 'proof-kernel',
  identity: { name: 'example-alpha-equivalence', version: '0.0.0' },
  determinism: 'deterministic',
  async check({ statements }) {
    const normalize = (s: string) => s.replace(/\b[a-z]\b/g, '_')
    const equivalent = normalize(statements[0]) === normalize(statements[1])
    if (!equivalent) {
      return {
        succeeded: true,
        value: {
          status: 'refuted-with-separating-witness',
          separatingWitness: 'the two statements disagree outside bound-variable names',
          evidenceDigest: `sha256:${'1'.repeat(64)}`,
        },
      }
    }
    return {
      succeeded: true,
      value: {
        status: 'proved',
        evidenceDigest: `sha256:${'0'.repeat(64)}`,
      },
    }
  },
}

const agreed = await runEquivalenceCheck(definition, arms, checker)
console.log('agreeing arms: ', agreed.obligation.status)
console.log('checker:       ', agreed.obligation.checker?.name)

// The interesting outcome. Arm B stated a strict inequality, so the two arms
// never verified the same claim. A refutation is a successful check: it is
// the formalization gap made visible, with a witness in hand.
const divergent: [EquivalenceArm, EquivalenceArm] = [
  arms[0],
  { ...arms[1], statement: 'theorem bcww (a b : Real) : a * b < (a ^ 2 + b ^ 2) / 2' },
]
const refuted = await runEquivalenceCheck(definition, divergent, checker)
console.log('divergent arms:', refuted.obligation.status)
console.log('witness:       ', refuted.obligation.separatingWitness)
