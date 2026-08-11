import { regularizedIncompleteBeta } from '../math/special-functions'
import { binomialSignTwoSided, zQuantile } from './internal'

// ── Binomial proportion + paired-binary + coding-eval estimators ─────
//
// The paired family above (pairedBootstrap/pairedTTest/wilcoxonSignedRank)
// operates on continuous scores. Pass/fail A/B comparisons — "does treatment
// X raise the success RATE vs control" — are binary and paired, so they need
// their own correct estimators: McNemar for significance (only the discordant
// pairs carry signal), the paired risk difference for effect size, Wilson for
// a single-arm proportion CI, and pass@k for the standard k-sample coding-eval
// metric. The normal approximation is wrong for proportions near 0/1 and for
// the small discordant counts typical of eval runs, so these are exact /
// Wilson-based, not Wald.

/** A binomial proportion estimate with a confidence interval. */
export interface ProportionInterval {
  /** Point estimate successes / n (0 when n = 0). */
  estimate: number
  /** Lower bound, clamped to [0, 1]. */
  lower: number
  /** Upper bound, clamped to [0, 1]. */
  upper: number
}

/**
 * Wilson score interval for a binomial proportion. Correct at small n and near
 * 0/1, where the normal (Wald) approximation produces bounds outside [0, 1] and
 * understates coverage. Use this for any pass-rate / hit-rate / realness-rate
 * CI — the continuous `confidenceInterval` assumes the wrong distribution for a
 * proportion. `n = 0 ⇒ {0, 0, 0}`.
 */
export function wilson(successes: number, n: number, confidence = 0.95): ProportionInterval {
  if (n <= 0) return { estimate: 0, lower: 0, upper: 0 }
  if (successes < 0 || successes > n) {
    throw new Error(`wilson: successes (${successes}) must be in [0, ${n}]`)
  }
  const z = zQuantile(1 - (1 - confidence) / 2)
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
  return {
    estimate: p,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  }
}

/**
 * Are these per-item outcomes binary (every value exactly 0 or 1)?
 *
 * The discriminator a promotion gate needs before choosing a paired statistic.
 * On binary outcomes the paired delta vector lives in {-1, 0, +1} and is
 * normally dominated by zeros (both arms solve, or both arms miss, most items),
 * so its MEDIAN is pinned at exactly 0 no matter how large the real shift in
 * success rate is — and a bootstrap CI on that median collapses to [0, 0].
 * A gate keying on `ci.low > threshold` is then structurally unable to see
 * either a gain or a regression. Detect this shape and switch to the
 * paired-binary estimators ({@link mcnemar}, {@link pairedRiskDifference})
 * instead of silently answering "no" forever.
 *
 * Empty input is NOT binary: there is no evidence of the outcome's shape, and
 * defaulting an empty vector into the binary branch would pick a statistic on
 * no data at all.
 *
 * NOT the right discriminator for a gate. It recognises the literal {0, 1}
 * encoding and nothing else, so a pass/fail dimension emitted on 0-100 — which
 * judges in this codebase do routinely — reads as non-binary, and a single
 * partial-credit score in an otherwise pass/fail vector flips it to false while
 * leaving the median just as blind. Gates want {@link pairedBinaryScale} (any
 * two-point encoding). This predicate remains for callers that specifically
 * mean "literally 0/1".
 */
export function isBinaryOutcomeVector(values: ArrayLike<number>): boolean {
  if (values.length === 0) return false
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (v !== 0 && v !== 1) return false
  }
  return true
}

/** Result of a McNemar paired-binary significance test. */
export interface McNemarResult {
  /** Total paired observations. */
  n: number
  /** Discordant pairs (b + c) — the only ones that carry signal. */
  nDiscordant: number
  /** Pairs where treatment succeeded and control failed ("newly correct"). */
  b: number
  /** Pairs where control succeeded and treatment failed ("newly wrong"). */
  c: number
  /** Continuity-corrected chi-square statistic (reference; exact p drives the call). */
  statistic: number
  /** Two-sided p-value. Exact (binomial sign test on discordant pairs). */
  pValue: number
}

