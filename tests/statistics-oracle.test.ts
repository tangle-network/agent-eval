import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { welchsTTest } from '../src/baseline'
import { normalCdf } from '../src/math/normal'
import { studentTCdf } from '../src/math/student-t'
import type { SignTestAlternative } from '../src/statistics'
import {
  benjaminiHochberg,
  bonferroni,
  cliffsDelta,
  cohensD,
  holm,
  mannWhitneyU,
  mcnemar,
  mcnemarPower,
  mcnemarRequiredN,
  pairedCohensDz,
  pairedMde,
  pairedRiskDifference,
  pairedSignTest,
  pairedTTest,
  passAtK,
  pearsonR,
  ranks,
  requiredPairedSampleSize,
  requiredSampleSize,
  spearmanR,
  wilcoxonSignedRank,
  wilson,
} from '../src/statistics'

// scipy is this module's CI oracle. It is not a runtime dependency and never
// ships; the fixture below is the frozen output of
// `scripts/generate-statistics-oracle.py`, which is what makes a hand-rolled
// approximation unable to drift into being plausible on inspection and wrong
// by 3.7e-2.
//
// A failure here means one of two things: the implementation regressed, or a
// case was added to the generator and the fixture was not regenerated. It
// never means "loosen the tolerance".

interface OracleCase {
  fn: string
  args: unknown[]
  expect: unknown
  tolerance: number
  note?: string
}

interface Oracle {
  generator: string
  reference: Record<string, string>
  cases: OracleCase[]
}

const oracle: Oracle = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'statistics-oracle.json'), 'utf8'),
)

const nums = (value: unknown): number[] => value as number[]
const num = (value: unknown): number => value as number

/** Every case returns a flat map of named scalars, compared field by field. */
function evaluate(entry: OracleCase): Record<string, number> {
  const a = entry.args
  switch (entry.fn) {
    case 'normalCdf':
      return { value: normalCdf(num(a[0])) }
    case 'studentTCdf':
      return { value: studentTCdf(num(a[0]), num(a[1])) }
    case 'pairedTTest': {
      const r = pairedTTest(nums(a[0]), nums(a[1]))
      expect(r.t).not.toBeNull()
      expect(r.p).not.toBeNull()
      return { t: r.t as number, df: r.df, p: r.p as number }
    }
    case 'welchsTTest': {
      const r = welchsTTest(nums(a[0]), nums(a[1]))
      return { t: r.t, df: r.df, p: r.p }
    }
    case 'mannWhitneyU.exact': {
      const r = mannWhitneyU(nums(a[0]), nums(a[1]))
      expect(r.method).toBe('exact')
      return { u: r.u, p: r.p }
    }
    case 'mannWhitneyU.asymptotic': {
      const r = mannWhitneyU(nums(a[0]), nums(a[1]), { method: 'asymptotic' })
      return { p: r.p }
    }
    case 'wilcoxonSignedRank.exact': {
      const r = wilcoxonSignedRank(nums(a[0]), nums(a[1]))
      expect(r.method).toBe('exact')
      return { w: r.w, p: r.p }
    }
    case 'pairedSignTest':
      return { pValue: pairedSignTest(nums(a[0]), a[1] as SignTestAlternative).pValue }
    case 'mcnemar': {
      const r = mcnemar(nums(a[0]), nums(a[1]))
      return { b: r.b, c: r.c, pValue: r.pValue }
    }
    case 'wilson': {
      const r = wilson(num(a[0]), num(a[1]))
      return { estimate: r.estimate, lower: r.lower, upper: r.upper }
    }
    case 'passAtK':
      return { value: passAtK(num(a[0]), num(a[1]), num(a[2])) }
    case 'pearsonR':
      return { value: pearsonR(nums(a[0]), nums(a[1])) }
    case 'spearmanR':
      return { value: spearmanR(nums(a[0]), nums(a[1])) }
    case 'ranks':
      return Object.fromEntries(ranks(nums(a[0])).map((v, i) => [String(i), v]))
    case 'cohensD': {
      const d = cohensD(nums(a[0]), nums(a[1]))
      expect(d).not.toBeNull()
      return { value: d as number }
    }
    case 'cliffsDelta':
      return { value: cliffsDelta(nums(a[0]), nums(a[1])) }
    case 'pairedCohensDz': {
      const dz = pairedCohensDz(nums(a[0]), nums(a[1]))
      expect(dz).not.toBeNull()
      return { value: dz as number }
    }
    case 'pairedRiskDifference': {
      const r = pairedRiskDifference(nums(a[0]), nums(a[1]))
      return { riskDifference: r.riskDifference, lower: r.lower, upper: r.upper }
    }
    case 'requiredSampleSize':
      return {
        value: requiredSampleSize({ effect: num(a[0]), alpha: num(a[1]), power: num(a[2]) }),
      }
    case 'requiredPairedSampleSize':
      return {
        value: requiredPairedSampleSize({
          effect: num(a[0]),
          alpha: num(a[1]),
          power: num(a[2]),
        }),
      }
    case 'pairedMde':
      return { value: pairedMde({ nPaired: num(a[0]), alpha: num(a[1]), power: num(a[2]) }) }
    case 'mcnemarRequiredN':
      return {
        value: mcnemarRequiredN({
          p10: num(a[0]),
          p01: num(a[1]),
          alpha: num(a[2]),
          power: num(a[3]),
        }),
      }
    case 'mcnemarPower':
      return {
        value: mcnemarPower({
          p10: num(a[0]),
          p01: num(a[1]),
          nPairs: num(a[2]),
          alpha: num(a[3]),
        }),
      }
    default:
      throw new Error(`statistics-oracle: no evaluator for '${entry.fn}'`)
  }
}

