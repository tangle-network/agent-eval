/** Paired gene contrasts, reusable-by-chance rates, and Holm-corrected interactions. */
import { searchEstimateMethod, seedFromDigest } from '../../campaign/estimate-node'
import type { NodeEstimate, SearchSplit } from '../../campaign/search-ledger-types'
import { compareCodeUnits, hashCanonical } from '../../ledger-core/canonical'
import { pairedDeltaTest } from '../../paired-delta-test'
import {
  BOOTSTRAP_GATE_MIN_N,
  DECISION_PAIRED_DELTA_STATISTIC,
  holm,
  pairedSignTest,
} from '../../statistics'
import { mean } from '../../statistics/mean'
import { normalizeSignedZero as plain } from '../../statistics/normalize-signed-zero'
import type {
  EditCreditData,
  EditGene,
  EditGeneVerdict,
  EditInteraction,
  Step,
} from './edit-credit-contract'
import {
  CONFIDENCE,
  DESCRIPTIVE_FROM,
  EDIT_CREDIT_ESTIMATOR,
  INTERACTION_ALPHA,
  RESAMPLES,
} from './edit-credit-contract'

export function pairedEstimate(input: {
  against: string
  split: SearchSplit
  direction: 'maximize' | 'minimize'
  units: number
  carrier: number[]
  lacking: number[]
  cellSetDigest: NodeEstimate['cellSetDigest']
}): { credit: NodeEstimate; verdict: EditGeneVerdict } {
  const pairs = input.carrier.length
  const method = searchEstimateMethod(pairs)
  const base = {
    against: input.against,
    split: input.split,
    units: input.units,
    pairs,
    method,
    cellSetDigest: input.cellSetDigest,
    estimator: EDIT_CREDIT_ESTIMATOR,
  }
  if (method === 'none') {
    return {
      credit: { ...base, delta: null, interval: null, exactSignP: null, indeterminate: false },
      verdict: 'insufficient',
    }
  }
  // The test's `after - before` is the improvement: carrier minus lacking
  // when larger is better, lacking minus carrier when smaller is.
  const maximize = input.direction === 'maximize'
  const before = maximize ? input.lacking : input.carrier
  const after = maximize ? input.carrier : input.lacking
  const options = {
    statistic: DECISION_PAIRED_DELTA_STATISTIC,
    confidence: CONFIDENCE,
    resamples: RESAMPLES,
    seed: seedFromDigest(input.cellSetDigest),
  }
  const better = pairedDeltaTest(before, after, options)
  const worse = pairedDeltaTest(after, before, options)
  const { mean, low, high } = better.bootstrap
  const indeterminate = better.indeterminate
  const spread = (method === 'descriptive' || method === 'bootstrap') && !indeterminate
  const credit: NodeEstimate = {
    ...base,
    delta: plain(maximize ? mean : -mean),
    interval: spread ? (maximize ? [plain(low), plain(high)] : [plain(-high), plain(-low)]) : null,
    exactSignP: method === 'descriptive' && !indeterminate ? better.pValue : null,
    indeterminate,
  }
  const verdict: EditGeneVerdict =
    method === 'insufficient'
      ? 'insufficient'
      : better.significant
        ? 'reusable'
        : worse.significant
          ? 'harmful'
          : 'unresolved'
  return { credit, verdict }
}

/** The chance, with no true effect, that the verdict on `pairs` units is
 * reusable: the exact sign test's attained size (the upper tail at the
 * smallest positive count that clears α) below the bootstrap gate, the
 * percentile bootstrap's nominal one-sided α from it. */
export const chanceReusable = (() => {
  const alpha = (1 - CONFIDENCE) / 2
  const cache = new Map<number, number>()
  return (pairs: number): number => {
    if (pairs < DESCRIPTIVE_FROM) return 0
    if (pairs >= BOOTSTRAP_GATE_MIN_N) return alpha
    const cached = cache.get(pairs)
    if (cached !== undefined) return cached
    let size = 0
    for (let positive = 0; positive <= pairs; positive++) {
      const signs = Array.from({ length: pairs }, (_, index) => (index < positive ? 1 : -1))
      const p = pairedSignTest(signs, 'greater').pValue
      if (p <= alpha) {
        size = p
        break
      }
    }
    cache.set(pairs, size)
    return size
  }
})()

/** The worse end of the interval, as an improvement; -Infinity without one. */
export function improvementLow(credit: NodeEstimate, sign: number): number {
  if (credit.interval === null) return Number.NEGATIVE_INFINITY
  return sign > 0 ? credit.interval[0] : -credit.interval[1]
}

export function gain(credit: NodeEstimate, sign: number): number {
  return credit.delta === null ? Number.NEGATIVE_INFINITY : sign * credit.delta
}