/**
 * McNemar's test for paired binary outcomes — the correct significance test for
 * "does treatment change the success rate vs control on the SAME items". Only
 * discordant pairs (one arm right, the other wrong) carry information; concordant
 * pairs are uninformative, so a paired t-test / two-proportion z-test on the raw
 * rates is wrong here. The p-value is exact: under H0 the b "treatment-wins" are
 * Binomial(b + c, 0.5), so the two-sided p is the doubled binomial tail — correct
 * at the small discordant counts typical of eval runs (no continuity-corrected
 * chi-square approximation needed, though it is returned as `statistic` for
 * reference). Inputs are paired 0/1 (or boolean) arrays, control first to match
 * the module's (before, after) convention. Throws on unequal lengths.
 */
export function mcnemar(
  control: ArrayLike<number | boolean>,
  treatment: ArrayLike<number | boolean>,
): McNemarResult {
  if (control.length !== treatment.length) {
    throw new Error(`mcnemar: unequal sample sizes (${control.length} vs ${treatment.length})`)
  }
  const n = control.length
  let b = 0 // treatment 1, control 0
  let c = 0 // treatment 0, control 1
  for (let i = 0; i < n; i++) {
    const ctrl = control[i] ? 1 : 0
    const treat = treatment[i] ? 1 : 0
    if (treat === 1 && ctrl === 0) b++
    else if (treat === 0 && ctrl === 1) c++
  }
  const nDiscordant = b + c
  const statistic = nDiscordant === 0 ? 0 : (Math.abs(b - c) - 1) ** 2 / nDiscordant
  return { n, nDiscordant, b, c, statistic, pValue: binomialSignTwoSided(b, c) }
}

/** A paired binary effect size (treatment rate − control rate) with a CI. */
export interface RiskDifferenceResult {
  /** Total paired observations. */
  n: number
  /** Discordant pairs: treatment-win count. */
  b: number
  /** Discordant pairs: control-win count. */
  c: number
  /** Paired risk difference p(treatment) − p(control) = (b − c) / n. */
  riskDifference: number
  /** Lower bound of the CI, clamped to [-1, 1]. */
  lower: number
  /** Upper bound of the CI, clamped to [-1, 1]. */
  upper: number
  /** Confidence level used. */
  confidence: number
}

/**
 * Paired risk difference (the effect-size companion to {@link mcnemar}): the
 * change in success rate p(treatment) − p(control) on matched items, which for
 * paired binary data equals (b − c) / n. The CI uses the paired variance from
 * the discordant counts, not the independent-samples formula (which overstates
 * the interval by ignoring the pairing). Inputs are paired 0/1 (or boolean)
 * arrays, control first. Throws on unequal lengths.
 *
 * REPORTING ONLY — do NOT decide a promotion on this interval. The CI is a Wald
 * normal approximation, which badly UNDERCOVERS when only a handful of pairs are
 * discordant: at n = 3 with b = 2, c = 0 it returns [0.133, 1.000], excluding 0,
 * while McNemar's exact test on the same data gives p = 0.50. A gate keying on
 * `lower > 0` would promote noise. Use {@link pairedRiskDifferenceExact}, whose
 * interval is dual to the exact test by construction, for any decision.
 */
export function pairedRiskDifference(
  control: ArrayLike<number | boolean>,
  treatment: ArrayLike<number | boolean>,
  confidence = 0.95,
): RiskDifferenceResult {
  if (control.length !== treatment.length) {
    throw new Error(
      `pairedRiskDifference: unequal sample sizes (${control.length} vs ${treatment.length})`,
    )
  }
  const n = control.length
  if (n === 0) return { n: 0, b: 0, c: 0, riskDifference: 0, lower: 0, upper: 0, confidence }
  let b = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    const ctrl = control[i] ? 1 : 0
    const treat = treatment[i] ? 1 : 0
    if (treat === 1 && ctrl === 0) b++
    else if (treat === 0 && ctrl === 1) c++
  }
  const rd = (b - c) / n
  const variance = (b + c - (b - c) ** 2 / n) / (n * n)
  const z = zQuantile(1 - (1 - confidence) / 2)
  const half = z * Math.sqrt(Math.max(0, variance))
  return {
    n,
    b,
    c,
    riskDifference: rd,
    lower: Math.max(-1, rd - half),
    upper: Math.min(1, rd + half),
    confidence,
  }
}

/** A paired binary effect size with an EXACT interval and the exact test that
 *  bounds it — one object so a caller cannot read the estimate without the
 *  significance it is entitled to. */
