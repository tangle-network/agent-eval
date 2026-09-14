import { describe, expect, it } from 'vitest'
import type { JudgeScore } from '../types'
import { heldOutGate } from './heldout-gate'

const score = (composite: number): Record<string, JudgeScore> => ({
  judge: { dimensions: { q: composite }, composite, notes: '' },
})

function cells(values: number[]): Map<string, Record<string, JudgeScore>> {
  const map = new Map<string, Record<string, JudgeScore>>()
  for (const [i, v] of values.entries()) {
    map.set(`s${i}:0`, score(v))
  }
  return map
}

const scenarios = Array.from({ length: 24 }, (_, i) => ({ id: `s${i}`, kind: 'fixture' }))

describe('heldOutGate', () => {
  it('HOLDS on same-distribution noise even when the candidate mean is higher', async () => {
    const baseline = cells(Array(24).fill(0.5))
    const candidate = cells(Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 0.7 : 0.4)))
    const gate = heldOutGate({ scenarios, deltaThreshold: 0.02 })
    const result = await gate.decide({
      judgeScores: candidate,
      baselineJudgeScores: baseline,
    } as never)
    expect(result.decision).toBe('hold')
    expect(result.reasons?.join(' ')).toMatch(/CI/)
  })

  it('SHIPS a real, consistent lift whose CI clears the threshold', async () => {
    const baseline = cells(Array(24).fill(0.5))
    const candidate = cells(Array.from({ length: 24 }, (_, i) => 0.78 + (i % 5) * 0.01))
    const gate = heldOutGate({ scenarios, deltaThreshold: 0.1 })
    const result = await gate.decide({
      judgeScores: candidate,
      baselineJudgeScores: baseline,
    } as never)
    expect(result.decision).toBe('ship')
    expect(result.delta).toBeCloseTo(0.3, 1)
  })

  it('uses the default threshold and exposes the configured bootstrap seed', async () => {
    const baseline = cells(Array(24).fill(0.1))
    // Not a uniform delta: identical deltas give a zero-width interval, which
    // the gate refuses regardless of how large the gain is.
    const candidate = cells(
      Array.from({ length: 24 }, (_, i) => [0.92, 0.88, 0.95, 0.89, 0.93, 0.9][i % 6]!),
    )
    const gate = heldOutGate({ scenarios, bootstrapSeed: 99 })
    const result = await gate.decide({
      judgeScores: candidate,
      baselineJudgeScores: baseline,
    } as never)
    expect(result.decision).toBe('ship')
    expect(result.contributingGates[0]?.detail).toMatchObject({
      deltaThreshold: 0.5,
      seed: 99,
    })
  })

  it('throws when baseline scores are missing', async () => {
    const gate = heldOutGate({ scenarios: scenarios.slice(0, 3), deltaThreshold: 0.1 })
    await expect(
      gate.decide({
        judgeScores: cells([0.9, 0.9, 0.9, 0.9, 0.9, 0.9]),
      } as never),
    ).rejects.toThrow(/baselineJudgeScores/)
  })

  it('HOLDS with too few paired observations regardless of the delta', async () => {
    const baseline = cells([0.1, 0.1])
    const candidate = cells([0.9, 0.9])
    const gate = heldOutGate({
      scenarios: scenarios.slice(0, 2),
      deltaThreshold: 0.1,
      minProductiveRuns: 3,
    })
    const result = await gate.decide({
      judgeScores: candidate,
      baselineJudgeScores: baseline,
    } as never)
    expect(result.decision).toBe('hold')
    expect(result.reasons?.join(' ')).toMatch(/too few/)
    expect(result.contributingGates[0]?.status).toBe('not_evaluated')
  })
})
