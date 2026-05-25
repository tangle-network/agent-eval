import { describe, expect, it } from 'vitest'
import { proposeSynthesisTargets } from '../src/active-learning'
import { causalAttribution, type FactorialCell } from '../src/causal-attribution'
import { Dataset } from '../src/dataset'
import { outputLengthRubric, PrmGrader } from '../src/prm'
import {
  exportRewardModel,
  loadScorerFromGrader,
  replayScorerOverCorpus,
} from '../src/reward-model-export'
import {
  type CandidateScenario,
  runSelfPlay,
  type SelfPlayProposer,
  type SelfPlayScorer,
} from '../src/self-play'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

// ── self-play ────────────────────────────────────────────────────────

describe('runSelfPlay', () => {
  it('promotes candidates whose scores spread across targets', async () => {
    const candidates: CandidateScenario[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      payload: i,
    }))
    const proposer: SelfPlayProposer = {
      async propose() {
        return candidates
      },
    }
    const scorer: SelfPlayScorer = {
      async scoreCandidate(candidate, targets) {
        const i = Number(candidate.payload)
        // c0..c2 reveal big spread; c3..c4 are uniform
        const spreads = [0.8, 0.7, 0.6, 0.05, 0.02]
        return targets.map((t, ti) => ({
          targetId: t,
          score: ti === 0 ? 0.2 : 0.2 + spreads[i],
        }))
      },
    }
    const { dataset, rounds } = await runSelfPlay(proposer, scorer, ['a', 'b'], { minSpread: 0.3 })
    expect(rounds[0].survived).toHaveLength(3)
    expect(dataset.size).toBe(3)
  })

  it('rejects degenerate break-all scenarios (below floor) — regression: noise/gibberish must not flood the corpus', async () => {
    const candidates: CandidateScenario[] = [{ id: 'break-all', payload: null }]
    const proposer: SelfPlayProposer = {
      async propose() {
        return candidates
      },
    }
    const scorer: SelfPlayScorer = {
      async scoreCandidate() {
        return [
          { targetId: 'a', score: 0.01 },
          { targetId: 'b', score: 0.0 },
        ]
      },
    }
    const { rounds, dataset } = await runSelfPlay(proposer, scorer, ['a', 'b'], {
      minSpread: 0.001,
      minAbsoluteFloor: 0.1,
    })
    expect(rounds[0].rejected[0].reason).toMatch(/floor/)
    expect(dataset.size).toBe(0)
  })

  it('requires ≥2 targets', async () => {
    await expect(
      runSelfPlay(
        {
          async propose() {
            return []
          },
        },
        {
          async scoreCandidate() {
            return []
          },
        },
        ['a'],
      ),
    ).rejects.toThrow(/at least 2/)
  })
})

// ── causal attribution ───────────────────────────────────────────────

describe('causalAttribution', () => {
  it('model factor dominates when model changes and prompt does not', () => {
    const cells: FactorialCell[] = [
      { levels: { model: 'claude', prompt: 'v1' }, score: 0.5, n: 1 },
      { levels: { model: 'claude', prompt: 'v2' }, score: 0.5, n: 1 },
      { levels: { model: 'gpt', prompt: 'v1' }, score: 0.8, n: 1 },
      { levels: { model: 'gpt', prompt: 'v2' }, score: 0.8, n: 1 },
    ]
    const report = causalAttribution(cells)
    const model = report.mainEffects.find((f) => f.factor === 'model')!
    const prompt = report.mainEffects.find((f) => f.factor === 'prompt')!
    expect(model.shareOfVariance).toBeGreaterThan(0.9)
    expect(prompt.shareOfVariance).toBeCloseTo(0, 2)
  })

  it('returns zero variance when all cells equal', () => {
    const cells: FactorialCell[] = [
      { levels: { m: 'a', p: 'x' }, score: 0.7, n: 1 },
      { levels: { m: 'a', p: 'y' }, score: 0.7, n: 1 },
      { levels: { m: 'b', p: 'x' }, score: 0.7, n: 1 },
      { levels: { m: 'b', p: 'y' }, score: 0.7, n: 1 },
    ]
    const r = causalAttribution(cells)
    expect(r.totalVariance).toBe(0)
    expect(r.mainEffects.every((e) => e.shareOfVariance === 0)).toBe(true)
  })

  it('throws when <4 cells or <2 factors', () => {
    expect(() => causalAttribution([{ levels: { m: 'a' }, score: 0.5, n: 1 }])).toThrow(/≥ 4 cells/)
  })
})

// ── active learning ──────────────────────────────────────────────────

describe('proposeSynthesisTargets', () => {
  it('flags difficulty gaps', async () => {
    const dataset = new Dataset({
      name: 'd',
      provenance: { version: '1.0', createdAt: new Date().toISOString() },
      scenarios: [
        { id: 'a', payload: {}, difficulty: 'easy' },
        { id: 'b', payload: {}, difficulty: 'easy' },
        // no hard/extreme
      ],
    })
    const store = new InMemoryTraceStore()
    const targets = await proposeSynthesisTargets(dataset, store, { minPerBand: 3 })
    expect(targets.some((t) => t.reason === 'difficulty-gap')).toBe(true)
  })

  it('flags failure-cluster when ≥3 runs fail with same class — regression: silent class-level weakness stays hidden', async () => {
    const store = new InMemoryTraceStore()
    for (let i = 0; i < 4; i++) {
      const e = new TraceEmitter(store)
      await e.startRun({ scenarioId: 's1' })
      const t = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await t.fail('500')
      const t2 = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await t2.fail('500')
      const t3 = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await t3.fail('500')
      await e.endRun({ pass: false })
    }
    const dataset = new Dataset({
      name: 'd',
      provenance: { version: '1.0', createdAt: new Date().toISOString() },
      scenarios: [{ id: 's1', payload: {} }],
    })
    const targets = await proposeSynthesisTargets(dataset, store)
    expect(targets.some((t) => t.reason === 'failure-cluster')).toBe(true)
  })
})

// ── reward-model export ──────────────────────────────────────────────

describe('exportRewardModel + loadScorerFromGrader', () => {
  it('export carries metadata + NDJSON training payload', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const llm = await e.span({
      kind: 'llm',
      name: 'gen',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      output: 'a normal-length output that passes the length rubric cleanly today',
    })
    await llm.end()
    await e.endRun({ pass: true, score: 0.9 })

    const grader = new PrmGrader([outputLengthRubric()])
    const exported = await exportRewardModel(store, grader, [e.runId])
    expect(exported.version).toBe('1.0')
    expect(exported.metadata.nSamples).toBeGreaterThan(0)
    expect(exported.metadata.rubrics).toContain('output-length')
    expect(exported.trainingNdjson.length).toBeGreaterThan(0)
  })

  it('loadScorerFromGrader + replay roundtrips through corpus', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const h = await e.span({
      kind: 'llm',
      name: 'gen',
      model: 'm',
      messages: [],
      output: 'good length output here that will score well on length rubric',
    })
    await h.end()
    await e.endRun({ pass: true, score: 0.8 })

    const grader = new PrmGrader([outputLengthRubric()])
    const scorer = loadScorerFromGrader(grader)
    const replayed = await replayScorerOverCorpus(store, scorer, [e.runId])
    expect(replayed).toHaveLength(1)
    expect(replayed[0].score).toBeGreaterThan(0)
    expect(replayed[0].outcomeScore).toBe(0.8)
  })
})
