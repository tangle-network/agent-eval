import { describe, expect, it } from 'vitest'
import type { AdversarialMutation } from '../rl/adversarial'
import { buildCapsule, renderCapsuleHtml } from './capsule'
import { buildCoverage, enumerateCells } from './cube'
import { fuzzAgent } from './fuzz-agent'
import { composeGates } from './gates'
import type { FuzzCell, FuzzTarget, HypercubeSpec, ScenarioGenerator } from './types'

interface Scn {
  id: string
  topic: string
  difficulty: string
  hardness: number
}

const cube: HypercubeSpec = {
  axes: [
    { name: 'difficulty', values: ['easy', 'hard'] },
    { name: 'topic', values: ['a', 'b'] },
  ],
}

// Deterministic target: hard cells fail (and fail harder as hardness grows); easy cells pass.
const runner: FuzzTarget<Scn> = {
  run: async (s) => {
    const score = s.difficulty === 'hard' ? Math.max(0, 0.4 - 0.1 * s.hardness) : 0.9
    return {
      score,
      passed: score >= 0.5,
      output: `out(${s.id})`,
      failureClass: score < 0.5 ? 'wrong_answer' : undefined,
    }
  },
}

const generator: ScenarioGenerator<Scn> = {
  seedsFor: (cell: FuzzCell) => [
    {
      id: `${cell.id}#seed`,
      topic: cell.coords.topic ?? '',
      difficulty: cell.coords.difficulty ?? '',
      hardness: 0,
    },
  ],
  mutationsFor: (): AdversarialMutation<Scn>[] => [
    {
      id: 'harden',
      mutate: (parent) => [
        { ...parent, id: `${parent.id}.${parent.hardness + 1}`, hardness: parent.hardness + 1 },
      ],
    },
  ],
}

const base = {
  target: 'fake-agent',
  cube,
  generator,
  runner,
  scenarioId: (s: Scn) => s.id,
  scenarioText: (s: Scn) => `topic ${s.topic} / ${s.difficulty} / h${s.hardness}`,
  budget: 40,
  seed: 7,
}

describe('enumerateCells', () => {
  it('is the cartesian product with stable ids', () => {
    const cells = enumerateCells(cube)
    expect(cells).toHaveLength(4)
    expect(cells.map((c) => c.id)).toEqual([
      'difficulty=easy|topic=a',
      'difficulty=easy|topic=b',
      'difficulty=hard|topic=a',
      'difficulty=hard|topic=b',
    ])
  })

  it('reports uncovered cells as robustness null, never a misleading zero', () => {
    const cells = enumerateCells(cube)
    const [c0, c1] = cells
    if (!c0 || !c1) throw new Error('expected at least two cells')
    const cov = buildCoverage(cells, [
      { variantId: c0.id, scenarioId: 'x', score: 0.8, pass: true },
    ])
    expect(cov.find((c) => c.cell.id === c0.id)?.robustness).toBeCloseTo(0.8)
    expect(cov.find((c) => c.cell.id === c1.id)?.robustness).toBeNull()
  })
})

describe('fuzzAgent', () => {
  it('covers every cell and finds failures only where the agent is weak', async () => {
    const { capsule } = await fuzzAgent(base)
    expect(capsule.stats.cellsTotal).toBe(4)
    expect(capsule.stats.cellsCovered).toBe(4) // floor guarantees cold-start coverage

    const hard = capsule.coverage.filter((c) => c.cell.coords.difficulty === 'hard')
    const easy = capsule.coverage.filter((c) => c.cell.coords.difficulty === 'easy')
    for (const c of hard) expect(c.robustness ?? 1).toBeLessThan(0.5)
    for (const c of easy) expect(c.robustness ?? 0).toBeGreaterThanOrEqual(0.5)

    expect(capsule.stats.verifiedFailures).toBeGreaterThan(0)
    for (const f of capsule.failures) expect(f.cell.coords.difficulty).toBe('hard')
    // failures are sorted by descending severity
    const sevs = capsule.failures.map((f) => f.severity)
    expect([...sevs].sort((a, b) => b - a)).toEqual(sevs)
  })

  it('keeps a MAP-Elites elite per covered cell — the hardest scenario found', async () => {
    const { capsule } = await fuzzAgent(base)
    const hardElite = capsule.archive.find((e) => e.cell.coords.difficulty === 'hard')
    expect(hardElite).toBeDefined()
    expect(hardElite!.scenario.score ?? 1).toBeLessThan(0.5)
  })

  it('is deterministic for a fixed seed', async () => {
    const a = await fuzzAgent(base)
    const b = await fuzzAgent(base)
    expect(a.capsule.stats).toEqual(b.capsule.stats)
  })

  it('validity gates drop candidates that fail them (verified <= candidate)', async () => {
    const strict = await fuzzAgent({
      ...base,
      // Only deep failures count — borderline scores are rejected as noise.
      gates: composeGates<Scn>({ isValid: (_s, o) => o.score < 0.3 }),
    })
    expect(strict.capsule.stats.verifiedFailures).toBeLessThanOrEqual(
      strict.capsule.stats.candidateFailures,
    )
    for (const f of strict.capsule.failures) expect(f.score).toBeLessThan(0.3)
  })

  it('applies the minimizer to the surfaced failures', async () => {
    const { capsule } = await fuzzAgent({
      ...base,
      // Shrink to the minimal trigger: hardness 0.
      minimize: (s) => ({ ...s, hardness: 0, id: `${s.id}~min` }),
    })
    expect(capsule.failures.length).toBeGreaterThan(0)
    for (const f of capsule.failures) {
      expect(f.minimized.hardness).toBe(0)
      expect(f.text).toContain('h0')
    }
  })
})

describe('capsule', () => {
  it('buildCapsule + renderCapsuleHtml produce a self-contained page', async () => {
    const { capsule } = await fuzzAgent(base)
    const html = renderCapsuleHtml(capsule, { generatedAt: '2026-06-10T00:00:00Z' })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('fake-agent')
    expect(html).toContain('Coverage map')
    expect(html).toContain('Verified failures')
    expect(html).toContain('2026-06-10T00:00:00Z')
  })

  it('buildCapsule is pure (no clock) — generatedAt is left for the caller', () => {
    const cells = enumerateCells(cube)
    const cap = buildCapsule<Scn>({
      target: 't',
      cells,
      observations: [],
      archive: new Map(),
      failures: [],
      candidateFailures: 0,
      runsUsed: 0,
    })
    expect(cap.generatedAt).toBeUndefined()
    expect(cap.stats.cellsCovered).toBe(0)
    expect(cap.coverage.every((c) => c.robustness === null)).toBe(true)
  })
})
