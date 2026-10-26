/**
 * Inputs of the held-out promotion gate: drop gamed runs, pair both splits and
 * measure coverage, scores, overfit gaps and cost.
 */

import type { GateEvidence, SplitCoverage } from './held-out-gate'
import { pairRunRecords } from './paired-arms'
import { isRealnessGated, observedSplitScore, type ScorePreference } from './rollout/reward'
import type { RunRecord } from './run-record'
import { sampleMedian } from './statistics'

/** Everything `evaluate` reads off the two run sets before it decides. */
export interface GateInputs {
  candidateId: string
  baselineId: string
  /** Paired holdout observations, baseline arm then candidate arm. */
  beforeHoldout: number[]
  afterHoldout: number[]
  productiveRuns: number
  overfitGap: number | null
  baselineOverfitGap: number | null
  medianCandidateCost: number | null
  medianBaselineCost: number | null
  searchCoverage: SplitCoverage
  holdoutCoverage: SplitCoverage
  /** Labels of the arm/split cells that carry no scored run at all. */
  missingSplitScores: string[]
  /** Evidence fields shared by every verdict, before any CI exists. */
  commonEvidence: Omit<
    GateEvidence,
    | 'medianPairedDelta'
    | 'deltaStatistic'
    | 'decidingDelta'
    | 'pairedCI'
    | 'pairedPValue'
    | 'mcnemar'
    | 'binaryScale'
    | 'tieFraction'
  >
}