export interface ExactRiskDifferenceResult {
  /** Total paired observations. */
  n: number
  /** Discordant pairs: treatment-win count. */
  b: number
  /** Discordant pairs: control-win count. */
  c: number
  /** Discordant pairs (b + c) — the only ones carrying information. */
  nDiscordant: number
  /** Paired risk difference p(treatment) − p(control) = (b − c) / n. */
  riskDifference: number
  /** Exact conditional CI lower bound. 0 when there are no discordant pairs. */
  lower: number
  /** Exact conditional CI upper bound. 0 when there are no discordant pairs. */
  upper: number
  /** Confidence level used. */
  confidence: number
  /** McNemar's exact two-sided p-value on the same discordant counts. */
  pValue: number
}

/**
 * Paired risk difference with the EXACT CONDITIONAL interval — the estimator a
 * promotion gate may decide on.
 *
 * Conditional on the number of discordant pairs m = b + c, the treatment-win
 * count b is Binomial(m, π) with π = P(treatment wins | discordant), and the
 * risk difference is an exact reparameterisation: RD = (2π − 1)·m/n. So a
 * Clopper-Pearson exact interval for π maps straight onto RD. This buys the
 * property the Wald interval in {@link pairedRiskDifference} does not have:
 *
 *   **`lower > 0` ⟺ McNemar's exact test rejects at α = 1 − confidence.**
 *
 * Clopper-Pearson excludes π = 0.5 exactly when the two-sided exact binomial
 * test of π = 0.5 rejects, and that test IS {@link mcnemar}'s p-value — so the
 * interval and the test can never disagree, and a gate keyed on `lower` cannot
 * promote what the exact test refuses. The exact p is returned in the same
 * object so the two are impossible to compute apart.
 *
 * The interval is conservative (exact intervals over-cover; conditioning on m
 * discards the concordant pairs' information about m itself). That is the
 * correct direction for a promotion gate: it refuses more often, never less.
 *
 * With m = 0 there are no discordant pairs and π is not identified: the result
 * is the degenerate [0, 0] with p = 1. That is NOT evidence of equivalence —
 * callers must treat a zero-width interval as "cannot decide", not as "no
 * difference". Inputs are paired 0/1 (or boolean) arrays, control first.
 * Throws on unequal lengths.
 */
export function pairedRiskDifferenceExact(
  control: ArrayLike<number | boolean>,
  treatment: ArrayLike<number | boolean>,
  confidence = 0.95,
): ExactRiskDifferenceResult {
  if (control.length !== treatment.length) {
    throw new Error(
      `pairedRiskDifferenceExact: unequal sample sizes (${control.length} vs ${treatment.length})`,
    )
  }
  if (confidence <= 0 || confidence >= 1) {
    throw new Error(`pairedRiskDifferenceExact: confidence must be in (0,1), got ${confidence}`)
  }
  const n = control.length
  if (n === 0) {
    return {
      n: 0,
      b: 0,
      c: 0,
      nDiscordant: 0,
      riskDifference: 0,
      lower: 0,
      upper: 0,
      confidence,
      pValue: 1,
    }
  }
  let b = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    const ctrl = control[i] ? 1 : 0
    const treat = treatment[i] ? 1 : 0
    if (treat === 1 && ctrl === 0) b++
    else if (treat === 0 && ctrl === 1) c++
  }
  const m = b + c
  const riskDifference = (b - c) / n
  const pValue = binomialSignTwoSided(b, c)
  if (m === 0) {
    return { n, b, c, nDiscordant: 0, riskDifference: 0, lower: 0, upper: 0, confidence, pValue }
  }
  const alpha = 1 - confidence
  const piLow = b === 0 ? 0 : betaQuantile(alpha / 2, b, m - b + 1)
  const piHigh = b === m ? 1 : betaQuantile(1 - alpha / 2, b + 1, m - b)
  const scale = m / n
  return {
    n,
    b,
    c,
    nDiscordant: m,
    riskDifference,
    lower: Math.max(-1, (2 * piLow - 1) * scale),
    upper: Math.min(1, (2 * piHigh - 1) * scale),
    confidence,
    pValue,
  }
}

/** Inverse regularized incomplete beta by bisection on
 *  {@link regularizedIncompleteBeta}, which is monotone increasing in x. 80
 *  halvings of [0,1] resolve to ~8e-25, far past the continued fraction's own
 *  3e-15 tolerance, so the quantile is as exact as the CDF it inverts. */
