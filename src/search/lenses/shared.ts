/**
 * Shared, pure helpers for `src/search/lenses/*`.
 *
 * Every lens is a pure function of a `SearchStateView` (search-tree-design
 * §12): it reads no other record type and does no I/O. These helpers exist so
 * each lens states its own numbers instead of re-deriving thresholds; they
 * reuse agent-eval's own statistics and estimator revisions rather than
 * inventing new ones.
 */

import { searchEstimateMethod } from '../../campaign/estimate-node'
import type { SearchStateView } from '../../campaign/search-state'
import { minimumPairsForPairedDeltaTest } from '../../paired-delta-test'
import { confidenceInterval } from '../../statistics'

/** The search's own ranking split: selection when the search declares one,
 * else train. Matches `searchPolicyView` and `agent-eval search show`, so a
 * lens ranks nodes on exactly the split the search itself ranks them on. */
export function rankingSplit(state: SearchStateView): 'train' | 'selection' {
  const header = state.header
  return header && header.splits.selection.tasks.length > 0 ? 'selection' : 'train'
}

/** The smallest sample an exact one-sided sign test can resolve at 95%: the
 * same gate `NodeEstimate.method` uses for `insufficient`. */
export const INSUFFICIENT_FROM = minimumPairsForPairedDeltaTest(0.95)

/** One named signal a `SearchPolicy` can read: a small, quantitative payload
 * under one label, so a policy reads `signal.value` without knowing a lens's
 * full `data` shape. */
export interface LensSignal<T> {
  name: string
  value: T
}

export interface LensResult<TData, TSignal> {
  data: TData
  signal: LensSignal<TSignal>
}

/** A descriptive summary of an independent (unpaired) numeric sample, staged
 * by `NodeEstimate.method`'s own function (`searchEstimateMethod`): `none`
 * below 2 observations, with no mean (one observation is no estimate, §6.4),
 * `insufficient` below {@link INSUFFICIENT_FROM}, `descriptive` (bootstrap
 * interval, spread only) below `BOOTSTRAP_GATE_MIN_N`, `bootstrap`
 * (decision-grade interval) from there. Unlike `estimateNode`, these samples
 * are not paired on a shared unit, so this is never a claim — only a
 * lens's own honest description of what it measured. */
export interface SampleSummary {
  n: number
  mean: number | null
  method: 'none' | 'insufficient' | 'descriptive' | 'bootstrap'
  interval: [number, number] | null
  /** How `interval` was computed; null without one. The samples are
   * independent (unpaired), so it is a percentile bootstrap of their mean:
   * 1000 resamples at 95%, seeded by the caller or else by a hash of the data,
   * so a fixed sample always gives the same interval. */
  intervalMethod: 'percentile-bootstrap-of-mean' | null
}

export function summarizeSamples(samples: readonly number[], seed?: number): SampleSummary {
  const n = samples.length
  const method = searchEstimateMethod(n)
  if (method === 'none') return { n, mean: null, method, interval: null, intervalMethod: null }
  const mean = samples.reduce((a, b) => a + b, 0) / n
  if (method === 'insufficient') {
    return { n, mean, method, interval: null, intervalMethod: null }
  }
  const { lower, upper } = confidenceInterval(
    [...samples],
    0.95,
    seed === undefined ? {} : { seed },
  )
  return {
    n,
    mean,
    method,
    interval: [lower, upper],
    intervalMethod: 'percentile-bootstrap-of-mean',
  }
}
