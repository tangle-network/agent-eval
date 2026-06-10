import { describe, expect, it } from 'vitest'
import {
  computeExperimentStats,
  type ExperimentProvenance,
  ExperimentTracker,
  improvementVerdict,
  inMemoryExperimentStore,
} from './experiment-tracker'

const PROV: ExperimentProvenance = { commit: 'abc1234', message: 'test', changedFiles: ['a.ts'] }

const reps = (scores: number[]) =>
  scores.map((score, i) => ({ rep: i, score, timestamp: '2026-01-01T00:00:00Z' }))

describe('computeExperimentStats', () => {
  it('reports median/mean/min/max/iqr/stddev over reps', () => {
    const s = computeExperimentStats(reps([50, 60, 70, 80, 90]))
    expect(s.n).toBe(5)
    expect(s.median).toBe(70)
    expect(s.mean).toBe(70)
    expect(s.min).toBe(50)
    expect(s.max).toBe(90)
    expect(s.stddev).toBeCloseTo(Math.sqrt(200), 6)
  })

  it('a tight sample is stable; a spread-out one is not (iqr floor)', () => {
    expect(computeExperimentStats(reps([70, 71, 72, 73, 74])).stable).toBe(true)
    expect(computeExperimentStats(reps([10, 40, 60, 90, 100])).stable).toBe(false)
  })

  it('passRate is the fraction of reps that set passed, null when none do', () => {
    const withPass = [
      { rep: 0, score: 1, timestamp: 't', passed: true },
      { rep: 1, score: 1, timestamp: 't', passed: false },
      { rep: 2, score: 1, timestamp: 't', passed: true },
    ]
    expect(computeExperimentStats(withPass).passRate).toBeCloseTo(2 / 3, 6)
    expect(computeExperimentStats(reps([1, 2, 3])).passRate).toBeNull()
  })

  it('a non-finite score fails loud', () => {
    expect(() => computeExperimentStats([{ rep: 0, score: Number.NaN, timestamp: 't' }])).toThrow(
      /non-finite/,
    )
  })
})

describe('improvementVerdict', () => {
  const stableHigh = computeExperimentStats(reps([80, 81, 82]))
  const stableLow = computeExperimentStats(reps([70, 71, 72]))

  it('KEEP when median delta clears the keep threshold', () => {
    const r = improvementVerdict(stableHigh, stableLow)
    expect(r.verdict).toBe('KEEP')
    expect(r.medianDelta).toBe(10)
  })

  it('REGRESSION when median delta falls past the negative threshold', () => {
    const r = improvementVerdict(stableLow, stableHigh)
    expect(r.verdict).toBe('REGRESSION')
    expect(r.medianDelta).toBe(-10)
  })

  it('NOISE when the delta sits inside the band', () => {
    const a = computeExperimentStats(reps([72, 73, 74]))
    const b = computeExperimentStats(reps([70, 71, 72]))
    expect(improvementVerdict(a, b).verdict).toBe('NOISE')
  })

  it('NOISE when the candidate is unstable, regardless of delta', () => {
    const unstable = computeExperimentStats(reps([10, 50, 99]))
    expect(improvementVerdict(unstable, stableLow).verdict).toBe('NOISE')
  })

  it('ITERATE with no parent or too few reps', () => {
    expect(improvementVerdict(stableHigh, null).verdict).toBe('ITERATE')
    const thin = computeExperimentStats(reps([80, 81]))
    expect(improvementVerdict(thin, stableLow).verdict).toBe('ITERATE')
  })

  it('thresholds are configurable', () => {
    const a = computeExperimentStats(reps([72, 73, 74]))
    const b = computeExperimentStats(reps([70, 71, 72]))
    expect(improvementVerdict(a, b, { keepThreshold: 1 }).verdict).toBe('KEEP')
  })
})

describe('ExperimentTracker', () => {
  const fixedNow = () => Date.parse('2026-02-02T00:00:00Z')
  const make = () =>
    new ExperimentTracker({
      store: inMemoryExperimentStore(),
      provenanceReader: () => PROV,
      now: fixedNow,
    })

  it('creates, appends reps, and recomputes the verdict against a parent', async () => {
    const t = make()
    await t.create({ id: 'base', label: 'baseline', changeSummary: 'init' })
    for (const s of [70, 71, 72]) await t.addRep('base', { score: s })

    await t.create({
      id: 'cand',
      label: 'candidate',
      changeSummary: 'tweak prompt',
      parentId: 'base',
    })
    let cand = await t.addRep('cand', { score: 80 })
    expect(cand.verdict).toBe('ITERATE') // only 1 rep
    await t.addRep('cand', { score: 81 })
    cand = await t.addRep('cand', { score: 82 })
    expect(cand.verdict).toBe('KEEP')
    expect(cand.provenance.commit).toBe('abc1234')

    const v = await t.verdictFor('cand')
    expect(v.medianDelta).toBe(10)
  })

  it('rejects a duplicate id and an unknown parent — fail loud', async () => {
    const t = make()
    await t.create({ id: 'x', label: 'x', changeSummary: 's' })
    await expect(t.create({ id: 'x', label: 'x', changeSummary: 's' })).rejects.toThrow(
      /already exists/,
    )
    await expect(
      t.create({ id: 'y', label: 'y', changeSummary: 's', parentId: 'nope' }),
    ).rejects.toThrow(/parent/)
  })

  it('persists through the injected store across instances', async () => {
    const store = inMemoryExperimentStore()
    const a = new ExperimentTracker({ store, provenanceReader: () => PROV, now: fixedNow })
    await a.create({ id: 'persisted', label: 'p', changeSummary: 's' })
    await a.addRep('persisted', { score: 5 })
    const b = new ExperimentTracker({ store, provenanceReader: () => PROV, now: fixedNow })
    const got = await b.get('persisted')
    expect(got?.reps).toHaveLength(1)
  })
})