function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** A paired binary effect size with an interval that is valid at a NONZERO
 *  margin — the estimator a noninferiority decision may be made on. */
export interface ScoreRiskDifferenceResult {
  /** Total paired observations. */
  n: number
  /** Discordant pairs: treatment-win count. */
  b: number
  /** Discordant pairs: control-win count. */
  c: number
  /** Discordant pairs (b + c). */
  nDiscordant: number
  /** Paired risk difference p(treatment) − p(control) = (b − c) / n. */
  riskDifference: number
  /** Score-interval lower bound on the population risk difference. */
  lower: number
  /** Score-interval upper bound on the population risk difference. */
  upper: number
  /** Confidence level used. */
  confidence: number
}

/**
 * Constrained MLE of q = P(treatment loses) under the hypothesis RD = `delta`.
 *
 * Profiling the two concordant cells out of the multinomial leaves
 * `L(q) = b·log(q+delta) + c·log(q) + e·log(1 − 2q − delta)` with `e = n − b − c`,
 * whose stationary point is the positive root of
 * `2n·q² − [(b + c) − delta·(b + 3c + 2e)]·q − c·delta·(1 − delta) = 0`.
 * At `delta = 0` this returns `(b + c) / 2n`, the familiar null.
 */
function constrainedLossRate(b: number, c: number, n: number, delta: number): number {
  const e = n - b - c
  const quadratic = 2 * n
  const linear = -(b + c - delta * (b + 3 * c + 2 * e))
  const constant = -c * delta * (1 - delta)
  const discriminant = linear * linear - 4 * quadratic * constant
  const root = discriminant > 0 ? Math.sqrt(discriminant) : 0
  const q = (-linear + root) / (2 * quadratic)
  // Clamp into the region where all four cell probabilities stay non-negative.
  return Math.min(Math.max(q, Math.max(0, -delta)), Math.max(0, (1 - delta) / 2))
}

/** Tango's score statistic for H0: RD = `delta`. `Var(b − c) = n·(2q + delta −
 *  delta²)` under that hypothesis, evaluated at the constrained MLE of q. */
function tangoScore(b: number, c: number, n: number, delta: number): number {
  const numerator = b - c - n * delta
  const q = constrainedLossRate(b, c, n, delta)
  const variance = n * (2 * q + delta * (1 - delta))
  if (!(variance > 0)) {
    if (numerator === 0) return 0
    return numerator > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  }
  return numerator / Math.sqrt(variance)
}

/**
 * Paired risk difference with TANGO'S (1998) SCORE INTERVAL — the estimator a
 * promotion gate may decide on **at a nonzero margin**.
 *
 * {@link pairedRiskDifferenceExact} conditions on the observed discordant count
 * `m = b + c`, builds a Clopper-Pearson interval for the win share among those
 * `m` pairs, and multiplies by the observed `m/n`. That is exact for testing
 * RD = 0 — it is dual to McNemar — but it is NOT a confidence interval for the
 * population risk difference at a nonzero margin, because the sampling
 * variability of `m/n` itself is discarded. The gap is not academic: with the
 * production caller's `pairedDeltaThreshold: -0.05`, a process whose true risk
 * difference sits exactly on that margin clears a nominal-95 % `lower > margin`
 * check 24.75 % of the time at n = 40 and 43.95 % at n = 76 (2000 replicates
 * each) when the conditional interval decides.
 *
 * Tango's interval inverts the score test of RD = delta, which estimates the
 * nuisance loss rate under each hypothesised delta instead of fixing it at the
 * observed value, so `m` contributes its own uncertainty. It is the method
 * `ratesci::scorepairci` uses for paired risk-difference noninferiority, and it
 * is not conditional, so it stays valid as the margin moves away from zero.
 *
 * The bounds are found by bisecting `tangoScore(delta) = ±z` — the score is
 * monotone decreasing in delta, so each crossing is unique. Inputs are paired
 * 0/1 (or boolean) arrays, control first. Throws on unequal lengths.
 */
