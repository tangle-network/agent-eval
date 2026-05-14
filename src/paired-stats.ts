/**
 * Paper-grade paired statistics for held-out promotion gates.
 *
 * The promotion gate (`HeldOutGate`) needs three things:
 *
 *   1. A bootstrap confidence interval on the per-item paired delta
 *      (`pairedBootstrap`). Median delta is the headline number; the
 *      CI lower bound is what the gate checks against `pairedDeltaThreshold`.
 *   2. A non-parametric significance test on the paired deltas
 *      (`pairedWilcoxon` — re-export of `wilcoxonSignedRank` under the
 *      paper-style name).
 *   3. False-discovery-rate correction across simultaneously-tested
 *      candidate variants (`bhAdjust` — re-export of `benjaminiHochberg`).
 *
 * Why a separate file: every existing primitive lives in `statistics.ts`
 * (general) or `power-analysis.ts` (correction). Paired-bootstrap is
 * paired-only, paper-grade, and load-bearing for the promotion gate.
 * Putting it next to `statistics.ts` would require editing that file;
 * the brief forbids that. New file, new exports, no surface change.
 */

import { benjaminiHochberg } from './power-analysis'
import { wilcoxonSignedRank } from './statistics'

export interface PairedBootstrapResult {
  /** Number of paired observations (after dropping unequal lengths is rejected). */
  n: number
  /** Median of paired deltas (after − before). */
  median: number
  /** Mean of paired deltas. */
  mean: number
  /** Lower bound of the bootstrap CI on the median delta. */
  low: number
  /** Upper bound of the bootstrap CI on the median delta. */
  high: number
  /** Confidence level used (e.g. 0.95). */
  confidence: number
  /** Number of bootstrap resamples used. */
  resamples: number
}

export interface PairedBootstrapOptions {
  /** Confidence level. Default 0.95. */
  confidence?: number
  /** Bootstrap resample count. Default 2000. */
  resamples?: number
  /** Statistic to bootstrap. Default 'median'. */
  statistic?: 'median' | 'mean'
  /** Deterministic seed. If omitted, uses Math.random(). */
  seed?: number
}

/**
 * Paired bootstrap on (after - before) deltas. Returns a CI on the
 * chosen statistic (median by default). Pairs are resampled with
 * replacement. The lower bound is what the promotion gate checks: if
 * `low > pairedDeltaThreshold`, the gain is real at the chosen
 * confidence level.
 *
 * Throws on unequal sample sizes — caller must align pairs upstream.
 */
export function pairedBootstrap(
  before: number[],
  after: number[],
  opts: PairedBootstrapOptions = {},
): PairedBootstrapResult {
  if (before.length !== after.length) {
    throw new Error(`pairedBootstrap: unequal sample sizes (${before.length} vs ${after.length})`)
  }
  const confidence = opts.confidence ?? 0.95
  const resamples = opts.resamples ?? 2000
  const statistic = opts.statistic ?? 'median'
  if (confidence <= 0 || confidence >= 1) {
    throw new Error(`pairedBootstrap: confidence must be in (0,1), got ${confidence}`)
  }

  const n = before.length
  const deltas = before.map((b, i) => after[i]! - b)
  if (n === 0) {
    return { n: 0, median: 0, mean: 0, low: 0, high: 0, confidence, resamples }
  }
  if (n === 1) {
    const d = deltas[0]!
    return { n: 1, median: d, mean: d, low: d, high: d, confidence, resamples }
  }

  const rng = makeRng(opts.seed)
  const samples = new Array<number>(resamples)
  for (let b = 0; b < resamples; b++) {
    let acc: number[] | null = null
    if (statistic === 'mean') {
      let sum = 0
      for (let k = 0; k < n; k++) {
        sum += deltas[Math.floor(rng() * n)]!
      }
      samples[b] = sum / n
    } else {
      acc = new Array<number>(n)
      for (let k = 0; k < n; k++) {
        acc[k] = deltas[Math.floor(rng() * n)]!
      }
      samples[b] = medianInPlace(acc)
    }
  }
  samples.sort((a, b) => a - b)

  const alpha = 1 - confidence
  const lowIdx = Math.floor((alpha / 2) * resamples)
  const highIdx = Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)

  return {
    n,
    median: medianInPlace([...deltas]),
    mean: deltas.reduce((s, x) => s + x, 0) / n,
    low: samples[lowIdx]!,
    high: samples[Math.max(highIdx, lowIdx)]!,
    confidence,
    resamples,
  }
}

/**
 * Paper-style alias for `wilcoxonSignedRank`. The signed-rank test on
 * paired deltas is the standard non-parametric significance test for
 * "candidate beats baseline on matched items." Use alongside the
 * bootstrap CI: bootstrap gives effect size, Wilcoxon gives p.
 */
export function pairedWilcoxon(before: number[], after: number[]): { w: number; p: number } {
  return wilcoxonSignedRank(before, after)
}

/**
 * Paper-style alias for `benjaminiHochberg`. Use to correct p-values
 * across multiple candidate-vs-baseline comparisons run in the same
 * promotion sweep. Returns BH-adjusted q-values and significance at
 * the requested FDR (default 0.05).
 */
export function bhAdjust(
  pValues: number[],
  fdr = 0.05,
): { qValues: number[]; significant: boolean[] } {
  return benjaminiHochberg(pValues, fdr)
}

// ── Helpers ──────────────────────────────────────────────────────────

function medianInPlace(xs: number[]): number {
  if (xs.length === 0) return 0
  xs.sort((a, b) => a - b)
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!
}

/**
 * Tiny seedable PRNG (mulberry32). Deterministic given a seed; falls
 * back to Math.random when seed is omitted. Adequate for bootstrap
 * resampling — not cryptographic.
 */
function makeRng(seed: number | undefined): () => number {
  if (seed === undefined) return Math.random
  let s = seed | 0 || 0x9e3779b9
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
