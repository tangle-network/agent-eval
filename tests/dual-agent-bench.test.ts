import { describe, it, expect } from 'vitest'
import { DualAgentBench } from '../src/dual-agent-bench'

describe('DualAgentBench', () => {
  it('converges when the critic returns threshold on round N', async () => {
    const bench = new DualAgentBench()
    const report = await bench.run({
      scenarios: [{ id: 's1', initialPrompt: 'draft a contract' }],
      maxRounds: 5,
      convergenceThreshold: 0.9,
      propose: async ({ roundIndex }) => `proposal round ${roundIndex}`,
      critique: async ({ roundIndex }) => ({
        critique: `critique ${roundIndex}`,
        // Converge on round 2 (index 2 = third round)
        convergenceScore: roundIndex >= 2 ? 1.0 : 0.5,
      }),
    })
    expect(report.scenarios[0].converged).toBe(true)
    expect(report.scenarios[0].roundsToConverge).toBe(3)
    expect(report.aggregate.convergenceRate).toBe(1)
  })

  it('records full history — regression: silent loss of intermediate rounds breaks forensics', async () => {
    const bench = new DualAgentBench()
    const report = await bench.run({
      scenarios: [{ id: 's1', initialPrompt: 'x' }],
      maxRounds: 3,
      convergenceThreshold: 2, // impossible; forces all rounds to run
      propose: async ({ roundIndex }) => `p${roundIndex}`,
      critique: async ({ roundIndex }) => ({
        critique: `c${roundIndex}`,
        convergenceScore: 0.1,
      }),
    })
    expect(report.scenarios[0].history).toHaveLength(3)
    expect(report.scenarios[0].history.map((r) => r.proposal)).toEqual(['p0', 'p1', 'p2'])
    expect(report.scenarios[0].converged).toBe(false)
  })

  it('proposer sees prior critique — regression: proposer ignoring critique means no iteration', async () => {
    const bench = new DualAgentBench()
    const seenCritiques: (string | undefined)[] = []
    await bench.run({
      scenarios: [{ id: 's1', initialPrompt: 'x' }],
      maxRounds: 3,
      convergenceThreshold: 2,
      propose: async ({ priorCritique }) => {
        seenCritiques.push(priorCritique)
        return 'proposal'
      },
      critique: async ({ roundIndex }) => ({
        critique: `round ${roundIndex} critique`,
        convergenceScore: 0.1,
      }),
    })
    expect(seenCritiques[0]).toBeUndefined()
    expect(seenCritiques[1]).toBe('round 0 critique')
    expect(seenCritiques[2]).toBe('round 1 critique')
  })

  it('rejects out-of-range convergenceScore — regression: >1 would lock max out of the aggregate', async () => {
    const bench = new DualAgentBench()
    await expect(
      bench.run({
        scenarios: [{ id: 's1', initialPrompt: 'x' }],
        propose: async () => 'p',
        critique: async () => ({ critique: 'c', convergenceScore: 1.5 }),
      }),
    ).rejects.toThrow(/\[0,1\]/)
  })

  it('rejects empty scenario list', async () => {
    const bench = new DualAgentBench()
    await expect(
      bench.run({
        scenarios: [],
        propose: async () => 'p',
        critique: async () => ({ critique: 'c', convergenceScore: 0 }),
      }),
    ).rejects.toThrow(/at least 1/)
  })

  it('fires onRoundComplete per round', async () => {
    const bench = new DualAgentBench()
    const events: Array<{ scenarioId: string; round: number }> = []
    await bench.run({
      scenarios: [{ id: 's1', initialPrompt: 'x' }],
      maxRounds: 2,
      convergenceThreshold: 2,
      propose: async () => 'p',
      critique: async () => ({ critique: 'c', convergenceScore: 0 }),
      onRoundComplete: ({ scenarioId, round }) => events.push({ scenarioId, round: round.roundIndex }),
    })
    expect(events).toEqual([{ scenarioId: 's1', round: 0 }, { scenarioId: 's1', round: 1 }])
  })

  it('aggregate.convergenceRate is the fraction that converged', async () => {
    const bench = new DualAgentBench()
    const report = await bench.run({
      scenarios: [
        { id: 'a', initialPrompt: 'x' },
        { id: 'b', initialPrompt: 'x' },
        { id: 'c', initialPrompt: 'x' },
        { id: 'd', initialPrompt: 'x' },
      ],
      maxRounds: 2,
      convergenceThreshold: 0.5,
      propose: async () => 'p',
      critique: async ({ scenario }) => ({
        critique: 'c',
        // a + b converge immediately; c + d never
        convergenceScore: scenario.id < 'c' ? 1 : 0,
      }),
    })
    expect(report.aggregate.convergenceRate).toBe(0.5)
  })
})
