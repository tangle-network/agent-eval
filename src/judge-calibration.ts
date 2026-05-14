/**
 * Judge calibration — measure judge quality against human gold + bias.
 *
 * Workflow:
 *   1. Build a golden set: {itemId, humanScore}[].
 *   2. Run candidate judges; each produces {itemId, score}.
 *   3. `calibrateJudge(golden, candidate)` reports κ + Pearson + MAE.
 *   4. Run bias probes (positional, verbosity, self-preference) to
 *      detect systematic score inflation.
 *
 * Returns actionable diagnostics, not a single number. Consumers then
 * decide whether to trust the judge, retrain it, or add a tie-breaker.
 */

export interface GoldenItem {
  itemId: string
  humanScore: number
  /** Optional group used for per-group bias audits (e.g. model-of-output family). */
  group?: string
}

export interface CandidateScore {
  itemId: string
  score: number
  /** Optional — enables positional-bias analysis (did order matter?). */
  positionOfAInput?: 'first' | 'second'
}

export interface CalibrationResult {
  n: number
  pearson: number
  /** Cohen's κ with quadratic weights over integer-rounded scores. */
  kappa: number
  /** Mean absolute error vs human. */
  mae: number
  /** Worst-5 miscalibrations (largest |judge - human|). */
  worstItems: Array<{ itemId: string; judge: number; human: number; delta: number }>
}

export function calibrateJudge(
  golden: GoldenItem[],
  candidate: CandidateScore[],
): CalibrationResult {
  const map = new Map<string, { h: number; j: number }>()
  for (const g of golden) map.set(g.itemId, { h: g.humanScore, j: NaN })
  for (const c of candidate) {
    const entry = map.get(c.itemId)
    if (entry) entry.j = c.score
  }
  const common = [...map.values()].filter((v) => Number.isFinite(v.j))
  const n = common.length
  if (n < 2) {
    return { n, pearson: NaN, kappa: NaN, mae: NaN, worstItems: [] }
  }
  const humans = common.map((c) => c.h)
  const judges = common.map((c) => c.j)
  const pearson = pearsonR(humans, judges)
  const kappa = weightedKappa(humans.map(Math.round), judges.map(Math.round))
  const absDiffs = common.map((c) => Math.abs(c.j - c.h))
  const mae = absDiffs.reduce((a, b) => a + b, 0) / n
  const worst = [...map.entries()]
    .filter(([, v]) => Number.isFinite(v.j))
    .map(([itemId, v]) => ({ itemId, judge: v.j, human: v.h, delta: Math.abs(v.j - v.h) }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5)
  return { n, pearson, kappa, mae, worstItems: worst }
}

export interface PositionalBiasResult {
  /**
   * Score delta (first-position - second-position) averaged across items
   * presented in both positions. Non-zero = positional bias.
   */
  avgDelta: number
  n: number
}

/**
 * Feed the same items to the judge twice with A/B swapped and pass all
 * results here. Items that don't appear in both positions are ignored.
 */
export function positionalBias(scores: CandidateScore[]): PositionalBiasResult {
  const pairs = new Map<string, { first?: number; second?: number }>()
  for (const s of scores) {
    const slot = pairs.get(s.itemId) ?? {}
    if (s.positionOfAInput === 'first') slot.first = s.score
    else if (s.positionOfAInput === 'second') slot.second = s.score
    pairs.set(s.itemId, slot)
  }
  const deltas: number[] = []
  for (const { first, second } of pairs.values()) {
    if (first !== undefined && second !== undefined) deltas.push(first - second)
  }
  if (deltas.length === 0) return { avgDelta: 0, n: 0 }
  return { avgDelta: deltas.reduce((a, b) => a + b, 0) / deltas.length, n: deltas.length }
}

export interface VerbosityBiasResult {
  /** Pearson correlation between output length and score. Strong positive = verbosity bias. */
  pearson: number
  n: number
}

export function verbosityBias(
  samples: Array<{ outputLen: number; score: number }>,
): VerbosityBiasResult {
  const n = samples.length
  if (n < 3) return { pearson: NaN, n }
  return {
    pearson: pearsonR(
      samples.map((s) => s.outputLen),
      samples.map((s) => s.score),
    ),
    n,
  }
}

export interface SelfPreferenceResult {
  /** Mean judge score when judge's family matches output's family. */
  inFamilyMean: number
  outOfFamilyMean: number
  deltaMean: number
  n: number
}

/**
 * Pass the same scenarios scored with judge-model X grading outputs from
 * model X (in-family) and model Y (out-of-family). Non-zero delta
 * indicates self-preference.
 */
export function selfPreference(
  samples: Array<{ score: number; inFamily: boolean }>,
): SelfPreferenceResult {
  const inF = samples.filter((s) => s.inFamily).map((s) => s.score)
  const outF = samples.filter((s) => !s.inFamily).map((s) => s.score)
  if (inF.length === 0 || outF.length === 0)
    return { inFamilyMean: 0, outOfFamilyMean: 0, deltaMean: 0, n: 0 }
  const inMean = inF.reduce((a, b) => a + b, 0) / inF.length
  const outMean = outF.reduce((a, b) => a + b, 0) / outF.length
  return {
    inFamilyMean: inMean,
    outOfFamilyMean: outMean,
    deltaMean: inMean - outMean,
    n: samples.length,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function pearsonR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return NaN
  const mA = a.reduce((s, v) => s + v, 0) / a.length
  const mB = b.reduce((s, v) => s + v, 0) / b.length
  let num = 0,
    dA = 0,
    dB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - mA
    const db = b[i]! - mB
    num += da * db
    dA += da * da
    dB += db * db
  }
  if (dA === 0 || dB === 0) return dA === 0 && dB === 0 ? 1 : 0
  return num / Math.sqrt(dA * dB)
}

/** Quadratic weighted Cohen's κ over bounded integer scores. */
function weightedKappa(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return NaN
  const min = Math.min(...a, ...b)
  const max = Math.max(...a, ...b)
  const K = max - min + 1
  if (K < 2) return 1
  const observed: number[][] = Array.from({ length: K }, () => new Array(K).fill(0))
  const rowMarg = new Array(K).fill(0)
  const colMarg = new Array(K).fill(0)
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]! - min
    const bi = b[i]! - min
    const row = observed[ai]!
    row[bi] = (row[bi] ?? 0) + 1
    rowMarg[ai]++
    colMarg[bi]++
  }
  let num = 0
  let den = 0
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      const w = (i - j) ** 2 / (K - 1) ** 2
      const expected = (rowMarg[i] * colMarg[j]) / a.length
      num += w * observed[i]![j]!
      den += w * expected
    }
  }
  if (den === 0) return 1
  return 1 - num / den
}
