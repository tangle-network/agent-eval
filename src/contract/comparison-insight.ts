/** Paired candidate lift and independent prior-period metric comparisons. */

import { welchsTTest } from '../baseline'
import { aggregatePairedHoldout } from '../campaign/gates/statistical-heldout'
import { pairRunRecords } from '../paired-arms'
import type { RunRecord } from '../run-record'
import {
  BOOTSTRAP_GATE_MIN_N,
  pairedBootstrap,
  pairedCohensDz,
  pairedMde,
  pairedTTest,
  requiredPairedSampleSize,
} from '../statistics'
import { meanOrZero } from '../statistics/mean'
import type { LiftInsight, MetricDelta, PriorPeriodComparison } from './insight-report'
import {
  collectPerDimension,
  compositeOf,
  finiteCompositeScores,
  isFiniteNumber,
} from './quality-insight'

type MetricDirection = 'higher-is-better' | 'lower-is-better'

export function computePriorPeriodComparison(
  current: RunRecord[],
  baseline: RunRecord[],
  split: 'search' | 'holdout',
  windowLabel: string | undefined,
): PriorPeriodComparison | undefined {
  if (current.length === 0 || baseline.length === 0) return undefined

  const metrics: Record<string, MetricDelta> = {}
  const directions: Record<string, MetricDirection> = {}

  const compositeCurrent = current
    .map((r) => compositeOf(r, split))
    .filter(Number.isFinite) as number[]
  const compositeBaseline = baseline
    .map((r) => compositeOf(r, split))
    .filter(Number.isFinite) as number[]
  if (compositeCurrent.length > 0 && compositeBaseline.length > 0) {
    metrics.composite = welchCompare(compositeBaseline, compositeCurrent)
    directions.composite = 'higher-is-better'
  }

  const costCurrent = knownCostValues(current)
  const costBaseline = knownCostValues(baseline)
  if (costCurrent.length > 0 && costBaseline.length > 0) {
    metrics.cost = welchCompare(costBaseline, costCurrent)
    directions.cost = 'lower-is-better'
  }

  const durCurrent = current.map((r) => r.wallMs).filter(Number.isFinite)
  const durBaseline = baseline.map((r) => r.wallMs).filter(Number.isFinite)
  if (durCurrent.length > 0 && durBaseline.length > 0) {
    metrics.duration = welchCompare(durBaseline, durCurrent)
    directions.duration = 'lower-is-better'
  }

  const tokCurrent = current
    .map((r) => (r.tokenUsage.input ?? 0) + (r.tokenUsage.output ?? 0))
    .filter(Number.isFinite)
  const tokBaseline = baseline
    .map((r) => (r.tokenUsage.input ?? 0) + (r.tokenUsage.output ?? 0))
    .filter(Number.isFinite)
  if (tokCurrent.length > 0 && tokBaseline.length > 0) {
    metrics.tokenUsage = welchCompare(tokBaseline, tokCurrent)
    directions.tokenUsage = 'lower-is-better'
  }

  // Per-dimension judge comparisons — only for dimensions present in BOTH
  // windows. We use perDimMean since per-judge nesting is finicky for
  // two-sample comparisons across different judge configurations.
  const dimsCurrent = collectPerDimension(current)
  const dimsBaseline = collectPerDimension(baseline)
  for (const dim of Object.keys(dimsCurrent)) {
    const b = dimsBaseline[dim]
    const c = dimsCurrent[dim]
    if (!b || b.length === 0 || !c || c.length === 0) continue
    metrics[`dim.${dim}`] = welchCompare(b, c)
    directions[`dim.${dim}`] = 'higher-is-better'
  }

  const regressedMetrics: string[] = []
  const improvedMetrics: string[] = []
  const inconclusiveMetrics: string[] = []
  for (const [name, delta] of Object.entries(metrics)) {
    if (delta.status !== 'ok') {
      inconclusiveMetrics.push(name)
      continue
    }
    if (!delta.significant) continue
    const dir = directions[name] ?? 'higher-is-better'
    const better = dir === 'higher-is-better' ? delta.delta > 0 : delta.delta < 0
    if (better) improvedMetrics.push(name)
    else regressedMetrics.push(name)
  }

  return {
    baselineN: baseline.length,
    currentN: current.length,
    ...(windowLabel ? { windowLabel } : {}),
    metrics,
    regressedMetrics,
    improvedMetrics,
    inconclusiveMetrics,
  }
}

function knownCostValues(runs: RunRecord[]): number[] {
  return runs
    .filter((run) => run.costProvenance.usd !== null)
    .map((run) => run.costUsd)
    .filter(isFiniteNumber)
}

