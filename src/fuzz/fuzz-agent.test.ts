import { describe, expect, it } from 'vitest'
import { renderCapsuleHtml } from './capsule'
import { buildCoverage, enumerateCells } from './cube'
import { BehaviorExplorer } from './explorer'
import { fuzzAgent } from './fuzz-agent'
import { composeGates } from './gates'
import { mutationProposer, noveltyObjective } from './policies'
import { makeExploreTools } from './tools'
import type { BehaviorSpace, Cell, Evaluation, Evaluator, ExploreOptions, Proposer } from './types'

interface Scn {
  id: string
  topic: string
  difficulty: string
  hardness: number
}

const space: BehaviorSpace = {
  axes: [
    { name: 'difficulty', values: ['easy', 'hard'] },
    { name: 'topic', values: ['a', 'b'] },
  ],
}

// Deterministic target: hard cells fail (harder as pressure grows); easy cells pass.
// Emits per-dimension scores and a measured descriptor (what the agent DID).
const evaluate: Evaluator<Scn> = async (s) => {
  const score = s.difficulty === 'hard' ? Math.max(0, 0.4 - 0.1 * s.hardness) : 0.9
  const failed = score < 0.5
  return {
    valid: true,
    score,
    scores: { correctness: score, safety: Math.min(1, score + 0.2) },
    descriptor: { outcome: failed ? 'wrong_answer' : 'answered' },
    output: `out(${s.id})`,
    labels: failed ? ['wrong_answer'] : undefined,
  }
}

const seedsFor = (cell: Cell): Scn[] => [
  {
    id: `${cell.id}#seed`,
    topic: cell.coords.topic ?? '',
    difficulty: cell.coords.difficulty ?? '',
    hardness: 0,
  },
]

const proposer: Proposer<Scn> = mutationProposer<Scn>({
  scenarioId: (s) => s.id,
  mutationsFor: () => [
    {
      id: 'harden',
      mutate: (p) => [{ ...p, id: `${p.id}.${p.hardness + 1}`, hardness: p.hardness + 1 }],
    },
  ],
})

const base: ExploreOptions<Scn> = {
  target: 'fake-agent',
  space,
  proposer,
  evaluate,
  seedsFor,
  scenarioId: (s) => s.id,
  scenarioText: (s) => `topic ${s.topic} / ${s.difficulty} / h${s.hardness}`,
  budget: 40,
  seed: 7,
}

describe('enumerateCells + buildCoverage', () => {
  it('cells are the cartesian product with stable ids', () => {
    const cells = enumerateCells(space)
    expect(cells.map((c) => c.id)).toEqual([
      'difficulty=easy|topic=a',
      'difficulty=easy|topic=b',
      'difficulty=hard|topic=a',
      'difficulty=hard|topic=b',
    ])
  })

  it('uncovered cells report robustness null, never a misleading zero', () => {
    const cells = enumerateCells(space)
    const [c0, c1] = cells
    if (!c0 || !c1) throw new Error('expected cells')
    const ev: Evaluation = { valid: true, score: 0.8 }
    const cov = buildCoverage(cells, [{ cell: c0, ev, interest: 0.2 }], 0.5)
    expect(cov.find((c) => c.cell.id === c0.id)?.robustness).toBeCloseTo(0.8)
    expect(cov.find((c) => c.cell.id === c1.id)?.robustness).toBeNull()
  })
})

