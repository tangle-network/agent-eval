import { describe, expect, it } from 'vitest'
import {
  injectIrrelevantClause,
  renameVariables,
  runContaminationProbe,
} from '../src/rl/contamination'

interface Scen {
  id: string
  prompt: string
}
const id = (s: Scen) => s.id

describe('runContaminationProbe', () => {
  it('flags contamination when scores drop significantly on perturbed scenarios', async () => {
    // Memorized scenarios: model gets 1.0 on originals, 0.4 on perturbed.
    const originals: Scen[] = Array.from({ length: 12 }, (_, i) => ({
      id: `s-${i}`,
      prompt: `original-${i}`,
    }))
    const out = await runContaminationProbe<Scen>({
      scenarioId: id,
      originals,
      perturbed: originals.map((s) => ({ ...s, prompt: `${s.prompt}_perturbed` })),
      scoreFn: async (s) => (s.prompt.includes('_perturbed') ? 0.4 : 1.0),
    })
    expect(out.contaminationSuspected).toBe(true)
    expect(out.medianDelta).toBeLessThan(-0.05)
    expect(out.pairedTest!.p).toBeLessThan(0.05)
    expect(out.perScenario[0]).toEqual({
      scenarioId: 's-0',
      originalScore: 1,
      perturbedScore: 0.4,
      delta: -0.6,
    })
  })

  it('does not flag contamination when scores are similar', async () => {
    const originals: Scen[] = Array.from({ length: 10 }, (_, i) => ({
      id: `s-${i}`,
      prompt: `text-${i}`,
    }))
    const out = await runContaminationProbe<Scen>({
      scenarioId: id,
      originals,
      perturbed: originals.map((s) => ({ ...s, prompt: `${s.prompt}_v2` })),
      scoreFn: async (s) => 0.7 + (s.prompt.length % 3) * 0.01,
    })
    expect(out.contaminationSuspected).toBe(false)
  })

  it('returns insufficient when fewer than 4 valid scenarios', async () => {
    const originals: Scen[] = [
      { id: 'a', prompt: 'x' },
      { id: 'b', prompt: 'y' },
    ]
    const out = await runContaminationProbe<Scen>({
      scenarioId: id,
      originals,
      perturbed: originals.map((s) => ({ ...s, prompt: `${s.prompt}z` })),
      scoreFn: async () => 0.8,
    })
    expect(out.contaminationSuspected).toBe(false)
    expect(out.reason).toMatch(/insufficient/)
    expect(out.pairedTest).toBeNull()
    expect(out.meanDelta).toBe(0)
    expect(out.medianDelta).toBe(0)
  })

  it('synthesizes perturbations via the strategy callback', async () => {
    const originals: Scen[] = Array.from({ length: 6 }, (_, i) => ({
      id: `s-${i}`,
      prompt: `task with X`,
    }))
    const out = await runContaminationProbe<Scen>({
      scenarioId: id,
      originals,
      perturbation: renameVariables<Scen>(['X']),
      scoreFn: async (s) => (s.prompt.includes('X_') ? 0.4 : 0.9),
    })
    expect(out.n).toBeGreaterThanOrEqual(4)
  })

  it('keeps exclusion and missing evidence distinct from measured zero', async () => {
    const originals = [{ id: 'excluded', prompt: 'one' }]
    const report = await runContaminationProbe(
      {
        scenarioId: id,
        originals,
        perturbed: originals,
        scoreFn: async () => 0.1,
      },
      { scoreFloor: 0.5 },
    )
    expect(report).toMatchObject({
      n: 0,
      excludedScenarioIds: ['excluded'],
      pairedTest: null,
      meanDelta: null,
      medianDelta: null,
    })
    expect(report.perScenario).toHaveLength(1)
  })

  it('computes the median across the two central differences for even cohorts', async () => {
    const originals = [0.1, 0.2, 0.6, 0.7].map((drop, i) => ({ id: `s${i}`, prompt: '', drop }))
    const report = await runContaminationProbe({
      scenarioId: id,
      originals,
      perturbed: originals.map((scenario) => ({ ...scenario, prompt: 'perturbed' })),
      scoreFn: async (scenario) => (scenario.prompt ? 1 - scenario.drop : 1),
    })
    expect(report.medianDelta).toBeCloseTo(-0.4, 10)
  })

  it('rejects malformed options, duplicate identities, and nonfinite scores', async () => {
    const originals = [{ id: 'one', prompt: '' }]
    const input = { scenarioId: id, originals, perturbed: originals, scoreFn: async () => 0.5 }
    await expect(runContaminationProbe(input, { alpha: 0 })).rejects.toThrow(/alpha/)
    await expect(runContaminationProbe(input, { minMedianDrop: NaN })).rejects.toThrow(
      /minMedianDrop/,
    )
    await expect(
      runContaminationProbe({ ...input, originals: [...originals, ...originals] }),
    ).rejects.toThrow(/unique/)
    await expect(runContaminationProbe({ ...input, scoreFn: async () => NaN })).rejects.toThrow(
      /finite/,
    )
  })
})

describe('renameVariables perturbation', () => {
  it('renames all occurrences of declared identifiers', () => {
    const p = renameVariables<{ prompt: string }>(['foo'])
    const out = p.apply({ prompt: 'foo bar foo' }) as { prompt: string }
    expect(out.prompt).not.toContain('foo bar foo')
    expect(out.prompt).toMatch(/foo_\w bar foo_\w/)
  })

  it('leaves unrelated tokens untouched', () => {
    const p = renameVariables<{ prompt: string }>(['x'])
    const out = p.apply({ prompt: 'extra text' }) as { prompt: string }
    expect(out.prompt).toBe('extra text') // 'x' is not a word boundary in 'extra'
  })
})

describe('injectIrrelevantClause perturbation', () => {
  it('prepends the clause by default', () => {
    const p = injectIrrelevantClause<{ prompt: string }>('Note: ignore this.')
    const out = p.apply({ prompt: 'real task' }) as { prompt: string }
    expect(out.prompt.startsWith('Note: ignore this.')).toBe(true)
  })

  it('appends when position=suffix', () => {
    const p = injectIrrelevantClause<{ prompt: string }>('— end note.', 'suffix')
    const out = p.apply({ prompt: 'task' }) as { prompt: string }
    expect(out.prompt.endsWith('— end note.')).toBe(true)
  })
})
