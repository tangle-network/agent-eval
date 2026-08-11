import { ValidationError } from '../errors'
import { normalCdf } from '../math/normal'
import { lnGamma } from '../math/special-functions'
import { assertFiniteSample, makeRng, symmetricTwoSampleSeed } from './internal'

// ── Rank tests: exact by default ─────────────────────────────────────
//
// At 3–10 repetitions per arm the binding constraint on a rank test is
// combinatorial, not numerical. Three versus three admits only 20 splits, so
// the attainable two-sided p-grid starts at 0.1000 and α = 0.05 is out of
// reach at that design; a normal approximation reports 0.0495, a p-value that
// describes no attainable outcome. No better approximation fixes this — adding
// the tie correction moves `[0,0,0]` versus `[1,1,1]` from 0.0495 to 0.0469,
// further from its exact 0.1000, not closer.
//
// So both null distributions are enumerated exactly inside bounded state and
// work budgets, by convolution over the observed midranks (identical to
// enumerating every split / sign pattern, and cheaper), which conditions on the
// realised tie pattern for free. Above those budgets the default is a seeded
// Monte Carlo permutation. The asymptotic path is never chosen automatically,
// and asking for it inside the exact-feasible range throws.
//
// Every result carries `method` and `pFloor` so a downstream gate can SEE the
// discreteness rather than infer it: a gate handed data whose `pFloor` exceeds
// its alpha is underpowered by construction, which is a true statement about
// the experiment, not a false one about the effect.

/** How a rank test's p-value was actually computed. */
export type RankTestMethod = 'exact' | 'permutation' | 'asymptotic'

/**
 * What the caller asks for. `'auto'` selects `'exact'` inside the enumeration
 * threshold and `'permutation'` above it, and never selects `'asymptotic'`.
 */
export type RankTestMethodRequest = 'auto' | 'exact' | 'asymptotic'

export interface RankTestOptions {
  /** Default `'auto'`. `'asymptotic'` inside the exact-feasible range throws. */
  method?: RankTestMethodRequest
  /** Resamples on the Monte Carlo permutation path. Default 100000. */
  permutations?: number
  /** Seed for the permutation path. Omitted ⇒ derived from the data itself, so
   *  the result is reproducible either way. */
  seed?: number
}

/** Maximum dynamic-programming cells used by an exact two-sample rank test. */
export const MANN_WHITNEY_EXACT_MAX_STATES = 8_192
/** Maximum inner-loop transitions used by an exact two-sample rank test. */
export const MANN_WHITNEY_EXACT_MAX_WORK = 250_000
/** Non-zero differences up to which the signed-rank null is enumerated exactly. */
export const WILCOXON_EXACT_MAX_N = 20
/** Resamples used when a rank test falls back to Monte Carlo permutation. */
export const DEFAULT_PERMUTATIONS = 100_000

export interface MannWhitneyResult {
  /** `min(U_a, U_b)` — the conventional reported statistic. */
  u: number
  /** U for sample `a`. Carries the direction of the effect, which `u` discards. */
  uA: number
  /** Two-sided p-value. */
  p: number
  /** How `p` was computed. */
  method: RankTestMethod
  /** Smallest two-sided p this design can produce. `p` can never be below it. */
  pFloor: number
}

/**
 * Mann-Whitney U — two independent samples, no distributional assumption.
 *
 * Exact conditional (permutation) p by default when the dynamic program fits
 * {@link MANN_WHITNEY_EXACT_MAX_STATES} cells and
 * {@link MANN_WHITNEY_EXACT_MAX_WORK} transitions, seeded Monte Carlo
 * permutation above those limits. This keeps imbalanced designs such as 1+24
 * exact without admitting expensive balanced designs merely because they have
 * the same total size. Throws on non-finite input and on `method:
 * 'asymptotic'` where an exact answer is available. Empty input yields `p = 1,
 * pFloor = 1` — no design, no attainable evidence.
 */
