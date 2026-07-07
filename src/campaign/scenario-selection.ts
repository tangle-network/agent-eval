/**
 * Discriminative scenario selection (research claim E2).
 *
 * The OR benchmark is SATURATING: run 7 measured ~75% tied holdout cells — most
 * problems are solved optimally by the baseline AND every candidate, so those
 * paired cells carry zero signal. A random/balanced holdout split spends its
 * budget on scenarios that cannot separate candidates.
 *
 * This picks the holdout by DISCRIMINATION power instead: a scenario every
 * candidate scores identically (variance ~0) carries no signal; one where the
 * scores spread carries the most. We drop fully saturated ties so each paired
 * holdout cell is spent on a scenario that can actually move a verdict.
 */

/** Per-scenario observation: the composite scores each candidate earned on it. */
export interface ScenarioSignal {
  scenarioId: string
  /** Per-candidate composite scores observed for this scenario (>=1 values). */
  scores: number[]
}

export interface DiscriminationScore {
  scenarioId: string
  /** Higher = separates candidates more (spread of their scores). */
  discrimination: number
  /** Higher = easier / more-saturated (mean of candidate scores). */
  meanScore: number
  variance: number
  /** variance ~0 AND meanScore at/above the ceiling ⇒ a saturated tie, no signal. */
  tied: boolean
}

const DEFAULT_SATURATION_CEILING = 0.999
/** Variance below this is treated as "every candidate scored the same". */
const VARIANCE_EPSILON = 1e-9

interface Moments {
  meanScore: number
  variance: number
}

/** Population mean + variance of the candidate scores. Empty ⇒ zeros (a signal
 *  with no observations cannot discriminate). */
function moments(scores: number[]): Moments {
  const n = scores.length
  if (n === 0) return { meanScore: 0, variance: 0 }
  let sum = 0
  for (const s of scores) sum += s
  const meanScore = sum / n
  let sqDev = 0
  for (const s of scores) {
    const d = s - meanScore
    sqDev += d * d
  }
  return { meanScore, variance: sqDev / n }
}

/** Deterministic ordering: discrimination desc, then meanScore asc (more
 *  headroom first), then scenarioId asc. */
function compareDiscrimination(a: DiscriminationScore, b: DiscriminationScore): number {
  if (b.discrimination !== a.discrimination) return b.discrimination - a.discrimination
  if (a.meanScore !== b.meanScore) return a.meanScore - b.meanScore
  return a.scenarioId < b.scenarioId ? -1 : a.scenarioId > b.scenarioId ? 1 : 0
}

/**
 * Rank scenarios by how well they DISCRIMINATE candidates.
 *
 * `discrimination = variance` (spread of the candidate scores) — kept simple on
 * purpose; the headroom term (`saturationCeiling - meanScore`) only breaks ties
 * so that, among equally spread scenarios, the one with more room to improve
 * ranks first. Returned sorted by the deterministic order above.
 */
export function scoreDiscrimination(
  signals: ScenarioSignal[],
  opts?: { saturationCeiling?: number },
): DiscriminationScore[] {
  const saturationCeiling = opts?.saturationCeiling ?? DEFAULT_SATURATION_CEILING
  const scored = signals.map((signal): DiscriminationScore => {
    const { meanScore, variance } = moments(signal.scores)
    const tied = variance < VARIANCE_EPSILON && meanScore >= saturationCeiling
    return {
      scenarioId: signal.scenarioId,
      discrimination: variance,
      meanScore,
      variance,
      tied,
    }
  })
  return scored.sort(compareDiscrimination)
}

/**
 * Select the top-`k` most discriminative scenario ids for a holdout, EXCLUDING
 * fully saturated ties when enough non-tied scenarios exist (a tie in the
 * holdout wastes a paired cell).
 *
 * Prefers non-tied scenarios; if fewer than `k` non-tied exist, fills with the
 * least-saturated tied ones (tied scenarios are already ordered least-saturated
 * first by `meanScore` asc). Deterministic. Throws if `k < 1`. If
 * `signals.length <= k`, returns all ids in discrimination order.
 */
export function selectDiscriminative(
  signals: ScenarioSignal[],
  k: number,
  opts?: { saturationCeiling?: number },
): string[] {
  if (k < 1) throw new Error(`selectDiscriminative: k must be >= 1 (got ${k})`)
  const ranked = scoreDiscrimination(signals, opts)
  if (ranked.length <= k) return ranked.map((s) => s.scenarioId)
  const nonTied = ranked.filter((s) => !s.tied)
  if (nonTied.length >= k) return nonTied.slice(0, k).map((s) => s.scenarioId)
  const tied = ranked.filter((s) => s.tied)
  const fill = tied.slice(0, k - nonTied.length)
  return [...nonTied, ...fill].map((s) => s.scenarioId)
}
