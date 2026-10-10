import { describe, expect, it } from 'vitest'
import {
  addCalibrationVerdicts,
  assertJudgeMayGate,
  type CalibrationExample,
  inMemorySentinelStore,
  type JudgeCalibrationSet,
  JudgeGateRefusedError,
  type JudgeRun,
  judgeGateDecision,
  measureJudgeAgreement,
  registerCalibrationSet,
  snapshotFromJudgeAgreement,
} from './index'

const AT = '2026-10-09T12:00:00.000Z'

function example(id: string, verdict: 'pass' | 'fail', extra: Partial<CalibrationExample> = {}) {
  return {
    id,
    verdict,
    labeledBy: 'owner',
    labeledAt: '2026-10-08T00:00:00.000Z',
    source: `asset_decision:${id}`,
    ...extra,
  } satisfies CalibrationExample
}

/** Ten owner rejections and one approval, the shape of a real ad-critic set. */
const critic: JudgeCalibrationSet = {
  judgeId: 'ad-critic',
  owner: 'owner',
  examples: [
    example('approved-1', 'pass'),
    ...Array.from({ length: 10 }, (_, i) => example(`rejected-${i}`, 'fail')),
  ],
}
const meta = { judgeId: 'ad-critic', judgeModel: 'gemini-x', rubricVersion: 'r2', measuredAt: AT }

function everyRunAgrees(runs: number): JudgeRun[] {
  return critic.examples.flatMap((item) =>
    Array.from({ length: runs }, () => ({
      exampleId: item.id,
      verdict: item.verdict,
      samples: [item.verdict, item.verdict, item.verdict],
    })),
  )
}

