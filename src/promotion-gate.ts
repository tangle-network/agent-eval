/**
 * Bootstrap-CI promotion gate.
 *
 * In any iterative-improvement loop (GEPA, prompt evolution, dataset
 * curation), the question is "did this generation actually improve, or are
 * we celebrating noise?". With small N and noisy outcomes, point-estimate
 * deltas lie. Bootstrap confidence intervals tell the operator whether the
 * delta is real before code or prompts get promoted.
 *
 * This module is pure functions — no I/O, no model calls. Easy to unit-test
 * and to compose into any verdict gate.
 *
 * Default gate:
 *   - Bootstrap mean baseline vs candidate (1k resamples).
 *   - Compute the delta distribution; pass if the lower CI bound > 0.
 *   - Tunable confidence (default 95%) and resample count.
 *
 * Verdict semantics intentionally match the existing `experiments.jsonl`
 * vocabulary:
 *   - ADVANCE: candidate's CI lower bound > baseline mean (real win)
 *   - KEEP:    overlap, but candidate point estimate >= baseline (neutral)
 *   - REVERT:  candidate's CI upper bound < baseline mean (real regression)
 *   - INCONCLUSIVE: not enough samples or CI straddles zero with no signal
 */

export type Verdict = 'ADVANCE' | 'KEEP' | 'REVERT' | 'INCONCLUSIVE'

export interface BootstrapResult {
  baselineMean: number
  candidateMean: number
  /** candidateMean - baselineMean, point estimate. */
  delta: number
  /** Lower bound of the (1 - alpha) CI on the delta. */
  ciLower: number
  /** Upper bound of the (1 - alpha) CI on the delta. */
  ciUpper: number
  /** Number of bootstrap resamples used. */
  iterations: number
  alpha: number
  verdict: Verdict
}

export interface BootstrapOptions {
  /** Confidence level alpha (default 0.05 → 95% CI). */
  alpha?: number
  /** Number of resamples (default 1000). */
  iterations?: number
  /**
   * Minimum total samples (baseline + candidate) below which we always
   * return INCONCLUSIVE — bootstrap with too few samples is meaningless.
   * Default 6 (combined).
   */
  minTotalSamples?: number
  /** RNG seed for reproducibility. Default: Math.random. */
  seed?: number
}

/**
 * Compute the bootstrap CI on (candidateMean - baselineMean) and a verdict.
 *
 * Uses simple percentile bootstrap on the difference of resampled means.
 * That's the standard non-parametric primitive — no distributional
 * assumptions, robust to skew, easy to reason about.
 */
export function bootstrapCi(
  baseline: number[],
  candidate: number[],
  options: BootstrapOptions = {},
): BootstrapResult {
  const alpha = options.alpha ?? 0.05
  const iterations = options.iterations ?? 1000
  const minTotal = options.minTotalSamples ?? 6
  const rng = mulberry32(options.seed ?? hashSeed(baseline, candidate))

  const baselineMean = mean(baseline)
  const candidateMean = mean(candidate)
  const delta = candidateMean - baselineMean

  if (baseline.length + candidate.length < minTotal || baseline.length === 0 || candidate.length === 0) {
    return {
      baselineMean,
      candidateMean,
      delta,
      ciLower: -Infinity,
      ciUpper: Infinity,
      iterations: 0,
      alpha,
      verdict: 'INCONCLUSIVE',
    }
  }

  const deltas: number[] = new Array(iterations)
  for (let i = 0; i < iterations; i++) {
    const bResample = resample(baseline, rng)
    const cResample = resample(candidate, rng)
    deltas[i] = mean(cResample) - mean(bResample)
  }
  deltas.sort((a, b) => a - b)
  const lowerIdx = Math.floor((alpha / 2) * iterations)
  const upperIdx = Math.floor((1 - alpha / 2) * iterations) - 1
  const ciLower = deltas[Math.max(0, lowerIdx)]!
  const ciUpper = deltas[Math.min(iterations - 1, upperIdx)]!

  let verdict: Verdict
  if (ciLower > 0) verdict = 'ADVANCE'
  else if (ciUpper < 0) verdict = 'REVERT'
  else if (delta >= 0) verdict = 'KEEP'
  else verdict = 'INCONCLUSIVE'

  return {
    baselineMean,
    candidateMean,
    delta,
    ciLower,
    ciUpper,
    iterations,
    alpha,
    verdict,
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function resample(xs: number[], rng: () => number): number[] {
  const out = new Array(xs.length)
  for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rng() * xs.length)]
  return out
}

/** Mulberry32 — fast deterministic PRNG. Stable across runs given the same seed. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable seed derived from the inputs — same data → same CI bounds. */
function hashSeed(a: number[], b: number[]): number {
  let h = 2166136261
  for (const x of [...a, ...b]) {
    const view = new Float64Array([x])
    const bytes = new Uint8Array(view.buffer)
    for (const byte of bytes) {
      h ^= byte
      h = Math.imul(h, 16777619)
    }
  }
  return h >>> 0
}