export function mannWhitneyU(
  a: number[],
  b: number[],
  opts: RankTestOptions = {},
): MannWhitneyResult {
  assertFiniteSample('mannWhitneyU', 'a', a)
  assertFiniteSample('mannWhitneyU', 'b', b)

  const n1 = a.length
  const n2 = b.length
  if (n1 === 0 || n2 === 0) return { u: 0, uA: 0, p: 1, method: 'exact', pFloor: 1 }

  const total = n1 + n2
  const combined = [
    ...a.map((v) => ({ v, fromA: true })),
    ...b.map((v) => ({ v, fromA: false })),
  ].sort((x, y) => x.v - y.v)

  const { midranks, tieTerm } = midranksWithTieTerm(combined.map((entry) => entry.v))
  let rankSumA = 0
  for (let k = 0; k < total; k++) {
    if (combined[k]!.fromA) rankSumA += midranks[k]!
  }

  const uA = rankSumA - (n1 * (n1 + 1)) / 2
  const u = Math.min(uA, n1 * n2 - uA)
  // Midranks are integers or halves, so doubling makes the null convolution
  // integral. U is centred on n₁n₂/2, hence a doubled centre of n₁n₂.
  const doubled = midranks.map((rank) => Math.round(rank * 2))
  const doubledDeviation = Math.abs(2 * uA - n1 * n2)
  const selectedN = Math.min(n1, n2)
  const otherN = total - selectedN
  const exactCost = exactTwoSampleCost(doubled, selectedN)

  const designFloor = exactTwoSampleFloor(doubled, selectedN)
  const method = selectRankTestMethod(
    'mannWhitneyU',
    opts.method ?? 'auto',
    `n1=${n1}, n2=${n2}`,
    exactCost.states <= MANN_WHITNEY_EXACT_MAX_STATES &&
      exactCost.work <= MANN_WHITNEY_EXACT_MAX_WORK,
    designFloor,
    `${MANN_WHITNEY_EXACT_MAX_STATES.toLocaleString('en-US')} states and ` +
      `${MANN_WHITNEY_EXACT_MAX_WORK.toLocaleString('en-US')} transitions`,
  )

  if (method === 'exact') {
    const { p, pFloor } = exactTwoSampleP(doubled, selectedN, otherN, doubledDeviation)
    return { u, uA, p, method, pFloor }
  }

  if (method === 'asymptotic') {
    return {
      u,
      uA,
      p: asymptoticTwoSidedP(doubledDeviation / 2, twoSampleSigma(n1, n2, total, tieTerm)),
      method,
      pFloor: designFloor,
    }
  }

  const permutations = resolvePermutations('mannWhitneyU', opts.permutations)
  const rng = opts.seed === undefined ? makeRng(symmetricTwoSampleSeed(a, b)) : makeRng(opts.seed)
  let atLeastAsExtreme = 0
  const pool = [...doubled]
  for (let iteration = 0; iteration < permutations; iteration++) {
    let doubledRankSum = 0
    for (let k = 0; k < selectedN; k++) {
      const pick = k + Math.floor(rng() * (total - k))
      const swapped = pool[pick]!
      pool[pick] = pool[k]!
      pool[k] = swapped
      doubledRankSum += swapped
    }
    if (
      Math.abs(doubledRankSum - selectedN * (selectedN + 1) - selectedN * otherN) >=
      doubledDeviation
    ) {
      atLeastAsExtreme++
    }
  }
  const pFloor = Math.max(1 / (permutations + 1), designFloor)
  return {
    u,
    uA,
    p: Math.max((1 + atLeastAsExtreme) / (permutations + 1), pFloor),
    method,
    pFloor,
  }
}

export interface WilcoxonSignedRankResult {
  /** W⁺, the rank sum of the positive differences. (scipy reports
   *  `min(W⁺, W⁻)`; compare statistics only after converting.) */
  w: number
  /** Two-sided p-value. */
  p: number
  /** How `p` was computed. */
  method: RankTestMethod
  /** Smallest two-sided p this design can produce. */
  pFloor: number
  /** Non-zero differences — zero differences are dropped and carry no rank. */
  nNonZero: number
}

/**
 * Wilcoxon signed-rank — paired, no distributional assumption on the deltas.
 *
 * Exact conditional (sign-flip) p by default at `n ≤
 * {@link WILCOXON_EXACT_MAX_N}` non-zero differences, seeded Monte Carlo
 * permutation above it. Throws on non-finite input and on `method:
 * 'asymptotic'` where an exact answer is available.
 *
 * `n` is the count of NON-ZERO differences: exact ties are dropped before
 * ranking, so a run of tied pairs shrinks the design and raises `pFloor`.
 * All-tied input yields `p = 1, pFloor = 1` — no attainable evidence, which
 * `pFloor` states rather than leaving `p = 1` to be read as a measured null.
 */