/** Adapt the shared two-sample Welch result to the report contract. */
function welchCompare(baseline: number[], current: number[]): MetricDelta {
  const result = welchsTTest(baseline, current)
  const base = {
    current: result.meanB,
    baseline: result.meanA,
    delta: result.delta,
    baselineN: baseline.length,
    currentN: current.length,
  }
  if (result.status !== 'ok') {
    return {
      ...base,
      status: result.status,
      ci95: null,
      pValue: null,
      cohensD: null,
      significant: false,
    }
  }
  return {
    ...base,
    status: 'ok',
    ci95: result.ci95,
    pValue: result.p,
    cohensD: result.cohensD,
    significant: result.p < 0.05 && Math.abs(result.cohensD) >= 0.2,
  }
}

export function computeLift(
  runs: RunRecord[],
  baselineId: string | undefined,
  candidateId: string | undefined,
  split: 'search' | 'holdout',
  independentUnitByScenarioId?: ReadonlyMap<string, string>,
): LiftInsight | undefined {
  let bId = baselineId
  let cId = candidateId
  if (!bId || !cId) {
    // Auto-detect: when exactly two distinct candidateIds appear, treat the
    // lower-mean side as baseline.
    const ids = [...new Set(runs.map((r) => r.candidateId))]
    if (ids.length !== 2) return undefined
    const [idA, idB] = ids as [string, string]
    const scoresA = finiteCompositeScores(
      runs.filter((run) => run.candidateId === idA),
      split,
    )
    const scoresB = finiteCompositeScores(
      runs.filter((run) => run.candidateId === idB),
      split,
    )
    if (scoresA.length === 0 || scoresB.length === 0) return undefined
    const meanA = meanOrZero(scoresA)
    const meanB = meanOrZero(scoresB)
    bId = meanA <= meanB ? idA : idB
    cId = meanA <= meanB ? idB : idA
  }

  const baseline = runs.filter((r) => r.candidateId === bId)
  const candidate = runs.filter((r) => r.candidateId === cId)
  if (baseline.length === 0 || candidate.length === 0) return undefined

  const scoredBaseline = baseline.filter((run) => Number.isFinite(compositeOf(run, split)))
  const scoredCandidate = candidate.filter((run) => Number.isFinite(compositeOf(run, split)))
  const pairing = pairRunRecords(scoredBaseline, scoredCandidate)
  let pairedBaseline = pairing.pairs.map((pair) => compositeOf(pair.baseline, split))
  let pairedCandidate = pairing.pairs.map((pair) => compositeOf(pair.treatment, split))
  if (pairedBaseline.length === 0) return undefined
  const grouped = independentUnitByScenarioId
    ? aggregatePairedHoldout(
        {
          before: pairedBaseline,
          after: pairedCandidate,
          // Pairing is already fixed by experiment, scenario, and seed.
          // The ordinal labels each matched observation for the shared reducer.
          cellIds: pairing.pairs.map((pair, index) => `${pair.pairKey}:${index}`),
        },
        new Map(
          pairing.pairs.map((pair) => [
            pair.pairKey,
            independentUnitByScenarioId.get(pair.baseline.scenarioId)!,
          ]),
        ),
      )
    : undefined
  if (grouped) {
    pairedBaseline = grouped.before
    pairedCandidate = grouped.after
  }
  const reverseInferredArms =
    grouped !== undefined &&
    (!baselineId || !candidateId) &&
    meanOrZero(pairedBaseline) > meanOrZero(pairedCandidate)
  if (reverseInferredArms) [pairedBaseline, pairedCandidate] = [pairedCandidate, pairedBaseline]

  const baselineMean = meanOrZero(pairedBaseline)
  const candidateMean = meanOrZero(pairedCandidate)
  const delta = candidateMean - baselineMean

  const bootstrap = pairedBootstrap(pairedBaseline, pairedCandidate, {
    confidence: 0.95,
    resamples: 2000,
    statistic: 'mean',
  })
  const tTest = pairedTTest(pairedBaseline, pairedCandidate)
  const d = pairedCohensDz(pairedBaseline, pairedCandidate)
  const mde = pairedMde({ nPaired: pairedBaseline.length, power: 0.8, alpha: 0.05 })
  const requiredN =
    d === null || d === 0
      ? null
      : requiredPairedSampleSize({
          effect: Math.abs(d),
          power: 0.8,
          alpha: 0.05,
        })

  return {
    baselineMean,
    candidateMean,
    delta,
    ci95: [bootstrap.low, bootstrap.high],
    pValue: tTest.p,
    n: pairedBaseline.length,
    ...(grouped ? { pairedRunN: pairing.pairs.length, independentUnitIds: grouped.unitIds } : {}),
    minimumRequired: BOOTSTRAP_GATE_MIN_N,
    decisionEligible: bootstrap.gateEligible,
    unpairedBaseline: (reverseInferredArms ? pairing.unpairedTreatment : pairing.unpairedBaseline)
      .length,
    unpairedCandidate: (reverseInferredArms ? pairing.unpairedBaseline : pairing.unpairedTreatment)
      .length,
    cohensD: d,
    mde,
    requiredN,
  }
}