describe('measureJudgeAgreement', () => {
  it('reports full agreement on every run with κ 1 and no variance', () => {
    const agreement = measureJudgeAgreement(critic, everyRunAgrees(3), meta)
    expect(agreement).toMatchObject({
      examples: 11,
      judged: 11,
      judgedByVerdict: { pass: 1, fail: 10 },
      runs: 33,
      accuracy: 1,
      kappa: 1,
      confusion: { truePass: 3, trueFail: 30, falsePass: 0, falseFail: 0 },
      variance: { betweenRuns: 0, withinRun: 0, unstable: [] },
      disagreements: [],
      unjudged: [],
    })
    // Eleven independent examples bound accuracy loosely even at 11 of 11.
    expect(agreement.exampleAccuracy?.agreed).toBe(11)
    expect(agreement.exampleAccuracy?.interval.lower).toBeLessThan(0.75)
    expect(agreement.exampleAccuracy?.interval.upper).toBe(1)
  })

  it('computes Cohen κ from the pass/fail table', () => {
    // Owner: 25 pass, 25 fail. Judge passes 20 of the owner's passes and 10 of its fails.
    const set = {
      judgeId: 'j',
      owner: 'o',
      examples: [
        ...Array.from({ length: 25 }, (_, i) => example(`p${i}`, 'pass')),
        ...Array.from({ length: 25 }, (_, i) => example(`f${i}`, 'fail')),
      ],
    }
    const runs: JudgeRun[] = [
      ...Array.from(
        { length: 25 },
        (_, i) => ({ exampleId: `p${i}`, verdict: i < 20 ? 'pass' : 'fail' }) as const,
      ),
      ...Array.from(
        { length: 25 },
        (_, i) => ({ exampleId: `f${i}`, verdict: i < 10 ? 'pass' : 'fail' }) as const,
      ),
    ]
    const agreement = measureJudgeAgreement(set, runs, { ...meta, judgeId: 'j' })
    // p_o = 35/50 = 0.7; p_e = 0.6·0.5 + 0.4·0.5 = 0.5; κ = 0.2 / 0.5 = 0.4.
    expect(agreement.accuracy).toBeCloseTo(0.7, 10)
    expect(agreement.kappa).toBeCloseTo(0.4, 10)
    expect(agreement.confusion).toEqual({ truePass: 20, trueFail: 15, falsePass: 10, falseFail: 5 })
    expect(agreement.disagreements).toHaveLength(15)
  })

  it('separates run-to-run flips from sample spread inside a run', () => {
    const runs: JudgeRun[] = [
      { exampleId: 'approved-1', verdict: 'pass', samples: ['pass', 'pass', 'fail'] },
      { exampleId: 'approved-1', verdict: 'fail', samples: ['fail', 'fail', 'pass'] },
      { exampleId: 'rejected-0', verdict: 'fail' },
    ]
    const agreement = measureJudgeAgreement(critic, runs, meta)
    // approved-1 passed 1 of 2 runs (0.25); rejected-0 never moved (0).
    expect(agreement.variance.betweenRuns).toBeCloseTo(0.125, 10)
    // Both sampled runs split 2:1, p(1 − p) = 2/9.
    expect(agreement.variance.withinRun).toBeCloseTo(2 / 9, 10)
    expect(agreement.variance.unstable).toEqual(['approved-1'])
    expect(agreement.disagreements.map((item) => item.id)).toEqual(['approved-1'])
    expect(agreement.unjudged).toHaveLength(9)
  })

  it('leaves κ undefined when both sides used one verdict', () => {
    const set = { judgeId: 'j', owner: 'o', examples: [example('a', 'fail'), example('b', 'fail')] }
    const agreement = measureJudgeAgreement(
      set,
      [
        { exampleId: 'a', verdict: 'fail' },
        { exampleId: 'b', verdict: 'fail' },
      ],
      { ...meta, judgeId: 'j' },
    )
    expect(agreement.accuracy).toBe(1)
    expect(agreement.kappa).toBeNull()
  })

  it('refuses a run on an example outside the set instead of dropping it', () => {
    expect(() =>
      measureJudgeAgreement(critic, [{ exampleId: 'missing', verdict: 'pass' }], meta),
    ).toThrow(/not in "ad-critic"'s calibration set/)
    expect(() => measureJudgeAgreement(critic, [], { ...meta, judgeId: 'other' })).toThrow(
      /belongs to "ad-critic"/,
    )
  })
})

describe('registerCalibrationSet and addCalibrationVerdicts', () => {
  it('requires provenance and unique ids', () => {
    expect(() =>
      registerCalibrationSet({ ...critic, examples: [example('a', 'pass', { source: '' })] }),
    ).toThrow(/source must be a non-empty string/)
    expect(() =>
      registerCalibrationSet({ ...critic, examples: [example('a', 'pass'), example('a', 'fail')] }),
    ).toThrow(/duplicate example id "a"/)
    expect(() =>
      registerCalibrationSet({
        ...critic,
        examples: [example('a', 'pass', { labeledAt: 'yesterday' })],
      }),
    ).toThrow(/labeledAt is not a parseable ISO timestamp/)
  })

  it("is idempotent per source and keeps the owner's latest verdict", () => {
    const first = addCalibrationVerdicts({ ...critic, examples: [] }, [example('a', 'pass')])
    expect(first.added).toEqual(['a'])
    const again = addCalibrationVerdicts(first.set, [example('a', 'pass')])
    expect(again).toMatchObject({ added: [], superseded: [], unchanged: ['a'] })
    const changed = addCalibrationVerdicts(again.set, [
      example('a', 'fail', { source: 'asset_decision:a-2', labeledAt: '2026-10-09T00:00:00.000Z' }),
    ])
    expect(changed.superseded).toEqual(['a'])
    expect(changed.set.examples).toEqual([
      example('a', 'fail', { source: 'asset_decision:a-2', labeledAt: '2026-10-09T00:00:00.000Z' }),
    ])
    const stale = addCalibrationVerdicts(changed.set, [
      example('a', 'pass', { source: 'asset_decision:a-0', labeledAt: '2026-10-01T00:00:00.000Z' }),
    ])
    expect(stale.unchanged).toEqual(['a'])
    expect(stale.set.examples[0]?.verdict).toBe('fail')
  })
})

describe('judgeGateDecision', () => {
  const calibrated = measureJudgeAgreement(critic, everyRunAgrees(3), meta)
  const gate = { judgeId: 'ad-critic', judgeModel: 'gemini-x', rubricVersion: 'r2', asOf: AT }

  it('lets a measured judge gate', () => {
    const decision = judgeGateDecision({ ...gate, agreement: calibrated })
    expect(decision).toMatchObject({ mayGate: true, status: 'calibrated', reasons: [] })
    expect(() => assertJudgeMayGate(decision)).not.toThrow()
  })

  it('refuses an unmeasured judge, a changed model or rubric, and an expired report', () => {
    expect(judgeGateDecision({ ...gate, agreement: null })).toMatchObject({
      mayGate: false,
      status: 'uncalibrated',
      reasons: ['no measured agreement with owner verdicts'],
    })
    const moved = judgeGateDecision({
      ...gate,
      judgeModel: 'gemini-y',
      rubricVersion: 'r3',
      agreement: calibrated,
    })
    expect(moved.status).toBe('uncalibrated')
    expect(moved.reasons).toEqual([
      'agreement was measured on model gemini-x; the judge now runs gemini-y',
      'agreement was measured on rubric r2; the judge now runs r3',
    ])
    const expired = judgeGateDecision({
      ...gate,
      asOf: '2026-11-20T12:00:00.000Z',
      agreement: calibrated,
    })
    expect(expired.reasons).toEqual(['agreement is 42.0 days old (limit 30)'])
  })

  it('refuses a judge with too few decided examples of either verdict', () => {
    const rejectionsOnly = measureJudgeAgreement(
      critic,
      everyRunAgrees(1).filter((run) => run.exampleId !== 'approved-1'),
      meta,
    )
    const decision = judgeGateDecision({ ...gate, agreement: rejectionsOnly })
    expect(decision.status).toBe('uncalibrated')
    expect(decision.reasons).toEqual([
      '0 judged examples the owner marked pass; at least 1 required',
    ])
    expect(
      judgeGateDecision({ ...gate, agreement: rejectionsOnly, policy: { minExamples: 20 } })
        .reasons[0],
    ).toBe('10 judged examples; at least 20 required')
  })

  it('refuses a judge below the agreement floors', () => {
    const runs = everyRunAgrees(1).map((run, index) =>
      index < 2
        ? { ...run, verdict: run.verdict === 'pass' ? ('fail' as const) : ('pass' as const) }
        : run,
    )
    const weak = measureJudgeAgreement(critic, runs, meta)
    const decision = judgeGateDecision({ ...gate, agreement: weak })
    expect(decision.status).toBe('below-threshold')
    expect(decision.reasons).toEqual(['accuracy 81.8% is below 90.0%', 'kappa -0.10 is below 0.6'])
    expect(() => assertJudgeMayGate(decision)).toThrow(JudgeGateRefusedError)
    try {
      assertJudgeMayGate(decision)
    } catch (error) {
      expect((error as JudgeGateRefusedError).decision).toBe(decision)
    }
  })

  it('refuses a judge whose recorded agreement drifted down', async () => {
    const store = inMemorySentinelStore()
    await store.append(
      snapshotFromJudgeAgreement({ ...calibrated, measuredAt: '2026-10-01T00:00:00.000Z' }),
    )
    await store.append({
      at: '2026-10-05T00:00:00.000Z',
      judgeId: 'ad-critic',
      judgeModel: 'gemini-x',
      metrics: { sentinelPassRate: 0.8, calibrationKappa: 0.7 },
    })
    await store.append(snapshotFromJudgeAgreement(calibrated))
    // Back at full agreement today: the series baseline is the oldest snapshot, so no alarm.
    expect(
      judgeGateDecision({ ...gate, agreement: calibrated, history: await store.history() }).status,
    ).toBe('calibrated')

    const decayed = inMemorySentinelStore([
      snapshotFromJudgeAgreement({ ...calibrated, measuredAt: '2026-10-01T00:00:00.000Z' }),
      {
        at: AT,
        judgeId: 'ad-critic',
        judgeModel: 'gemini-x',
        metrics: { sentinelPassRate: 0.85, calibrationKappa: 0.62 },
      },
    ])
    const decision = judgeGateDecision({
      ...gate,
      agreement: { ...calibrated, accuracy: 0.92, kappa: 0.7 },
      history: await decayed.history(),
    })
    expect(decision.status).toBe('drifted')
    expect(decision.reasons.join('\n')).toMatch(
      /calibrationKappa dropped 0\.380 from baseline 1\.000/,
    )
    expect(decision.reasons.join('\n')).toMatch(
      /sentinelPassRate dropped 0\.150 from baseline 1\.000/,
    )
  })
})

describe('veto judges', () => {
  // Owners reject for reasons a copy check never sees, so its misses are expected; blocking what they approved is not.
  const owner = {
    judgeId: 'copy-check',
    owner: 'o',
    examples: [
      ...Array.from({ length: 12 }, (_, i) => example(`p${i}`, 'pass')),
      ...Array.from({ length: 8 }, (_, i) => example(`f${i}`, 'fail')),
    ],
  }
  const vetoMeta = { ...meta, judgeId: 'copy-check', judgeModel: 'deterministic' }
  const vetoGate = {
    judgeId: 'copy-check',
    judgeModel: 'deterministic',
    rubricVersion: 'r2',
    asOf: AT,
    policy: { decides: 'veto' as const },
  }

  it('may gate while it blocks little of what the owner passed, however many owner rejections it misses', () => {
    const runs: JudgeRun[] = [
      ...Array.from(
        { length: 12 },
        (_, i) => ({ exampleId: `p${i}`, verdict: i === 0 ? 'fail' : 'pass' }) as const,
      ),
      ...Array.from(
        { length: 8 },
        (_, i) => ({ exampleId: `f${i}`, verdict: i < 2 ? 'fail' : 'pass' }) as const,
      ),
    ]
    const agreement = measureJudgeAgreement(owner, runs, vetoMeta)
    expect(agreement.falseFailRate).toBeCloseTo(1 / 12, 10)
    expect(agreement.catchRate).toBeCloseTo(2 / 8, 10)
    expect(agreement.accuracy).toBeCloseTo(13 / 20, 10)
    expect(judgeGateDecision({ ...vetoGate, agreement })).toMatchObject({
      mayGate: true,
      status: 'calibrated',
    })
    // The same table fails a deciding judge, which must reach the owner's verdict.
    expect(judgeGateDecision({ ...vetoGate, policy: {}, agreement }).status).toBe('below-threshold')
    expect(snapshotFromJudgeAgreement(agreement, { decides: 'veto' }).metrics).toEqual({
      sentinelPassRate: 11 / 12,
    })
  })

  it('needs owner passes to be measured, and refuses one that blocks them', () => {
    const rejectionsOnly = measureJudgeAgreement(
      owner,
      Array.from({ length: 8 }, (_, i) => ({ exampleId: `f${i}`, verdict: 'pass' as const })),
      vetoMeta,
    )
    expect(judgeGateDecision({ ...vetoGate, agreement: rejectionsOnly }).reasons).toEqual([
      '0 judged examples the owner marked pass; a veto judge needs at least 10',
    ])
    expect(() => snapshotFromJudgeAgreement(rejectionsOnly, { decides: 'veto' })).toThrow(
      /no runs on owner passes/,
    )
    const blocking = measureJudgeAgreement(
      owner,
      Array.from(
        { length: 12 },
        (_, i) => ({ exampleId: `p${i}`, verdict: i < 3 ? 'fail' : 'pass' }) as const,
      ),
      vetoMeta,
    )
    expect(judgeGateDecision({ ...vetoGate, agreement: blocking })).toMatchObject({
      status: 'below-threshold',
      reasons: ['it fails 25.0% of what the owner passed (limit 10.0%)'],
    })
  })
})

describe('snapshotFromJudgeAgreement', () => {
  it('records accuracy and κ, and omits an undefined κ', () => {
    const agreement = measureJudgeAgreement(critic, everyRunAgrees(1), meta)
    expect(snapshotFromJudgeAgreement(agreement)).toEqual({
      at: AT,
      judgeId: 'ad-critic',
      judgeModel: 'gemini-x',
      metrics: { sentinelPassRate: 1, calibrationKappa: 1 },
    })
    expect(snapshotFromJudgeAgreement({ ...agreement, kappa: null }).metrics).toEqual({
      sentinelPassRate: 1,
    })
    expect(() => snapshotFromJudgeAgreement({ ...agreement, runs: 0, accuracy: null })).toThrow(
      /no runs/,
    )
  })
})
