import { describe, expect, it } from 'vitest'
import type { JudgeScore } from '../types'
import { heldOutGate } from './heldout-gate'

const score = (composite: number): Record<string, JudgeScore> => ({
  judge: { dimensions: { q: composite }, composite, notes: '' },
})

function cells(values: number[]): Map<string, Record<string, JudgeScore>> {
  const map = new Map<string, Record<string, JudgeScore>>()
  for (const [i, v] of values.entries()) {
    map.set(`s${Math.floor(i / 2)}:${i % 2}`, score(v))
  }
  return map
}

const scenarios = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, kind: 'fixture' }))

describe('heldOutGate', () => {
  it('HOLDS on same-distribution noise even when the candidate mean is higher', async () => {
    const baseline = cells([0.9, 0.5, 0.7, 0.95, 0.6, 0.8, 0.85, 0.55, 0.75, 0.9, 0.65, 0.7])
    const candidate = cells([0.95, 0.6, 0.65, 0.9, 0.75, 0.85, 0.8, 0.7, 0.85, 0.8, 0.75, 0.8])
    const gate = heldOutGate({ scenarios, deltaThreshold: 0.02 })
    const result = await gate.decide({
      judgeScores: candidate,
      baselineJudgeScores: baseline,
    } as never)
    expect(result.decision).toBe('hold')
    expect(result.reasons?.join(' ')).toMatch(/CI/)
  })

  it('SHIPS a real, consistent lift whose CI clears the threshold', async () => {
    const baseline = cells([0.5, 0.52, 0.48, 0.51, 0.5, 0.49, 0.5, 0.52, 0.51, 0.5, 0.49, 0.5])
    const candidate = cells([0.8, 0.82, 0.78, 0.81, 0.8, 0.79, 0.8, 0.82, 0.81, 0.8, 0.79, 0.8])
    const gate = heldOutGate({ scenarios, deltaThreshold: 0.1 })
    const result = await gate.decide({
      judgeScores: candidate,
      baselineJudgeScores: baseline,
    } as never)
    expect(result.decision).toBe('ship')
    expect(result.delta).toBeCloseTo(0.3, 1)
  })

  it('uses the default threshold and exposes the configured bootstrap seed', async () => {
    const baseline = cells([0.1, 0.1, 0.1, 0.1, 0.1, 0.1])
    const candidate = cells([0.9, 0.9, 0.9, 0.9, 0.9, 0.9])
    const gate = heldOutGate({ scenarios: scenarios.slice(0, 3), bootstrapSeed: 99 })
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
      scenarios: [{ id: 's0', kind: 'fixture' }],
      deltaThreshold: 0.1,
      minProductiveRuns: 3,
    })
    const result = await gate.decide({
      judgeScores: candidate,
      baselineJudgeScores: baseline,
    } as never)
    expect(result.decision).toBe('hold')
    expect(result.reasons?.join(' ')).toMatch(/too few/)
  })
})