export function pairedRiskDifferenceScore(
  control: ArrayLike<number | boolean>,
  treatment: ArrayLike<number | boolean>,
  confidence = 0.95,
): ScoreRiskDifferenceResult {
  if (control.length !== treatment.length) {
    throw new Error(
      `pairedRiskDifferenceScore: unequal sample sizes (${control.length} vs ${treatment.length})`,
    )
  }
  if (confidence <= 0 || confidence >= 1) {
    throw new Error(`pairedRiskDifferenceScore: confidence must be in (0,1), got ${confidence}`)
  }
  const n = control.length
  if (n === 0) {
    return { n: 0, b: 0, c: 0, nDiscordant: 0, riskDifference: 0, lower: -1, upper: 1, confidence }
  }
  let b = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    const ctrl = control[i] ? 1 : 0
    const treat = treatment[i] ? 1 : 0
    if (treat === 1 && ctrl === 0) b++
    else if (treat === 0 && ctrl === 1) c++
  }
  const riskDifference = (b - c) / n
  const z = zQuantile(1 - (1 - confidence) / 2)

  // Lower bound: the smallest delta still inside the interval, i.e. the root of
  // score(delta) = +z on [-1, riskDifference]. score(riskDifference) = 0 < z, so
  // the right endpoint is always inside and the bisection is well posed.
  let lo = -1
  let hi = riskDifference
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (tangoScore(b, c, n, mid) > z) lo = mid
    else hi = mid
  }
  const lower = (lo + hi) / 2

  // Upper bound: root of score(delta) = -z on [riskDifference, 1].
  let ulo = riskDifference
  let uhi = 1
  for (let i = 0; i < 200; i++) {
    const mid = (ulo + uhi) / 2
    if (tangoScore(b, c, n, mid) > -z) ulo = mid
    else uhi = mid
  }
  const upper = (ulo + uhi) / 2

  return {
    n,
    b,
    c,
    nDiscordant: b + c,
    riskDifference,
    lower: Math.max(-1, lower),
    upper: Math.min(1, upper),
    confidence,
  }
}

/**
 * The common positive level `s` such that EVERY value across both paired arms is
 * exactly 0 or `s` — i.e. the outcome is pass/fail, whatever encoding it arrived
 * in. Returns null when the outcomes are not two-point, when the two arms use
 * different levels, or when no positive value was observed at all (all-zero
 * arms: the level is not identified, and there is nothing to decide anyway).
 *
 * This is the scale-aware successor to {@link isBinaryOutcomeVector}, which only
 * recognises literal {0, 1}. Judges in this codebase emit dimensions on 0-100 as
 * well as [0,1] (see `detectScale` in `campaign/gates/statistical-heldout.ts`),
 * so a pass/fail dimension routinely arrives as {0, 100} and a {0,1}-only test
 * silently sends it down the median path that cannot see it. Any positive level
 * is accepted, not just 1 and 100: for a two-point {0, s} outcome the mean paired
 * delta is exactly s·(b − c)/n, so the binary estimators apply after dividing by
 * s and rescaling the result back into the caller's native units.
 *
 * Non-finite values ⇒ null: an unusable outcome must not be classified as a
 * clean pass/fail shape.
 */
export function pairedBinaryScale(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
): number | null {
  let level: number | null = null
  for (const arm of [before, after]) {
    for (let i = 0; i < arm.length; i++) {
      const v = arm[i]!
      if (!Number.isFinite(v)) return null
      if (v === 0) continue
      if (v < 0) return null
      if (level === null) level = v
      else if (v !== level) return null
    }
  }
  return level
}

/**
 * Unbiased pass@k for code generation (Chen et al. 2021, "Evaluating Large
 * Language Models Trained on Code"). Given `n` independent samples for one
 * problem of which `c` pass, the probability that at least one of a random k of
 * them passes is 1 − C(n−c, k) / C(n, k). Estimating pass@k as "did any of the
 * first k pass" is biased high at small n; this is the variance-reduced estimator
 * averaged implicitly over all k-subsets. Average the per-problem values across
 * the suite for the corpus pass@k. Computed in the numerically stable product
 * form. Requires 1 ≤ k ≤ n and 0 ≤ c ≤ n.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k)) {
    throw new Error(`passAtK: n, c, k must be integers (got n=${n}, c=${c}, k=${k})`)
  }
  if (k < 1 || k > n || c < 0 || c > n) {
    throw new Error(`passAtK: require 1 ≤ k ≤ n and 0 ≤ c ≤ n (got n=${n}, c=${c}, k=${k})`)
  }
  if (n - c < k) return 1
  let prob = 1
  for (let i = n - c + 1; i <= n; i++) prob *= 1 - k / i
  return 1 - prob
}