export function wilcoxonSignedRank(
  before: number[],
  after: number[],
  opts: RankTestOptions = {},
): WilcoxonSignedRankResult {
  if (before.length !== after.length) {
    throw new ValidationError(
      `wilcoxonSignedRank: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  assertFiniteSample('wilcoxonSignedRank', 'before', before)
  assertFiniteSample('wilcoxonSignedRank', 'after', after)

  const diffs = before.map((b, i) => after[i]! - b).filter((d) => d !== 0)
  const n = diffs.length
  if (n === 0) return { w: 0, p: 1, method: 'exact', pFloor: 1, nNonZero: 0 }

  const order = diffs.map((d, i) => ({ abs: Math.abs(d), i })).sort((x, y) => x.abs - y.abs)
  const { midranks, tieTerm } = midranksWithTieTerm(order.map((entry) => entry.abs))
  const ranks: number[] = new Array(n)
  for (let k = 0; k < n; k++) ranks[order[k]!.i] = midranks[k]!

  let wPlus = 0
  for (let k = 0; k < n; k++) if (diffs[k]! > 0) wPlus += ranks[k]!

  // Midranks are integers or halves; doubling makes the convolution integral.
  // Σ midranks = n(n+1)/2 whatever the tie pattern, so E[W⁺] = n(n+1)/4 and
  // the doubled centre is n(n+1)/2.
  const doubled = midranks.map((rank) => Math.round(rank * 2))
  const doubledDeviation = Math.abs(2 * wPlus - (n * (n + 1)) / 2)

  const designFloor = Math.min(1, 2 ** (1 - n))
  const method = selectRankTestMethod(
    'wilcoxonSignedRank',
    opts.method ?? 'auto',
    `n=${n} non-zero differences`,
    n <= WILCOXON_EXACT_MAX_N,
    designFloor,
    `${WILCOXON_EXACT_MAX_N} non-zero differences`,
  )

  if (method === 'exact') {
    const { p, pFloor } = exactSignedRankP(doubled, doubledDeviation)
    return { w: wPlus, p, method, pFloor, nNonZero: n }
  }

  if (method === 'asymptotic') {
    const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48
    return {
      w: wPlus,
      p: asymptoticTwoSidedP(doubledDeviation / 2, Math.sqrt(variance)),
      method,
      pFloor: designFloor,
      nNonZero: n,
    }
  }

  const permutations = resolvePermutations('wilcoxonSignedRank', opts.permutations)
  const rng = makeRng(opts.seed, before, after)
  const doubledCentre = (n * (n + 1)) / 2
  let atLeastAsExtreme = 0
  for (let iteration = 0; iteration < permutations; iteration++) {
    let doubledWPlus = 0
    for (let k = 0; k < n; k++) if (rng() < 0.5) doubledWPlus += doubled[k]!
    if (Math.abs(doubledWPlus - doubledCentre) >= doubledDeviation) atLeastAsExtreme++
  }
  return {
    w: wPlus,
    p: (1 + atLeastAsExtreme) / (permutations + 1),
    method,
    pFloor: Math.max(1 / (permutations + 1), designFloor),
    nNonZero: n,
  }
}

/**
 * Average ranks over an ASCENDING-sorted array, plus `Σ(t³ − t)` over tie
 * groups of size `t` — the correction term both asymptotic rank-test variances
 * need.
 */
function midranksWithTieTerm(sorted: readonly number[]): { midranks: number[]; tieTerm: number } {
  const midranks = new Array<number>(sorted.length)
  let tieTerm = 0
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && sorted[j] === sorted[i]) j++
    const average = (i + 1 + j) / 2
    for (let k = i; k < j; k++) midranks[k] = average
    const groupSize = j - i
    if (groupSize > 1) tieTerm += groupSize ** 3 - groupSize
    i = j
  }
  return { midranks, tieTerm }
}

function selectRankTestMethod(
  fn: string,
  request: RankTestMethodRequest,
  design: string,
  exactFeasible: boolean,
  designFloor: number,
  threshold: string,
): RankTestMethod {
  if (request === 'auto') return exactFeasible ? 'exact' : 'permutation'
  if (request === 'exact') {
    if (exactFeasible) return 'exact'
    throw new ValidationError(
      `${fn}: method 'exact' is out of range at ${design} — enumeration is bounded by ` +
        `${threshold}. Use 'auto' for the seeded Monte Carlo permutation, which converges ` +
        'to the same answer.',
    )
  }
  if (exactFeasible) {
    throw new ValidationError(
      `${fn}: method 'asymptotic' is refused at ${design} — the exact p-grid at this design ` +
        `starts at ${formatProbability(designFloor)}, so an asymptotic p below it describes no ` +
        `attainable outcome. Use method 'exact' (the default) or add repetitions past ` +
        `${threshold}.`,
    )
  }
  return 'asymptotic'
}

function resolvePermutations(fn: string, permutations: number | undefined): number {
  if (permutations === undefined) return DEFAULT_PERMUTATIONS
  if (!Number.isInteger(permutations) || permutations < 1) {
    throw new ValidationError(`${fn}: permutations must be a positive integer, got ${permutations}`)
  }
  return permutations
}

/** Two-sided normal-approximation tail with the continuity correction. */
function asymptoticTwoSidedP(deviation: number, sigma: number): number {
  if (!(sigma > 0)) return 1
  return Math.min(1, 2 * (1 - normalCdf(Math.max(0, deviation - 0.5) / sigma)))
}

/** SD of U under the permutation null, corrected for the realised ties. The
 *  tie term reduces (N+1) and reaches it exactly when every value is tied, so
 *  the variance floors at 0 rather than going negative. */
function twoSampleSigma(n1: number, n2: number, total: number, tieTerm: number): number {
  if (total < 2) return 0
  const variance = ((n1 * n2) / 12) * (total + 1 - tieTerm / (total * (total - 1)))
  return Math.sqrt(Math.max(0, variance))
}

function logChoose(n: number, k: number): number {
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1)
}

function formatProbability(value: number): string {
  return value >= 1e-4 || value === 0 ? value.toFixed(4) : value.toExponential(3)
}

/**
 * Exact DP allocation and loop count for this observed rank vector.
 *
 * The smaller arm is sufficient because selecting its complement produces the
 * same two-sided U deviation while using fewer rows in the state table.
 */
function exactTwoSampleCost(
  doubledRanks: readonly number[],
  selectedN: number,
): { states: number; work: number } {
  const maxSum = doubledRanks.reduce((sum, rank) => sum + rank, 0)
  let work = 0
  for (let placed = 0; placed < doubledRanks.length; placed++) {
    work += Math.min(selectedN, placed + 1) * (maxSum - doubledRanks[placed]! + 1)
  }
  return {
    states: (selectedN + 1) * (maxSum + 1),
    work,
  }
}

/**
 * Smallest attainable two-sided p under the observed ties.
 *
 * Only subsets with the minimum or maximum rank sum can attain the largest
 * deviation. Their multiplicity is the number of ways to choose within the
 * tie group at each boundary, so this calculation is exact without allocating
 * the full null distribution.
 */
function exactTwoSampleFloor(doubledRanks: readonly number[], selectedN: number): number {
  const total = doubledRanks.length
  const otherN = total - selectedN
  const minimumSum = doubledRanks.slice(0, selectedN).reduce((sum, rank) => sum + rank, 0)
  const maximumSum = doubledRanks.slice(total - selectedN).reduce((sum, rank) => sum + rank, 0)
  if (minimumSum === maximumSum) return 1

  const centre = selectedN * (selectedN + 1) + selectedN * otherN
  const minimumDeviation = Math.abs(minimumSum - centre)
  const maximumDeviation = Math.abs(maximumSum - centre)
  const totalLogWays = logChoose(total, selectedN)
  const minimumMass = Math.exp(
    logExtremeSubsetWays(doubledRanks, selectedN, 'minimum') - totalLogWays,
  )
  const maximumMass = Math.exp(
    logExtremeSubsetWays(doubledRanks, selectedN, 'maximum') - totalLogWays,
  )

  if (minimumDeviation > maximumDeviation) return minimumMass
  if (maximumDeviation > minimumDeviation) return maximumMass
  return Math.min(1, minimumMass + maximumMass)
}

function logExtremeSubsetWays(
  sortedRanks: readonly number[],
  selectedN: number,
  side: 'minimum' | 'maximum',
): number {
  const boundaryIndex = side === 'minimum' ? selectedN - 1 : sortedRanks.length - selectedN
  const boundary = sortedRanks[boundaryIndex]!
  let first = boundaryIndex
  let afterLast = boundaryIndex + 1
  while (first > 0 && sortedRanks[first - 1] === boundary) first--
  while (afterLast < sortedRanks.length && sortedRanks[afterLast] === boundary) afterLast++

  const tieSize = afterLast - first
  const fixed = side === 'minimum' ? first : sortedRanks.length - afterLast
  return logChoose(tieSize, selectedN - fixed)
}

/**
 * Exact conditional two-sided p for the two-sample rank test.
 *
 * Convolves the observed doubled midranks into the null distribution of group
 * a's rank sum over every `C(n₁+n₂, n₁)` split — identical to enumerating the
 * splits, but `O(N·n₁·ΣR)` instead of `O(C(N,n₁)·n₁n₂)`. Conditioning on the
 * realised multiset makes the tie handling exact rather than a correction.
 *
 * The null is symmetric about `n₁n₂/2` (negating every value maps `U → n₁n₂ −
 * U` and permutes the split set onto itself), so the two-sided p is the mass
 * at least as far from the centre as the observation.
 */
function exactTwoSampleP(
  doubledRanks: readonly number[],
  n1: number,
  n2: number,
  doubledDeviation: number,
): { p: number; pFloor: number } {
  const maxSum = doubledRanks.reduce((sum, rank) => sum + rank, 0)
  const width = maxSum + 1
  // ways[k][s] = number of size-k subsets whose doubled rank sum is s.
  const ways: Float64Array[] = Array.from({ length: n1 + 1 }, () => new Float64Array(width))
  ways[0]![0] = 1
  let placed = 0
  for (const rank of doubledRanks) {
    for (let k = Math.min(n1, placed + 1); k >= 1; k--) {
      const from = ways[k - 1]!
      const into = ways[k]!
      for (let sum = maxSum - rank; sum >= 0; sum--) {
        const count = from[sum]!
        if (count !== 0) into[sum + rank]! += count
      }
    }
    placed++
  }

  // U = rankSum − n₁(n₁+1)/2, so doubled U = s − n₁(n₁+1), and the doubled
  // centre 2·(n₁n₂/2) is n₁n₂.
  const shift = n1 * (n1 + 1) + n1 * n2
  const chosen = ways[n1]!
  let totalWays = 0
  let extremeWays = 0
  let tailWays = 0
  let maxDeviation = -1
  for (let sum = 0; sum < width; sum++) {
    const count = chosen[sum]!
    if (count === 0) continue
    totalWays += count
    const deviation = Math.abs(sum - shift)
    if (deviation >= doubledDeviation) tailWays += count
    if (deviation > maxDeviation) {
      maxDeviation = deviation
      extremeWays = count
    } else if (deviation === maxDeviation) {
      extremeWays += count
    }
  }
  return { p: tailWays / totalWays, pFloor: extremeWays / totalWays }
}

/**
 * Exact conditional two-sided p for the paired signed-rank test.
 *
 * Convolves the observed doubled absolute midranks over all `2ⁿ` sign
 * assignments in `O(n·ΣR)`. Probabilities rather than counts keep `2ⁿ` off the
 * arithmetic. The null is symmetric about `n(n+1)/4`.
 */
function exactSignedRankP(
  doubledRanks: readonly number[],
  doubledDeviation: number,
): { p: number; pFloor: number } {
  const maxSum = doubledRanks.reduce((sum, rank) => sum + rank, 0)
  const width = maxSum + 1
  let mass = new Float64Array(width)
  mass[0] = 1
  for (const rank of doubledRanks) {
    const next = new Float64Array(width)
    for (let sum = 0; sum < width; sum++) {
      const probability = mass[sum]!
      if (probability === 0) continue
      next[sum]! += probability * 0.5
      next[sum + rank]! += probability * 0.5
    }
    mass = next
  }

  const centre = maxSum / 2
  let tail = 0
  let extreme = 0
  let maxDeviation = -1
  for (let sum = 0; sum < width; sum++) {
    const probability = mass[sum]!
    if (probability === 0) continue
    const deviation = Math.abs(sum - centre)
    if (deviation >= doubledDeviation) tail += probability
    if (deviation > maxDeviation) {
      maxDeviation = deviation
      extreme = probability
    } else if (deviation === maxDeviation) {
      extreme += probability
    }
  }
  return { p: Math.min(1, tail), pFloor: Math.min(1, extreme) }
}
