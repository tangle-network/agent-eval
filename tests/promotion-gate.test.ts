import { describe, expect, it } from 'vitest'
import { bootstrapCi, judgeReplayGate } from '../src/promotion-gate'

describe('bootstrapCi', () => {
  it('returns INCONCLUSIVE when sample count is below threshold', () => {
    const r = bootstrapCi([1, 2], [3], { minTotalSamples: 6 })
    expect(r.verdict).toBe('INCONCLUSIVE')
    expect(r.iterations).toBe(0)
  })

  it('returns INCONCLUSIVE when one side is empty', () => {
    const r = bootstrapCi([], [1, 2, 3], {})
    expect(r.verdict).toBe('INCONCLUSIVE')
  })

  it('detects clear wins as ADVANCE', () => {
    // Both arms carry real spread: CONSTANT arms make every resample identical
    // and the interval a point, which is refused (see the zero-width case).
    const baseline = [4, 5, 5, 6, 4, 5, 5, 6]
    const candidate = [8, 9, 9, 10, 8, 9, 9, 10]
    const r = bootstrapCi(baseline, candidate, { iterations: 500, seed: 42 })
    expect(r.verdict).toBe('ADVANCE')
    expect(r.delta).toBe(4)
    expect(r.ciLower).toBeGreaterThan(0)
  })

  it('detects clear regressions as REVERT', () => {
    const baseline = [8, 9, 9, 10, 8, 9, 9, 10]
    const candidate = [4, 5, 5, 6, 4, 5, 5, 6]
    const r = bootstrapCi(baseline, candidate, { iterations: 500, seed: 42 })
    expect(r.verdict).toBe('REVERT')
    expect(r.ciUpper).toBeLessThan(0)
  })

  it('refuses a ZERO-WIDTH interval rather than calling it a clear win', () => {
    // Constant arms make every resample identical, so the interval is a point
    // and carries no information about how far the estimate could be wrong.
    // Worst on pass/fail data, where it is the NORMAL shape rather than an edge
    // case: three failures against three passes clears the six-sample floor and
    // yields [1, 1] — an "ADVANCE" bought with no spread at all.
    const constant = bootstrapCi([5, 5, 5, 5, 5, 5, 5, 5], [9, 9, 9, 9, 9, 9, 9, 9], {
      iterations: 500,
      seed: 42,
    })
    expect(constant.ciLower).toBe(constant.ciUpper)
    expect(constant.verdict).toBe('INCONCLUSIVE')

    const passFail = bootstrapCi([0, 0, 0], [1, 1, 1], { iterations: 500, seed: 42 })
    expect(passFail.ciLower).toBe(1)
    expect(passFail.ciUpper).toBe(1)
    expect(passFail.verdict).toBe('INCONCLUSIVE')
  })

  it('returns KEEP for neutral overlapping distributions', () => {
    const baseline = [5, 6, 5, 6, 5, 6, 5, 6]
    const candidate = [5, 6, 5, 6, 5, 6, 5, 6]
    const r = bootstrapCi(baseline, candidate, { iterations: 500, seed: 1 })
    // Verdict depends on tiny numerical jitter — accept KEEP or INCONCLUSIVE
    expect(['KEEP', 'INCONCLUSIVE']).toContain(r.verdict)
  })

  it('is deterministic given the same seed', () => {
    const baseline = [5, 6, 7, 8]
    const candidate = [6, 7, 8, 9]
    const r1 = bootstrapCi(baseline, candidate, { iterations: 200, seed: 12345 })
    const r2 = bootstrapCi(baseline, candidate, { iterations: 200, seed: 12345 })
    expect(r1.ciLower).toBe(r2.ciLower)
    expect(r1.ciUpper).toBe(r2.ciUpper)
    expect(r1.verdict).toBe(r2.verdict)
  })

  it('respects alpha — wider CI at smaller alpha', () => {
    const baseline = [3, 4, 5, 6, 7, 8]
    const candidate = [4, 5, 6, 7, 8, 9]
    const r95 = bootstrapCi(baseline, candidate, { iterations: 500, alpha: 0.05, seed: 1 })
    const r99 = bootstrapCi(baseline, candidate, { iterations: 500, alpha: 0.01, seed: 1 })
    expect(r99.ciUpper - r99.ciLower).toBeGreaterThanOrEqual(r95.ciUpper - r95.ciLower)
  })
})

describe('judgeReplayGate', () => {
  it('routes scored outputs through bootstrapCi and reports verdict', async () => {
    const judge = (output: { score: number }) => output.score
    const r = await judgeReplayGate({
      baselineOutputs: [4, 5, 5, 6, 4, 5, 5, 6].map((score) => ({ score })),
      candidateOutputs: [8, 9, 9, 10, 8, 9, 9, 10].map((score) => ({ score })),
      judge,
      iterations: 500,
      seed: 1,
    })
    expect(r.verdict).toBe('ADVANCE')
    expect(r.baselineSamples).toBe(8)
    expect(r.candidateSamples).toBe(8)
  })

  it('honours async judge functions', async () => {
    const judge = async (output: { x: number }) => {
      await new Promise((r) => setTimeout(r, 1))
      return output.x
    }
    const r = await judgeReplayGate({
      baselineOutputs: [{ x: 1 }, { x: 2 }, { x: 1 }, { x: 2 }],
      candidateOutputs: [{ x: 5 }, { x: 6 }, { x: 5 }, { x: 6 }],
      judge,
      iterations: 200,
      seed: 1,
    })
    expect(r.verdict).toBe('ADVANCE')
  })

  it('respects judgeConcurrency limit', async () => {
    let inflight = 0
    let peak = 0
    const judge = async (_: number) => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((r) => setTimeout(r, 5))
      inflight--
      return 5
    }
    await judgeReplayGate({
      baselineOutputs: [1, 2, 3, 4, 5, 6, 7, 8],
      candidateOutputs: [1, 2, 3, 4, 5, 6, 7, 8],
      judge,
      iterations: 100,
      seed: 1,
      judgeConcurrency: 2,
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('coerces non-finite judge outputs to 0', async () => {
    const judge = () => NaN
    const r = await judgeReplayGate({
      baselineOutputs: [1, 2, 3],
      candidateOutputs: [4, 5, 6],
      judge,
      iterations: 100,
      seed: 1,
    })
    expect(r.baselineMean).toBe(0)
    expect(r.candidateMean).toBe(0)
  })
})
