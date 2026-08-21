/**
 * Shared internals for the statistics modules. Nothing here is part of the
 * public statistics surface — `./index` does not re-export this module.
 */

import { ValidationError } from '../errors'
import { lnGamma } from '../math/special-functions'
import { mulberry32 } from './random'

/** Every rank test refuses non-finite input. Beyond the arithmetic being
 *  undefined, the tie-grouping scan compares values with `===`, and
 *  `NaN === NaN` is false, so a NaN would leave the group boundary unable to
 *  advance and spin the loop forever. */
export function assertFiniteSample(fn: string, label: string, xs: readonly number[]): void {
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i])) {
      throw new ValidationError(`${fn}: ${label}[${i}] must be finite, got ${xs[i]}`)
    }
  }
}

/**
 * Two-sided exact p-value for b successes out of (b + c) Bernoulli(0.5) trials —
 * the exact-binomial core of {@link mcnemar}. `min(1, 2·P(X ≤ min(b,c)))`. No
 * discordant pairs ⇒ no evidence ⇒ p = 1. Summed in log space (lnGamma) so it
 * stays exact at large discordant counts without overflow.
 */
export function binomialSignTwoSided(b: number, c: number): number {
  const nd = b + c
  if (nd === 0) return 1
  return Math.min(1, 2 * binomialHalfLowerTail(Math.min(b, c), nd))
}

/** P(X >= successes) for X ~ Binomial(n, 0.5). */
export function binomialHalfUpperTail(successes: number, n: number): number {
  if (successes <= 0) return 1
  if (successes > n) return 0

  // Use the smaller side of the distribution. For lower thresholds the
  // complement sums at most half the mass; for upper thresholds symmetry
  // maps the upper tail to a lower tail without subtraction.
  if (successes <= n / 2) {
    return Math.max(0, 1 - binomialHalfLowerTail(successes - 1, n))
  }
  return binomialHalfLowerTail(n - successes, n)
}

/** P(X <= maxSuccesses) for X ~ Binomial(n, 0.5), accumulated in log space. */
function binomialHalfLowerTail(maxSuccesses: number, n: number): number {
  if (maxSuccesses < 0) return 0
  if (maxSuccesses >= n) return 1
  if (maxSuccesses === 0) return 2 ** -n

  const logHalfN = n * Math.log(0.5)
  let logTail = Number.NEGATIVE_INFINITY
  for (let i = 0; i <= maxSuccesses; i++) {
    const logChoose = lnGamma(n + 1) - lnGamma(i + 1) - lnGamma(n - i + 1)
    logTail = logAddExp(logTail, logChoose + logHalfN)
  }
  return Math.min(1, Math.exp(logTail))
}

function logAddExp(a: number, b: number): number {
  if (a === Number.NEGATIVE_INFINITY) return b
  if (b === Number.NEGATIVE_INFINITY) return a
  const max = Math.max(a, b)
  const min = Math.min(a, b)
  return max + Math.log1p(Math.exp(min - max))
}

/** Standard-normal inverse CDF (Acklam approximation). */
export function zQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p === 0) return -Infinity
    if (p === 1) return Infinity
    return NaN
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  let q: number
  let r: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    )
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  )
}

export function medianInPlace(xs: number[]): number {
  if (xs.length === 0) return 0
  xs.sort((a, b) => a - b)
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!
}

/**
 * PRNG for every resampling path in this module.
 *
 * With no caller seed the seed is DERIVED FROM THE DATA rather than taken from
 * `Math.random`, so re-running the same input reproduces the same interval —
 * a gate verdict that cannot be re-derived is not evidence. Distinct data
 * still gets a distinct stream. Same pattern as `promotion-gate.ts`.
 */
export function makeRng(
  seed: number | undefined,
  ...series: readonly (readonly number[])[]
): () => number {
  return mulberry32(seed ?? seedFromData(series))
}

/** FNV-1a over the IEEE-754 bytes of every observation. */
function seedFromData(series: readonly (readonly number[])[]): number {
  const view = new DataView(new ArrayBuffer(8))
  // 32-bit FNV-1a over the IEEE-754 BYTES of each observation, not over a
  // string. Frozen: it seeds the unseeded bootstrap from the data itself, so a
  // change moves every interval this package has already published. The
  // string-input variants elsewhere cannot be substituted here.
  let hash = 0x811c9dc5
  for (const xs of series) {
    for (const x of xs) {
      view.setFloat64(0, x)
      for (let byte = 0; byte < 8; byte++) {
        hash = Math.imul(hash ^ view.getUint8(byte), 0x01000193)
      }
    }
    // Separator, so ([1],[2]) and ([1,2],[]) do not collide.
    hash = Math.imul(hash ^ 0xff, 0x01000193)
  }
  return hash | 0
}

/** Order-independent seed for a symmetric two-sample statistic. */
export function symmetricTwoSampleSeed(a: readonly number[], b: readonly number[]): number {
  const sortedA = [...a].sort((left, right) => left - right)
  const sortedB = [...b].sort((left, right) => left - right)
  const forward = seedFromData([sortedA, sortedB]) >>> 0
  const reversed = seedFromData([sortedB, sortedA]) >>> 0
  return Math.min(forward, reversed)
}
