import { ValidationError } from '../errors'
import { normalCdf } from '../math/normal'
import { lnGamma, regularizedIncompleteBeta } from '../math/special-functions'
import { assertFiniteSample } from './internal'

/** Two-sided normal tail, evaluated without subtracting a near-one CDF. */
export function normalTwoSidedPValue(z: number): number {
  if (Number.isNaN(z)) throw new ValidationError('normalTwoSidedPValue: z must not be NaN')
  return Math.min(1, 2 * normalCdf(-Math.abs(z)))
}

/** Two-sided Student-t tail, preserving small tail probabilities. */
export function studentTTwoSidedPValue(t: number, df: number): number {
  if (Number.isNaN(t) || !Number.isFinite(df) || df <= 0) {
    throw new ValidationError(
      'studentTTwoSidedPValue: t must not be NaN and df must be positive and finite',
    )
  }
  return regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5)
}

function table(a: number, b: number, c: number, d: number): number {
  if (
    ![a, b, c, d].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isSafeInteger(a + b + c + d)
  ) {
    throw new ValidationError(
      'contingency table: counts and total must be nonnegative safe integers',
    )
  }
  return a + b + c + d
}

/** Pearson statistic for a 2x2 table; empty or fixed margins have statistic zero. */
export function chiSquared(a: number, b: number, c: number, d: number): number {
  const n = table(a, b, c, d)
  if (!n) return 0
  const expected = [
    ((a + b) * (a + c)) / n,
    ((a + b) * (b + d)) / n,
    ((c + d) * (a + c)) / n,
    ((c + d) * (b + d)) / n,
  ]
  if (expected.some((value) => value === 0)) return 0
  return [a, b, c, d].reduce((sum, value, i) => sum + (value - expected[i]!) ** 2 / expected[i]!, 0)
}

/** One-degree-of-freedom chi-squared survival probability. */
export function chiSquaredPValue(statistic: number): number {
  if (Number.isNaN(statistic) || statistic < 0) {
    throw new ValidationError('chiSquaredPValue: statistic must be nonnegative and not NaN')
  }
  return normalTwoSidedPValue(Math.sqrt(statistic))
}

/** Fisher two-sided probability: sum all fixed-margin tables no likelier than the observed table. */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const n = table(a, b, c, d),
    row1 = a + b,
    row2 = c + d,
    col1 = a + c
  if (!n || !row1 || !row2 || !col1 || col1 === n) return 1
  const logChoose = (total: number, count: number) =>
    lnGamma(total + 1) - lnGamma(count + 1) - lnGamma(total - count + 1)
  const denominator = logChoose(n, col1)
  const logP = (count: number) =>
    logChoose(row1, count) + logChoose(row2, col1 - count) - denominator
  const threshold = logP(a) + 1e-7
  let p = 0
  for (let k = Math.max(0, col1 - row2); k <= Math.min(row1, col1); k++) {
    const probability = logP(k)
    if (probability <= threshold) p += Math.exp(probability)
  }
  return Math.min(1, p)
}

/** Fisher when any expected count is below five; otherwise Pearson's chi-squared tail. */
export function twoByTwoPValue(a: number, b: number, c: number, d: number): number {
  const n = table(a, b, c, d)
  if (!n) return 1
  const minimum =
    Math.min((a + b) * (a + c), (a + b) * (b + d), (c + d) * (a + c), (c + d) * (b + d)) / n
  return minimum < 5 ? fisherExactTwoSided(a, b, c, d) : chiSquaredPValue(chiSquared(a, b, c, d))
}

export interface LinearRegressionResult {
  slope: number
  rSquared: number
  slopePValue: number | null
}

/** Centered least-squares slope; null p-value means no slope test was possible. */
export function linearRegressionSlope(
  points: readonly { x: number; y: number }[],
): LinearRegressionResult {
  assertFiniteSample(
    'linearRegressionSlope',
    'x',
    points.map((point) => point.x),
  )
  assertFiniteSample(
    'linearRegressionSlope',
    'y',
    points.map((point) => point.y),
  )
  if (points.length < 2) return { slope: 0, rSquared: 0, slopePValue: null }
  const n = points.length
  const meanX = points.reduce((sum, point) => sum + point.x / n, 0)
  const meanY = points.reduce((sum, point) => sum + point.y / n, 0)
  const sxx = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
  const syy = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0)
  const sxy = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0)
  if (!sxx) return { slope: 0, rSquared: 0, slopePValue: null }
  const slope = sxy / sxx
  const residual = points.reduce(
    (sum, point) => sum + (point.y - meanY - slope * (point.x - meanX)) ** 2,
    0,
  )
  if (![slope, residual, sxx, sxy, syy].every(Number.isFinite)) {
    throw new ValidationError('linearRegressionSlope: sample arithmetic exceeded finite range')
  }
  const rSquared = syy === 0 ? 0 : Math.max(0, 1 - residual / syy)
  const slopePValue =
    n < 3
      ? null
      : residual === 0
        ? slope === 0
          ? 1
          : 0
        : studentTTwoSidedPValue(slope / Math.sqrt(residual / (n - 2) / sxx), n - 2)
  return { slope, rSquared, slopePValue }
}
