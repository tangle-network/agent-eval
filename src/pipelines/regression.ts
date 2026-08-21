/**
 * RegressionView — compares a candidate slice to a baseline slice on a
 * named metric. Delegates the statistics (Welch's t-test, Cohen's d,
 * IQR stability) to `baseline.ts`.
 *
 * This is the entry point for CI regression gates: "given runs tagged
 * release=A and release=B, did any metric regress?"
 */

import { type BaselineOptions, type BaselineReport, compareToBaseline } from '../baseline'
import { runMetricExtractor } from '../trace/query'
import type { Run } from '../trace/schema'
import type { RunFilter, TraceStore } from '../trace/store'

export interface RegressionSpec {
  metric: string
  higherIsBetter: boolean
  /** Extract a scalar from a run. Omit it and `metric` must name one of
   *  `RUN_METRICS`; any other name is refused. */
  extract?: (run: Run, store: TraceStore) => Promise<number | null>
}

export interface RegressionOptions extends BaselineOptions {
  baseline: RunFilter
  candidate: RunFilter
}

export async function regressionView(
  store: TraceStore,
  metrics: RegressionSpec[],
  options: RegressionOptions,
): Promise<BaselineReport> {
  const baselineRuns = await store.listRuns(options.baseline)
  const candidateRuns = await store.listRuns(options.candidate)
  const samples = await Promise.all(
    metrics.map(async (m) => {
      const extract = m.extract ?? runMetricExtractor(m.metric)
      const baseline = await extractAll(baselineRuns, extract, store)
      const candidate = await extractAll(candidateRuns, extract, store)
      return { metric: m.metric, higherIsBetter: m.higherIsBetter, baseline, candidate }
    }),
  )
  return compareToBaseline(samples, options)
}

async function extractAll(
  runs: Run[],
  extract: (r: Run, s: TraceStore) => Promise<number | null>,
  store: TraceStore,
): Promise<number[]> {
  const out: number[] = []
  for (const r of runs) {
    const v = await extract(r, store)
    if (v !== null && Number.isFinite(v)) out.push(v)
  }
  return out
}
