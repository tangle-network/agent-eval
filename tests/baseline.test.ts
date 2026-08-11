import { describe, expect, it } from 'vitest'
import { compareToBaseline, welchsTTest } from '../src/baseline'

describe('welchsTTest / compareToBaseline — the unguarded promotion path', () => {
  it('matches scipy.stats.ttest_ind(equal_var=False)', () => {
    const CASES: Array<{ a: number[]; b: number[]; t: number; df: number; p: number }> = [
      {
        a: [0.4, 0.5, 0.6, 0.55, 0.45, 0.5],
        b: [0.7, 0.8, 0.75, 0.72, 0.78, 0.74],
        t: 7.617523199624095,
        df: 7.559315598935626,
        p: 8.368400396856913e-5,
      },
      { a: [1, 2, 3, 4, 5], b: [2, 3, 4, 5, 6], t: 1.0, df: 8.0, p: 0.34659350708733416 },
      { a: [10, 12, 14, 16], b: [11, 11, 15, 15], t: 0.0, df: 5.926829268292685, p: 1.0 },
    ]
    for (const { a, b, t, df, p } of CASES) {
      const r = welchsTTest(a, b)
      expect(r.status).toBe('ok')
      expect(r.t).toBeCloseTo(t, 12)
      expect(r.df).toBeCloseTo(df, 12)
      expect(r.p).toBeCloseTo(p, 12)
    }
  })

  it('returns the complete Welch result with a Student-t 95% interval', () => {
    const r = welchsTTest([0.4, 0.5, 0.6, 0.55, 0.45, 0.5], [0.7, 0.8, 0.75, 0.72, 0.78, 0.74])
    expect(r).toMatchObject({
      status: 'ok',
      ci95: expect.any(Array),
    })
    expect(r.meanA).toBeCloseTo(0.5, 12)
    expect(r.meanB).toBeCloseTo(0.7483333333333334, 12)
    expect(r.delta).toBeCloseTo(0.2483333333333334, 12)
    expect(r.standardError).toBeCloseTo(0.03260027266416307, 12)
    expect(r.ci95![0]).toBeCloseTo(0.17238725256665494, 12)
    expect(r.ci95![1]).toBeCloseTo(0.3242794141000119, 12)
    expect(r.cohensD).toBeCloseTo(4.397979069861191, 12)
  })

  it('marks fewer than two observations per side as insufficient', () => {
    const r = welchsTTest([1], [2])
    expect(r.status).toBe('insufficient-sample')
    expect(r.meanA).toBe(1)
    expect(r.meanB).toBe(2)
    expect(r.delta).toBe(1)
    expect(r.standardError).toBeNaN()
    expect(r.t).toBeNaN()
    expect(r.df).toBeNaN()
    expect(r.p).toBeNaN()
    expect(r.ci95).toBeNull()
    expect(r.cohensD).toBeNull()
  })

  it('does not fabricate certainty for separated constant samples', () => {
    const r = welchsTTest(Array<number>(32).fill(0.25), Array<number>(32).fill(0.75))
    expect(r.status).toBe('zero-variance')
    expect(r.meanA).toBe(0.25)
    expect(r.meanB).toBe(0.75)
    expect(r.delta).toBe(0.5)
    expect(r.standardError).toBe(0)
    expect(r.t).toBe(Number.POSITIVE_INFINITY)
    expect(r.df).toBeNaN()
    expect(r.p).toBeNaN()
    expect(r.ci95).toBeNull()
    expect(r.cohensD).toBeNull()
  })

  it('drives improved / regressed / stable verdicts off those numbers', () => {
    const report = compareToBaseline([
      {
        metric: 'overallScore',
        higherIsBetter: true,
        baseline: [0.4, 0.5, 0.6, 0.55, 0.45, 0.5],
        candidate: [0.7, 0.8, 0.75, 0.72, 0.78, 0.74],
      },
      {
        metric: 'latencyMs',
        higherIsBetter: false,
        baseline: [100, 101, 102, 103, 100, 101],
        candidate: [100, 102, 101, 103, 101, 100],
      },
    ])
    expect(report.metrics[0]!.verdict).toBe('improved')
    expect(report.metrics[0]!.welchP).toBeCloseTo(8.368400396856913e-5, 12)
    expect(report.metrics[0]!.cohensD).toBeCloseTo(4.397979069861191, 12)
    expect(report.metrics[1]!.verdict).toBe('stable')
    expect(report.hasRegression).toBe(false)
  })

  it('reports a regression in the "worse" direction for a lower-is-better metric', () => {
    const report = compareToBaseline([
      {
        metric: 'latencyMs',
        higherIsBetter: false,
        baseline: [100, 101, 102, 103, 100, 101],
        candidate: [140, 141, 142, 143, 140, 141],
      },
    ])
    expect(report.metrics[0]!.verdict).toBe('regressed')
    expect(report.hasRegression).toBe(true)
  })

  it('does not promote a separated constant sample without defined inference', () => {
    const report = compareToBaseline([
      {
        metric: 'passRate',
        higherIsBetter: true,
        baseline: [0, 0, 0],
        candidate: [1, 1, 1],
      },
    ])
    expect(report.metrics[0]!.cohensD).toBeNull()
    expect(report.metrics[0]!.welchP).toBeNaN()
    expect(report.metrics[0]!.verdict).toBe('stable')
  })
})