describe('fuzzAgent (adversarial preset)', () => {
  it('covers every planned cell and finds failures only where the target is weak', async () => {
    const { capsule } = await fuzzAgent(base)
    expect(capsule.objective).toBe('adversarial')
    expect(capsule.stats.cellsTotal).toBe(4)
    expect(capsule.stats.cellsCovered).toBe(4)

    for (const c of capsule.coverage) {
      if (c.cell.coords.difficulty === 'hard') expect(c.robustness ?? 1).toBeLessThan(0.5)
      else expect(c.robustness ?? 0).toBeGreaterThanOrEqual(0.5)
    }
    expect(capsule.stats.verifiedFindings).toBeGreaterThan(0)
    for (const f of capsule.findings) expect(f.cell.coords.difficulty).toBe('hard')
    const interests = capsule.findings.map((f) => f.interest)
    expect([...interests].sort((a, b) => b - a)).toEqual(interests)
  })

  it('PINNING: coverage carries non-empty per-dimension means when evaluations have scores', async () => {
    const { capsule } = await fuzzAgent(base)
    const covered = capsule.coverage.filter((c) => c.runs > 0)
    expect(covered.length).toBeGreaterThan(0)
    for (const c of covered) {
      expect(Object.keys(c.dimensions)).toEqual(expect.arrayContaining(['correctness', 'safety']))
    }
  })

  it('measured descriptor bins the archive but NEVER inflates the planned denominator', async () => {
    const { capsule } = await fuzzAgent(base)
    // cellsTotal stays the input cartesian (4) regardless of measured bins.
    expect(capsule.stats.cellsTotal).toBe(4)
    expect(capsule.stats.behaviorBinsObserved).toBeGreaterThan(0)
    const binIds = capsule.archive.map((e) => e.binId)
    expect(binIds.some((b) => b.includes('outcome='))).toBe(true)
    // hard cells can hold two bins (answered seed + wrong_answer mutants).
    expect(new Set(binIds).size).toBe(binIds.length)
  })

  it('is deterministic for a fixed seed', async () => {
    const a = await fuzzAgent(base)
    const b = await fuzzAgent(base)
    expect(a.capsule.stats).toEqual(b.capsule.stats)
  })

  it('validity gates drop candidates (verified <= candidate) and report only gate-passers', async () => {
    const strict = await fuzzAgent({
      ...base,
      gates: composeGates<Scn>({ isValid: (_s, ev) => ev.score < 0.3 }),
    })
    expect(strict.capsule.stats.verifiedFindings).toBeLessThanOrEqual(
      strict.capsule.stats.candidateFindings,
    )
    for (const f of strict.capsule.findings) expect(f.evaluation.score).toBeLessThan(0.3)
  })

  it('applies the minimizer to reported findings', async () => {
    const { capsule } = await fuzzAgent({
      ...base,
      minimize: (s) => ({ ...s, hardness: 0, id: `${s.id}~min` }),
    })
    expect(capsule.findings.length).toBeGreaterThan(0)
    for (const f of capsule.findings) {
      expect(f.minimized.hardness).toBe(0)
      expect(f.text).toContain('h0')
    }
  })

  it('uniform allocation is available as the unsteered ablation baseline', async () => {
    // A proposer that never exhausts: uniform consumption then matches uniform
    // allocation (base's mutation operator runs dry on easy cells, which is
    // legitimate engine behavior, not an allocation skew).
    let n = 0
    const fresh: Proposer<Scn> = (ctx) =>
      Array.from({ length: ctx.count }, () => {
        n++
        return {
          id: `${ctx.cell.id}#p${n}`,
          topic: ctx.cell.coords.topic ?? '',
          difficulty: ctx.cell.coords.difficulty ?? '',
          hardness: 1,
        }
      })
    const { capsule } = await fuzzAgent({ ...base, proposer: fresh, allocation: 'uniform' })
    expect(capsule.stats.cellsCovered).toBe(4)
    const runs = capsule.coverage.map((c) => c.runs)
    expect(Math.max(...runs) - Math.min(...runs)).toBeLessThanOrEqual(2)
  })

  it('respects an AbortSignal', async () => {
    const ac = new AbortController()
    ac.abort()
    const { capsule } = await fuzzAgent({ ...base, signal: ac.signal })
    expect(capsule.stats.totalRuns).toBe(0)
  })
})

describe('BehaviorExplorer session + tools', () => {
  it('step() makes incremental progress an agent can drive', async () => {
    const explorer = new BehaviorExplorer(base)
    const first = await explorer.step()
    expect(first.runs).toBeGreaterThan(0)
    const coverage = explorer.coverage()
    expect(coverage.filter((c) => c.runs > 0).length).toBeGreaterThan(0)
  })

  it('makeExploreTools exposes step/coverage/findings/capsule as JSON-schema tools', async () => {
    const explorer = new BehaviorExplorer(base)
    const tools = makeExploreTools(explorer)
    expect(tools.map((t) => t.name)).toEqual([
      'explore_step',
      'explore_coverage',
      'explore_findings',
      'explore_capsule',
    ])
    for (const t of tools) {
      expect(t.parameters).toHaveProperty('type', 'object')
      expect(typeof t.description).toBe('string')
    }
    const step = tools[0]
    const stepOut = (await step?.handler({})) as { runs: number }
    expect(stepOut.runs).toBeGreaterThan(0)
    const capsuleTool = tools[3]
    const html = (await capsuleTool?.handler({
      format: 'html',
      generatedAt: '2026-06-10T00:00:00Z',
    })) as string
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('fake-agent')
  })

  it('a custom objective re-points the same engine (novelty)', async () => {
    const explorer = new BehaviorExplorer({ ...base, objective: noveltyObjective(0.9), budget: 20 })
    const capsule = await explorer.run()
    expect(capsule.objective).toBe('novelty')
    expect(capsule.stats.totalRuns).toBeGreaterThan(0)
  })
})

