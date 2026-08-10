import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/errors'
import { admitRow } from '../../src/trace-repair/admission-contract'
import {
  assertDeterministicOracle,
  NondeterministicOracleError,
  type OracleAssertionResult,
  type OracleDeterminismEvidence,
  type OracleReplicateGroup,
  oracleDeterminism,
  SUITE_REWARD_UNIT,
  taskOracleRegistry,
} from '../../src/trace-repair/oracle-determinism'
import { admissionEvidence, flakyOracle, step } from './fixtures'

const STEPS = [
  step(1, 'ls /app', { returncode: 0, output: 'main.py' }),
  step(2, 'python /app/main.py', { returncode: 1, output: 'Traceback' }),
]

function evidence(
  groups: readonly OracleReplicateGroup[],
  taskName = 'largest-eigenval',
): OracleDeterminismEvidence {
  return {
    taskName,
    image: 'registry.example/task@sha256:pinned',
    suiteDigest: 'suite-digest',
    measuredAt: '2026-08-10T00:00:00.000Z',
    groups,
  }
}

/** One replicate per element of `outcomes`; each element lists its assertions. */
function group(
  outcomes: readonly (readonly OracleAssertionResult[] | null)[],
  state: OracleReplicateGroup['state'] = 'solved',
  load: OracleReplicateGroup['load'] = 'idle',
): OracleReplicateGroup {
  return {
    state,
    load,
    replicates: outcomes.map((assertions, index) => {
      const passed = assertions === null || assertions.every((a) => a.passed)
      return { index, reward: passed ? '1' : '0', passed, wallMs: 10, assertions }
    }),
  }
}

const PASS: readonly OracleAssertionResult[] = [
  { id: 'suite.py::test_a', passed: true },
  { id: 'suite.py::test_b', passed: true },
]

