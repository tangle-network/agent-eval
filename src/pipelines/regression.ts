/**
 * RegressionView — compares a candidate slice to a baseline slice on a
 * named metric. Delegates the statistics (Welch's t-test, Cohen's d,
 * IQR stability) to `baseline.ts`.
 *
 * This is the entry point for CI regression gates: "given runs tagged
 * release=A and release=B, did any metric regress?"
 */

import { compareToBaseline, type BaselineOptions, type BaselineReport } from '../baseline'
import type { RunFilter, TraceStore } from '../trace/store'
import type { Run } from '../trace/schema'
import { aggregateLlm, llmSpans, runFailureClass } from '../trace/query'

export interface RegressionSpec {
  metric: string
  higherIsBetter: boolean
  /** Extract a scalar from a run. Default extractors handle common metrics. */
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
      const extract = m.extract ?? defaultExtract(m.metric)
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

function defaultExtract(metric: string): (run: Run, store: TraceStore) => Promise<number | null> {
  return async (run, store) => {
    switch (metric) {
      case 'score':
      case 'overallScore':
        return run.outcome?.score ?? null
      case 'pass':
        return run.outcome?.pass === true ? 1 : 0
      case 'durationMs':
        return run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null
      case 'costUsd': {
        const llm = await llmSpans(store, run.runId)
        return aggregateLlm(llm).costUsd
      }
      case 'inputTokens': {
        const llm = await llmSpans(store, run.runId)
        return aggregateLlm(llm).inputTokens
      }
      case 'outputTokens': {
        const llm = await llmSpans(store, run.runId)
        return aggregateLlm(llm).outputTokens
      }
      case 'failureClass': {
        return runFailureClass(run) === 'success' ? 1 : 0
      }
      default:
        return null
    }
  }
}