export function interactionPairs(input: {
  genes: readonly EditGene[]
  cleanOf: ReadonlyMap<string, ReadonlyArray<{ step: Step; carrierId: string; lackingId: string }>>
  carriersOf: ReadonlyMap<string, ReadonlySet<string>>
  unitMeansOf: (nodeId: string) => ReadonlyMap<string, number>
  limit: number
  sign: number
}): EditCreditData['interactions'] {
  // One member per linkage group: linked genes have the same clean steps, so
  // every pair across two groups repeats one contrast.
  const seenGroups = new Set<string>()
  const considered = [...input.genes]
    .filter((gene) => {
      const group = gene.linkage ?? gene.geneId
      if (seenGroups.has(group)) return false
      seenGroups.add(group)
      return gene.credit.pairs >= DESCRIPTIVE_FROM
    })
    .sort((a, b) => b.credit.pairs - a.credit.pairs || compareCodeUnits(a.geneId, b.geneId))
    .slice(0, input.limit)

  /** Per unit, the mean clean-step contrast of `geneId` over `steps`. */
  const contrasts = (
    steps: ReadonlyArray<{ carrierId: string; lackingId: string }>,
  ): Map<string, number> => {
    const sums = new Map<string, { sum: number; count: number }>()
    for (const { carrierId, lackingId } of steps) {
      const lacking = input.unitMeansOf(lackingId)
      for (const [unitId, carrierMean] of input.unitMeansOf(carrierId)) {
        const lackingMean = lacking.get(unitId)
        if (lackingMean === undefined) continue
        const entry = sums.get(unitId) ?? { sum: 0, count: 0 }
        entry.sum += carrierMean - lackingMean
        entry.count += 1
        sums.set(unitId, entry)
      }
    }
    return new Map([...sums].map(([unitId, entry]) => [unitId, entry.sum / entry.count]))
  }
  /** `geneId`'s clean steps split by whether both ends carry `other`. */
  const split = (geneId: string, other: string) => {
    const carriers = input.carriersOf.get(other)!
    const steps = input.cleanOf.get(geneId) ?? []
    const withOther = steps.filter(
      ({ step }) => carriers.has(step.parentId) && carriers.has(step.childId),
    )
    const withoutOther = steps.filter(
      ({ step }) => !carriers.has(step.parentId) && !carriers.has(step.childId),
    )
    return { withOther, withoutOther }
  }

  const pairs: EditInteraction[] = []
  for (let i = 0; i < considered.length; i++) {
    for (let j = i + 1; j < considered.length; j++) {
      const first = considered[i]!
      const second = considered[j]!
      if (first.edit.includes(second.geneId) || second.edit.includes(first.geneId)) continue
      const firstSplit = split(first.geneId, second.geneId)
      const secondSplit = split(second.geneId, first.geneId)
      const steps = {
        firstWithSecond: firstSplit.withOther.length,
        firstWithoutSecond: firstSplit.withoutOther.length,
        secondWithFirst: secondSplit.withOther.length,
        secondWithoutFirst: secondSplit.withoutOther.length,
      }
      const directions = [firstSplit, secondSplit].filter(
        (direction) => direction.withOther.length > 0 && direction.withoutOther.length > 0,
      )
      if (directions.length === 0) continue
      const perUnit = new Map<string, { sum: number; count: number }>()
      for (const direction of directions) {
        const withMeans = contrasts(direction.withOther)
        const withoutMeans = contrasts(direction.withoutOther)
        for (const [unitId, withMean] of withMeans) {
          const withoutMean = withoutMeans.get(unitId)
          if (withoutMean === undefined) continue
          const entry = perUnit.get(unitId) ?? { sum: 0, count: 0 }
          entry.sum += withMean - withoutMean
          entry.count += 1
          perUnit.set(unitId, entry)
        }
      }
      const values = [...perUnit.keys()]
        .sort(compareCodeUnits)
        .map((unitId) => perUnit.get(unitId)!.sum / perUnit.get(unitId)!.count)
      pairs.push(interactionEstimate([first.geneId, second.geneId], steps, values, input.sign))
    }
  }
  const tested = pairs.filter((pair) => pair.signP !== null)
  const adjusted = holm(
    tested.map((pair) => pair.signP!),
    INTERACTION_ALPHA,
  )
  tested.forEach((pair, index) => {
    pair.adjustedP = adjusted.adjusted[index]!
    pair.interacting = adjusted.significant[index]!
  })
  pairs.sort(
    (a, b) =>
      Number(b.interacting) - Number(a.interacting) ||
      (a.adjustedP ?? 2) - (b.adjustedP ?? 2) ||
      b.units - a.units ||
      compareCodeUnits(a.genes.join(), b.genes.join()),
  )
  return {
    genesConsidered: considered.length,
    pairsWithContexts: pairs.length,
    pairsTested: tested.length,
    alpha: INTERACTION_ALPHA,
    correction: 'holm',
    pairs,
  }
}

function interactionEstimate(
  genes: [string, string],
  steps: EditInteraction['steps'],
  values: number[],
  sign: number,
): EditInteraction {
  const units = values.length
  const method = searchEstimateMethod(units)
  const base = { genes, steps, units, method, adjustedP: null, interacting: false }
  if (method === 'none') {
    return {
      ...base,
      interaction: null,
      interval: null,
      indeterminate: false,
      signP: null,
      synergy: null,
    }
  }
  const interaction = plain(mean(values))
  if (method === 'insufficient') {
    return {
      ...base,
      interaction,
      interval: null,
      indeterminate: false,
      signP: null,
      synergy: sign * interaction > 0,
    }
  }
  const zeros = values.map(() => 0)
  const test = pairedDeltaTest(zeros, values, {
    statistic: DECISION_PAIRED_DELTA_STATISTIC,
    confidence: CONFIDENCE,
    resamples: RESAMPLES,
    seed: seedFromDigest(hashCanonical({ genes, values })),
  })
  const indeterminate = test.indeterminate
  const greater = pairedSignTest(values, 'greater').pValue
  const less = pairedSignTest(values, 'less').pValue
  return {
    ...base,
    interaction,
    interval: indeterminate ? null : [plain(test.bootstrap.low), plain(test.bootstrap.high)],
    indeterminate,
    signP: indeterminate ? null : Math.min(1, 2 * Math.min(greater, less)),
    synergy: sign * interaction > 0,
  }
}
