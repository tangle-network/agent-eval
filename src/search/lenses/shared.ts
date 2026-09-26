/**
 * Shared, pure helpers for `src/search/lenses/*`.
 *
 * Every lens is a pure function of a `SearchStateView` (search-tree-design
 * §12): it reads no other record type and does no I/O. These helpers exist so
 * each lens states its own numbers instead of re-deriving thresholds; they
 * reuse agent-eval's own statistics and estimator revisions rather than
 * inventing new ones.
 */

import type { SearchStateView } from '../../campaign/search-state'
import { minimumPairsForPairedDeltaTest } from '../../paired-delta-test'
import { BOOTSTRAP_GATE_MIN_N, confidenceInterval } from '../../statistics'

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
 * exactly like `NodeEstimate.method`: `none` below 2 observations,
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
}

export function summarizeSamples(samples: readonly number[], seed?: number): SampleSummary {
  const n = samples.length
  if (n === 0) return { n, mean: null, method: 'none', interval: null }
  const mean = samples.reduce((a, b) => a + b, 0) / n
  if (n < INSUFFICIENT_FROM) return { n, mean, method: 'insufficient', interval: null }
  const { lower, upper } = confidenceInterval(
    [...samples],
    0.95,
    seed === undefined ? {} : { seed },
  )
  return {
    n,
    mean,
    method: n < BOOTSTRAP_GATE_MIN_N ? 'descriptive' : 'bootstrap',
    interval: [lower, upper],
  }
}