/** Adjustment cases carry vectors plus booleans, so they get their own path. */
function evaluateCorrection(entry: OracleCase): {
  values: number[]
  significant: boolean[]
} {
  const pValues = nums(entry.args[0])
  const alpha = num(entry.args[1])
  if (entry.fn === 'bonferroni') {
    const r = bonferroni(pValues, alpha)
    return { values: r.adjusted, significant: r.significant }
  }
  if (entry.fn === 'holm') {
    const r = holm(pValues, alpha)
    return { values: r.adjusted, significant: r.significant }
  }
  const r = benjaminiHochberg(pValues, alpha)
  return { values: r.qValues, significant: r.significant }
}

const CORRECTIONS = new Set(['bonferroni', 'holm', 'benjaminiHochberg'])

describe(`statistics oracle (scipy ${oracle.reference.scipy}, statsmodels ${oracle.reference.statsmodels})`, () => {
  it('pins a non-trivial number of cases', () => {
    expect(oracle.cases.length).toBeGreaterThanOrEqual(150)
  })

  const byFn = new Map<string, OracleCase[]>()
  for (const entry of oracle.cases) {
    const bucket = byFn.get(entry.fn)
    if (bucket) bucket.push(entry)
    else byFn.set(entry.fn, [entry])
  }

  for (const [fn, entries] of byFn) {
    describe(fn, () => {
      entries.forEach((entry, index) => {
        it(`case ${index} — ${JSON.stringify(entry.args).slice(0, 90)}`, () => {
          if (CORRECTIONS.has(fn)) {
            const actual = evaluateCorrection(entry)
            const expected = entry.expect as {
              adjusted?: number[]
              qValues?: number[]
              significant: boolean[]
            }
            const expectedValues = expected.adjusted ?? expected.qValues ?? []
            expect(actual.values.length).toBe(expectedValues.length)
            for (let i = 0; i < expectedValues.length; i++) {
              expect(Math.abs(actual.values[i]! - expectedValues[i]!)).toBeLessThanOrEqual(
                entry.tolerance,
              )
            }
            expect(actual.significant).toEqual(expected.significant)
            return
          }

          const actual = evaluate(entry)
          const expected =
            typeof entry.expect === 'number'
              ? { value: entry.expect }
              : Array.isArray(entry.expect)
                ? Object.fromEntries(entry.expect.map((v, i) => [String(i), v as number]))
                : (entry.expect as Record<string, number>)

          for (const [key, want] of Object.entries(expected)) {
            const got = actual[key]
            expect(got, `${fn} field '${key}'`).toBeDefined()
            expect(
              Math.abs(got! - want),
              `${fn} field '${key}': got ${got}, want ${want}`,
            ).toBeLessThanOrEqual(entry.tolerance)
          }
        })
      })
    })
  }
})