/** Drop gamed runs, pair both splits and measure coverage, scores, gaps and cost. */
export function collectGateInputs(
  candidate: RunRecord[],
  baseline: RunRecord[],
  baselineKey: string,
): GateInputs {
  const candidateId = inferCandidateId(candidate, baselineKey)
  const baselineId = baselineKey
  assertScenarioIdentities([...candidate, ...baseline])

  // Runs flagged as gamed are dropped from BOTH sides before anything is
  // paired. This is a promotion decision, and the whole point of the
  // authenticity gate is that a faked success must not buy a promotion; the
  // count ships in the evidence so the shrunken pool is never invisible.
  const realnessGatedRuns = [...candidate, ...baseline].filter(isRealnessGated).length
  const honestCandidate = candidate.filter((run) => !isRealnessGated(run))
  const honestBaseline = baseline.filter((run) => !isRealnessGated(run))

  const candidateSearch = scoredRuns(honestCandidate, 'search')
  const baselineSearch = scoredRuns(honestBaseline, 'search')
  const candidateHoldout = scoredRuns(honestCandidate, 'holdout')
  const baselineHoldout = scoredRuns(honestBaseline, 'holdout')
  const searchPairing = pairRunRecords(baselineSearch, candidateSearch)
  const holdoutPairing = pairRunRecords(baselineHoldout, candidateHoldout)
  // The DEALT denominators, measured over every row of each split — scored or
  // not — so an item that produced no number is still counted as work the
  // comparison was given. `splitCoverage` re-pairs the unfiltered rows with
  // the same primitive the decision pairs with, which is the only way the
  // "dealt" set can be derived rather than assumed.
  const searchCoverage = splitCoverage(honestBaseline, honestCandidate, 'search')
  const holdoutCoverage = splitCoverage(honestBaseline, honestCandidate, 'holdout')
  // `scoredRuns` admits only rows whose split score is a finite number, so
  // the non-null assertion below cannot fire on data the pairing saw.
  const splitScoreOf = (run: RunRecord, split: ScorePreference): number =>
    observedSplitScore(run, split) as number
  const beforeSearch = searchPairing.pairs.map((pair) => splitScoreOf(pair.baseline, 'search'))
  const afterSearch = searchPairing.pairs.map((pair) => splitScoreOf(pair.treatment, 'search'))
  const beforeHoldout = holdoutPairing.pairs.map((pair) => splitScoreOf(pair.baseline, 'holdout'))
  const afterHoldout = holdoutPairing.pairs.map((pair) => splitScoreOf(pair.treatment, 'holdout'))

  const productiveRuns = beforeHoldout.length

  const candidateSearchMean = meanOrNull(afterSearch)
  const candidateHoldoutMean = meanOrNull(afterHoldout)
  const baselineSearchMean = meanOrNull(beforeSearch)
  const baselineHoldoutMean = meanOrNull(beforeHoldout)

  const overfitGap = diffOrNull(candidateSearchMean, candidateHoldoutMean)
  const baselineOverfitGap = diffOrNull(baselineSearchMean, baselineHoldoutMean)

  // Cost summary — surfaced in evidence regardless of gating policy so
  // downstream dashboards always know what the candidate cost.
  //
  // The population is the rows that DECIDED this verdict: the matched pairs
  // on both splits, and nothing else. Taking the median over every row the
  // caller happened to pass is a denominator nobody measured, and it is
  // trivially movable — 48 rows tagged `dev` at $0.0001, which the gate never
  // scores and the coverage check never counts, drag a real $5.00/task
  // candidate to a reported $0.0001 and clear a $1.00 ceiling. Deriving the
  // population from the pairing rather than from a list of split tags means
  // there is no tag to sit outside the rule: a row either decided the verdict
  // or it does not describe its cost.
  const medianCandidateCost = completeCostMedian([
    ...searchPairing.pairs.map((pair) => pair.treatment),
    ...holdoutPairing.pairs.map((pair) => pair.treatment),
  ])
  const medianBaselineCost = completeCostMedian([
    ...searchPairing.pairs.map((pair) => pair.baseline),
    ...holdoutPairing.pairs.map((pair) => pair.baseline),
  ])
  const missingSplitScores = [
    candidateSearch.length === 0 ? 'candidate search' : null,
    candidateHoldout.length === 0 ? 'candidate holdout' : null,
    baselineSearch.length === 0 ? 'baseline search' : null,
    baselineHoldout.length === 0 ? 'baseline holdout' : null,
  ].filter((label): label is string => label !== null)
  return {
    candidateId,
    baselineId,
    beforeHoldout,
    afterHoldout,
    productiveRuns,
    overfitGap,
    baselineOverfitGap,
    medianCandidateCost,
    medianBaselineCost,
    searchCoverage,
    holdoutCoverage,
    missingSplitScores,
    commonEvidence: {
      productiveRuns,
      unpairedCandidateRuns: holdoutPairing.unpairedTreatment.length,
      unpairedBaselineRuns: holdoutPairing.unpairedBaseline.length,
      searchScore: candidateSearchMean,
      holdoutScore: candidateHoldoutMean,
      overfitGap,
      baselineOverfitGap,
      medianCandidateCost,
      medianBaselineCost,
      realnessGatedRuns,
      searchCoverage,
      holdoutCoverage,
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function inferCandidateId(candidate: RunRecord[], baselineKey: string): string {
  for (const run of candidate) {
    if (run.candidateId && run.candidateId !== baselineKey) return run.candidateId
  }
  // All candidate rows match the baseline key — caller mistake, but
  // surface the symptom rather than throwing inside the gate.
  return candidate[0]?.candidateId ?? '(unknown candidate)'
}

function assertScenarioIdentities(runs: RunRecord[]): void {
  for (const run of runs) {
    if (typeof run.scenarioId !== 'string' || run.scenarioId.trim() === '') {
      throw new Error(`HeldOutGate: run ${run.runId} is missing scenarioId`)
    }
  }
}

/**
 * Rows carrying a finite score on one split. RAW (`observedSplitScore`) by
 * choice: the gated runs are already removed by the caller, so applying the
 * gate again here would only zero runs that are no longer in the set, and the
 * reported means must describe the runs that actually decided the promotion.
 */
function scoredRuns(runs: RunRecord[], split: ScorePreference): RunRecord[] {
  return runs.filter((run) => {
    if (run.splitTag !== split) return false
    const v = observedSplitScore(run, split)
    return typeof v === 'number' && Number.isFinite(v)
  })
}

/** Every row tagged to one split, scored or not — the work the split was
 *  DEALT, as opposed to the work it managed to measure. */
function dealtRuns(runs: RunRecord[], split: ScorePreference): RunRecord[] {
  return runs.filter((run) => run.splitTag === split)
}

function hasFiniteScore(run: RunRecord, split: ScorePreference): boolean {
  const v = observedSplitScore(run, split)
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Partition one split's dealt work into answered / unscored / one-armed.
 *
 * Pairs the UNFILTERED rows with the same `pairRunRecords` the decision uses,
 * so the denominator comes out of the same identity rules as the numerator and
 * cannot drift from it. Deliberately a SECOND pairing rather than a widening of
 * the decision's own: the decision keeps pairing exactly the rows it always
 * paired, so this check can only ever add a refusal, never move a verdict that
 * was already being made on a complete set.
 */
function splitCoverage(
  baseline: RunRecord[],
  candidate: RunRecord[],
  split: ScorePreference,
): SplitCoverage {
  const pairing = pairRunRecords(dealtRuns(baseline, split), dealtRuns(candidate, split))
  let answered = 0
  for (const pair of pairing.pairs) {
    if (hasFiniteScore(pair.baseline, split) && hasFiniteScore(pair.treatment, split)) answered += 1
  }
  const unscoredPairs = pairing.pairs.length - answered
  const candidateOnly = pairing.unpairedTreatment.length
  const baselineOnly = pairing.unpairedBaseline.length
  const dealt = pairing.pairs.length + candidateOnly + baselineOnly
  return {
    dealt,
    answered,
    unscoredPairs,
    candidateOnly,
    baselineOnly,
    coverage: dealt === 0 ? 0 : answered / dealt,
  }
}

function meanOrNull(xs: number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function diffOrNull(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a - b
}

function completeCostMedian(runs: RunRecord[]): number | null {
  if (runs.length === 0) return null
  const costs: number[] = []
  for (const run of runs) {
    // `usd` is null for both unknown kinds, so a floor never reads as a total.
    const usd = run.costProvenance.usd
    if (usd === null) return null
    costs.push(usd)
  }
  return sampleMedian(costs.filter(Number.isFinite))
}
