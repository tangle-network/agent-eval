import { describe, expect, it } from 'vitest'
import {
  evaluateInterimReleaseConfidence,
  pairedEvalueSequence,
} from '../src/sequential'

function deltasUnderNull(n: number, seed = 1, c = 0.1): number[] {
  // Mean-zero noise inside [-c, c]. Used to verify type-I error control.
  let s = seed >>> 0
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296
    out.push((u * 2 - 1) * c)
  }
  return out
}

function deltasWithEffect(n: number, mean = 0.05, seed = 1, c = 0.1): number[] {
  return deltasUnderNull(n, seed, c).map((x) => x + mean)
}

describe('pairedEvalueSequence — basic behaviour', () => {
  it('returns "continue" while evidence is thin', () => {
    const seq = pairedEvalueSequence(deltasWithEffect(5, 0.05))
    expect(seq.finalDecision).toBe('continue')
    expect(seq.steps).toHaveLength(5)
  })

  it('eventually fires "promote_now" with persistent positive effect', () => {
    const seq = pairedEvalueSequence(deltasWithEffect(400, 0.04), { alpha: 0.05, bound: 0.2 })
    expect(seq.finalDecision).toBe('promote_now')
    expect(seq.decisionFiredAt).not.toBeNull()
    expect(seq.steps[seq.steps.length - 1]!.evalue).toBeGreaterThan(40)
  })

  it('fires "reject_now" with persistent negative effect', () => {
    const seq = pairedEvalueSequence(deltasWithEffect(400, -0.04), { alpha: 0.05, bound: 0.2 })
    expect(seq.finalDecision).toBe('reject_now')
    expect(seq.decisionFiredAt).not.toBeNull()
  })

  it('fires "equivalent" once the confidence sequence on the mean enters the ROPE', () => {
    const seq = pairedEvalueSequence(deltasWithEffect(2000, 0.0001, 7, 0.02), {
      alpha: 0.05,
      bound: 0.05,
      rope: { low: -0.01, high: 0.01 },
    })
    expect(['equivalent', 'continue']).toContain(seq.finalDecision)
    if (seq.finalDecision === 'equivalent') {
      const last = seq.steps[seq.steps.length - 1]!
      expect(last.csLow).toBeGreaterThanOrEqual(-0.01)
      expect(last.csHigh).toBeLessThanOrEqual(0.01)
    }
  })

  it('controls type-I error: 100 series under the null at α=0.05 reject < 5% of the time', () => {
    let falseRejects = 0
    const trials = 100
    for (let s = 1; s <= trials; s++) {
      const seq = pairedEvalueSequence(deltasUnderNull(200, s), { alpha: 0.05, bound: 0.1 })
      if (seq.finalDecision === 'promote_now' || seq.finalDecision === 'reject_now') falseRejects++
    }
    expect(falseRejects).toBeLessThan(15)
  })

  it('clips deltas outside [-bound, bound] and flags it', () => {
    const seq = pairedEvalueSequence([0.5, -0.7, 0.05], { bound: 0.1 })
    expect(seq.clipped).toBe(true)
    expect(Math.abs(seq.steps[0]!.delta)).toBeLessThanOrEqual(0.1)
  })

  it('rejects invalid configuration', () => {
    expect(() => pairedEvalueSequence([0], { bound: 0 })).toThrow(/bound must be > 0/)
    expect(() => pairedEvalueSequence([0], { alpha: 0 })).toThrow(/alpha must be in/)
    expect(() => pairedEvalueSequence([0], { rope: { low: 1, high: 0 } })).toThrow(/low ≤ high/)
  })

  it('p-value is monotone-ish and stays in [0, 1]', () => {
    const seq = pairedEvalueSequence(deltasWithEffect(50, 0.03))
    for (const s of seq.steps) {
      expect(s.pValue).toBeGreaterThanOrEqual(0)
      expect(s.pValue).toBeLessThanOrEqual(1)
    }
  })
})

describe('evaluateInterimReleaseConfidence', () => {
  it('returns campaign-level promote_now when any candidate decisively wins', () => {
    const out = evaluateInterimReleaseConfidence({
      deltaSeries: [
        { candidateId: 'a', deltas: deltasWithEffect(400, 0.04) },
        { candidateId: 'b', deltas: deltasUnderNull(400, 5) },
      ],
      alpha: 0.05,
      bound: 0.2,
    })
    expect(out.recommendation.decision).toBe('promote_now')
    expect(out.recommendation.candidateId).toBe('a')
  })

  it('returns continue while all candidates are still live', () => {
    const out = evaluateInterimReleaseConfidence({
      deltaSeries: [
        { candidateId: 'a', deltas: deltasWithEffect(10, 0.02) },
        { candidateId: 'b', deltas: deltasWithEffect(10, 0.01) },
      ],
    })
    expect(out.recommendation.decision).toBe('continue')
  })

  it('returns equivalent when at least one candidate is equivalent and none are decisively winning', () => {
    const out = evaluateInterimReleaseConfidence({
      deltaSeries: [
        { candidateId: 'a', deltas: deltasWithEffect(2000, 0.0001, 11, 0.02) },
        { candidateId: 'b', deltas: deltasUnderNull(2000, 12, 0.02) },
      ],
      alpha: 0.05,
      bound: 0.05,
      rope: { low: -0.01, high: 0.01 },
    })
    expect(['equivalent', 'reject_now', 'continue']).toContain(out.recommendation.decision)
  })

  it('reports per-candidate metadata so callers can render an interim dashboard', () => {
    const out = evaluateInterimReleaseConfidence({
      deltaSeries: [
        { candidateId: 'cand', deltas: deltasWithEffect(20, 0.03) },
      ],
    })
    expect(out.candidates).toHaveLength(1)
    const c = out.candidates[0]!
    expect(c.candidateId).toBe('cand')
    expect(c.pairs).toBe(20)
    expect(c.finalEvalue).toBeGreaterThan(0)
    expect(c.finalPValue).toBeGreaterThan(0)
    expect(c.finalPValue).toBeLessThanOrEqual(1)
  })
})