describe('a verdict that is a function of the state', () => {
  it('reports a zero flip rate when every unit agreed', () => {
    const verdict = oracleDeterminism(evidence([group([PASS, PASS, PASS])]))
    expect(verdict.stable).toBe(true)
    expect(verdict.flipRate).toBe(0)
    expect(verdict.replicates).toBe(3)
    expect(verdict.byState[0]?.granularity).toBe('per-assertion')
  })

  it('sees an assertion that flipped even when the suite reward never moved', () => {
    // The shape a wall-clock assertion produces at a state far from its
    // threshold: the conjunction fails every time, one term does not.
    const stuck = { id: 'suite.py::test_correct', passed: false }
    const failing = [stuck, { id: 'suite.py::test_speedup[6]', passed: false }]
    const flipped = [stuck, { id: 'suite.py::test_speedup[6]', passed: true }]
    const verdict = oracleDeterminism(evidence([group([failing, failing, flipped, failing])]))
    expect(verdict.byState[0]?.passes).toBe(0)
    expect(verdict.byState[0]?.fails).toBe(4)
    expect(verdict.byState[0]?.rewardsObserved).toEqual(['0'])
    expect(verdict.stable).toBe(false)
    expect(verdict.flipRate).toBe(0.25)
    expect(verdict.byState[0]?.flipped).toEqual([
      { unit: 'suite.py::test_speedup[6]', passes: 1, fails: 3, flipRate: 0.25 },
    ])
  })

  it('counts an assertion missing from some replicates as a flip of the suite shape', () => {
    const verdict = oracleDeterminism(
      evidence([group([PASS, [{ id: 'suite.py::test_a', passed: true }]])]),
    )
    expect(verdict.stable).toBe(false)
    expect(verdict.byState[0]?.assertionSetUnstable).toEqual(['suite.py::test_b'])
  })

  it('falls back to the reward when a replicate published no summary, and says so', () => {
    const verdict = oracleDeterminism(evidence([group([PASS, null, PASS])]))
    expect(verdict.byState[0]?.granularity).toBe('reward')
    expect(verdict.stable).toBe(true)
    const flipping = oracleDeterminism(
      evidence([
        {
          state: 'solved',
          load: 'idle',
          replicates: [
            { index: 0, reward: '1', passed: true, wallMs: 10, assertions: null },
            { index: 1, reward: '0', passed: false, wallMs: 10, assertions: null },
          ],
        },
      ]),
    )
    expect(flipping.byState[0]?.flipped[0]?.unit).toBe(SUITE_REWARD_UNIT)
    expect(flipping.stable).toBe(false)
  })

  it('pools the loads on one state, so unanimity on an idle box does not certify a task', () => {
    const verdict = oracleDeterminism(
      evidence([
        group([PASS, PASS, PASS], 'solved', 'idle'),
        group([PASS, [{ id: 'suite.py::test_a', passed: false }, PASS[1]!]], 'solved', 'contended'),
      ]),
    )
    expect(verdict.stable).toBe(false)
    expect(verdict.byState[0]?.loadSensitive).toBe(true)
    expect(verdict.byState[0]?.replicates).toBe(5)
  })

  it('keeps every raw reward it saw, including a missing one', () => {
    const verdict = oracleDeterminism(
      evidence([
        {
          state: 'solved',
          load: 'idle',
          replicates: [
            { index: 0, reward: '1', passed: true, wallMs: 10, assertions: PASS },
            { index: 1, reward: null, passed: false, wallMs: 10, assertions: PASS },
          ],
        },
      ]),
    )
    expect(verdict.byState[0]?.rewardsObserved).toEqual(['1', 'NO_REWARD_FILE'])
  })

  it('refuses a group too small to show a flip', () => {
    expect(() => oracleDeterminism(evidence([group([PASS])]))).toThrow(ValidationError)
    expect(() => oracleDeterminism(evidence([]))).toThrow(/no replicate group/)
  })

  it('refuses a registry that certifies one task twice', () => {
    const verdict = oracleDeterminism(evidence([group([PASS, PASS])]))
    expect(() => taskOracleRegistry([verdict, verdict])).toThrow(/twice/)
  })

  it('throws with the flip rate named', () => {
    const unstable = oracleDeterminism(
      evidence([
        group([
          [{ id: 'suite.py::t', passed: true }],
          [{ id: 'suite.py::t', passed: false }],
        ]),
      ]),
    )
    expect(() => assertDeterministicOracle(unstable)).toThrow(NondeterministicOracleError)
    expect(() => assertDeterministicOracle(unstable)).toThrow(/50\.0 % over 2 replicates/)
    expect(() =>
      assertDeterministicOracle(oracleDeterminism(evidence([group([PASS, PASS])]))),
    ).not.toThrow()
  })
})

describe('a task whose grader is not a function of the state cannot admit a row', () => {
  it('rejects before the prefix, the end state, or the controls are read', () => {
    const decision = admitRow(
      admissionEvidence({
        steps: STEPS,
        oracleDeterminism: flakyOracle('largest-eigenval'),
        // Everything else about this row would admit it.
        prefixFidelity: { stepsReplayed: 2, divergences: 0 },
        endStatePassed: false,
      }),
    )
    expect(decision).toMatchObject({
      admitted: false,
      rejection: 'task-oracle-nondeterministic',
    })
    if (decision.admitted) throw new Error('unreachable')
    expect(decision.detail).toMatch(/largest-eigenval/)
    expect(decision.screening.oracleStable).toBe(false)
    expect(decision.screening.oracleFlipRate).toBeGreaterThan(0)
  })

  it('admits the same row once the task certifies stable', () => {
    expect(admitRow(admissionEvidence({ steps: STEPS })).admitted).toBe(true)
  })

  it('refuses a certification measured on a different task', () => {
    expect(() =>
      admitRow(
        admissionEvidence({
          steps: STEPS,
          taskName: 'largest-eigenval',
          oracleDeterminism: oracleDeterminism(evidence([group([PASS, PASS])], 'some-other-task')),
        }),
      ),
    ).toThrow(/carries the oracle certification for some-other-task/)
  })
})