describe('capsule rendering', () => {
  it('renders heat-map, dimension chips, and gate-verified findings', async () => {
    const { capsule } = await fuzzAgent(base)
    const html = renderCapsuleHtml(capsule, { generatedAt: '2026-06-10T00:00:00Z' })
    expect(html).toContain('Coverage map')
    expect(html).toContain('Verified findings')
    expect(html).toContain('correctness')
    expect(html).toContain('wrong_answer')
    expect(html).toContain('2026-06-10T00:00:00Z')
  })
})

describe('eval-error isolation (0.89.1)', () => {
  // evaluate throws on every 'hard' scenario — exploration must survive,
  // record typed errors, and still produce a complete capsule for easy cells.
  const flaky: Evaluator<Scn> = async (s) => {
    if (s.difficulty === 'hard') throw new Error('chat backend returned 503')
    return { valid: true, score: 0.9, scores: { correctness: 0.9 } }
  }

  it('a throwing evaluate becomes a typed eval-error, not a crash; healthy cells still complete', async () => {
    const events: string[] = []
    const { capsule } = await fuzzAgent({
      ...base,
      evaluate: flaky,
      budget: 16,
      onProgress: (e) => events.push(e.type),
    })
    expect(capsule.stats.evalErrors).toBeGreaterThan(0)
    expect(events).toContain('eval-error')
    // easy cells were evaluated and scored despite hard-cell failures
    const easy = capsule.coverage.filter((c) => c.cell.coords.difficulty === 'easy')
    expect(easy.some((c) => c.runs > 0)).toBe(true)
    // errors never count as runs or findings
    expect(capsule.stats.totalRuns + capsule.stats.evalErrors).toBeGreaterThan(
      capsule.stats.totalRuns,
    )
    for (const f of capsule.findings) expect(f.cell.coords.difficulty).not.toBe('hard')
  })

  it('consecutive errors trip the circuit breaker: early stop with capsule-so-far', async () => {
    const dead: Evaluator<Scn> = async () => {
      throw new Error('ECONNREFUSED')
    }
    const { capsule } = await fuzzAgent({
      ...base,
      evaluate: dead,
      budget: 40,
      maxConsecutiveEvalErrors: 3,
    })
    expect(capsule.stats.stoppedEarly?.reason).toBe('eval-errors')
    expect(capsule.stats.stoppedEarly?.detail).toContain('ECONNREFUSED')
    expect(capsule.stats.totalRuns).toBe(0)
    expect(capsule.stats.evalErrors).toBe(3)
  })

  it('successes reset the error streak — intermittent failures never trip the breaker', async () => {
    let n = 0
    const intermittent: Evaluator<Scn> = async () => {
      n++
      if (n % 2 === 0) throw new Error('chat backend returned 503')
      return { valid: true, score: 0.9, scores: { correctness: 0.9 } }
    }
    const { capsule } = await fuzzAgent({
      ...base,
      evaluate: intermittent,
      budget: 12,
      maxConsecutiveEvalErrors: 3,
    })
    expect(capsule.stats.stoppedEarly).toBeUndefined()
    expect(capsule.stats.evalErrors).toBeGreaterThan(0)
    expect(capsule.stats.totalRuns).toBeGreaterThan(0)
  })

  it('a throwing GATE is captured too (gate re-evals cross the same boundary)', async () => {
    const { capsule } = await fuzzAgent({
      ...base,
      budget: 12,
      gates: {
        isUncontaminated: async () => {
          throw new Error('chat backend returned 502')
        },
      },
    })
    expect(capsule.stats.evalErrors).toBeGreaterThan(0)
    expect(capsule.stats.verifiedFindings).toBe(0)
  })

  it('renderCapsuleHtml shows the eval-errors KPI and the early-stop banner', async () => {
    const dead: Evaluator<Scn> = async () => {
      throw new Error('ECONNREFUSED')
    }
    const { capsule } = await fuzzAgent({
      ...base,
      evaluate: dead,
      budget: 10,
      maxConsecutiveEvalErrors: 2,
    })
    const html = renderCapsuleHtml(capsule)
    expect(html).toContain('eval errors')
    expect(html).toContain('stopped early')
  })
})
