/**
 * Correlation study — "does our eval score predict real-world outcomes?"
 *
 * This is the load-bearing signal. Takes a TraceStore + OutcomeStore,
 * joins on runId, computes Pearson + Spearman + bootstrap CI for every
 * (evalMetric, outcomeMetric) pair the caller declares.
 *
 * Without this number the framework is ornamental. With it and r > 0.6
 * the framework is a moat — no other agent-eval tool publishes one.
 */

import type { Run } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { aggregateLlm, llmSpans } from '../trace/query'
import type { OutcomeStore, DeploymentOutcome, OutcomeFilter } from './outcome-store'

export interface EvalMetricSpec {
  id: string
  /** Extract a scalar from a run (defaults cover score/pass/durationMs/costUsd/tokens). */
  extract?: (run: Run, store: TraceStore) => Promise<number | null>
}

export interface OutcomePair {
  evalMetric: string
  outcomeMetric: string
}

export interface CorrelationResult {
  evalMetric: string
  outcomeMetric: string
  n: number
  pearson: number
  spearman: number
  /** 95% bootstrap CI for Pearson. */
  pearsonCi95: { lower: number; upper: number }
  /** Rough verdict: 'strong' ≥ 0.7, 'moderate' ≥ 0.4, else 'weak'. */
  verdict: 'strong' | 'moderate' | 'weak'
}

export interface CorrelationStudyResult {
  pairs: CorrelationResult[]
  joinedSamples: number
  skippedRuns: number
}

export interface CorrelationStudyOptions {
  /** Only join outcomes captured within this window after run.startedAt. */
  maxCaptureLagMs?: number
  /** Restrict to a subset of outcomes (cohort, region, source). */
  outcomeFilter?: OutcomeFilter
  /** Which outcome per run to use when multiple exist. Default 'latest'. */
  reduction?: 'latest' | 'mean' | 'max'
  /** Bootstrap iterations for the CI. Default 500. */
  bootstrapIterations?: number
}

export async function correlationStudy(
  traceStore: TraceStore,
  outcomeStore: OutcomeStore,
  evalMetrics: EvalMetricSpec[],
  outcomeMetricNames: string[],
  options: CorrelationStudyOptions = {},
): Promise<CorrelationStudyResult> {
  const runs = await traceStore.listRuns()
  const outcomes = await outcomeStore.list(options.outcomeFilter)
  const outcomesByRun = new Map<string, DeploymentOutcome[]>()
  for (const o of outcomes) {
    const arr = outcomesByRun.get(o.runId) ?? []
    arr.push(o)
    outcomesByRun.set(o.runId, arr)
  }

  const reduction = options.reduction ?? 'latest'
  const maxLag = options.maxCaptureLagMs ?? Infinity

  const pairs: Array<{ evalMetric: string; outcomeMetric: string; xs: number[]; ys: number[] }> = []
  for (const em of evalMetrics) {
    for (const om of outcomeMetricNames) {
      pairs.push({ evalMetric: em.id, outcomeMetric: om, xs: [], ys: [] })
    }
  }

  let joined = 0
  let skipped = 0
  for (const run of runs) {
    const os = outcomesByRun.get(run.runId)
    if (!os || os.length === 0) { skipped++; continue }
    const eligible = os.filter((o) => o.capturedAt - run.startedAt <= maxLag)
    if (eligible.length === 0) { skipped++; continue }

    for (const em of evalMetrics) {
      const extract = em.extract ?? defaultExtract(em.id)
      const x = await extract(run, traceStore)
      if (x === null || !Number.isFinite(x)) continue

      for (const om of outcomeMetricNames) {
        const values = eligible
          .map((o) => o.metrics[om])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        if (values.length === 0) continue
        const y = reduce(values, reduction, eligible)
        if (y === null) continue
        const pair = pairs.find((p) => p.evalMetric === em.id && p.outcomeMetric === om)!
        pair.xs.push(x)
        pair.ys.push(y)
      }
    }
    joined++
  }

  const results: CorrelationResult[] = pairs
    .filter((p) => p.xs.length >= 3)
    .map((p) => {
      const pearson = pearsonR(p.xs, p.ys)
      const spearman = pearsonR(ranks(p.xs), ranks(p.ys))
      const pearsonCi95 = bootstrapPearsonCi(p.xs, p.ys, options.bootstrapIterations ?? 500)
      const verdict: CorrelationResult['verdict'] =
        Math.abs(pearson) >= 0.7 ? 'strong' :
        Math.abs(pearson) >= 0.4 ? 'moderate' : 'weak'
      return { evalMetric: p.evalMetric, outcomeMetric: p.outcomeMetric, n: p.xs.length, pearson, spearman, pearsonCi95, verdict }
    })

  return { pairs: results, joinedSamples: joined, skippedRuns: skipped }
}

// ── Helpers ──────────────────────────────────────────────────────────

function reduce(values: number[], kind: 'latest' | 'mean' | 'max', outcomes: DeploymentOutcome[]): number | null {
  if (values.length === 0) return null
  if (kind === 'mean') return values.reduce((a, b) => a + b, 0) / values.length
  if (kind === 'max') return Math.max(...values)
  // 'latest': pick the outcome captured last, then lookup its metric
  const latest = [...outcomes].sort((a, b) => b.capturedAt - a.capturedAt)[0]
  const v = latest?.metrics[Object.keys(latest.metrics)[0]]
  // For 'latest' we already have `values` aligned; use the last-captured one
  const paired = outcomes
    .map((o) => ({ at: o.capturedAt, v: values.find((x) => o.metrics[Object.keys(o.metrics)[0]] === x) }))
    .filter((p) => p.v !== undefined)
  if (paired.length === 0) return v ?? null
  return paired.sort((a, b) => b.at - a.at)[0].v ?? null
}

function pearsonR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return NaN
  const mA = a.reduce((s, v) => s + v, 0) / a.length
  const mB = b.reduce((s, v) => s + v, 0) / b.length
  let num = 0, dA = 0, dB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - mA, db = b[i] - mB
    num += da * db; dA += da * da; dB += db * db
  }
  if (dA === 0 || dB === 0) return dA === 0 && dB === 0 ? 1 : 0
  return num / Math.sqrt(dA * dB)
}

function ranks(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v)
  const r = new Array<number>(xs.length)
  for (let i = 0; i < indexed.length; i++) {
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++
    const avg = (i + j + 2) / 2
    for (let k = i; k <= j; k++) r[indexed[k].i] = avg
    i = j
  }
  return r
}

function bootstrapPearsonCi(xs: number[], ys: number[], iterations: number): { lower: number; upper: number } {
  const n = xs.length
  if (n < 3) return { lower: NaN, upper: NaN }
  const rs: number[] = []
  for (let b = 0; b < iterations; b++) {
    const rx: number[] = new Array(n)
    const ry: number[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(Math.random() * n)
      rx[i] = xs[idx]; ry[i] = ys[idx]
    }
    const r = pearsonR(rx, ry)
    if (Number.isFinite(r)) rs.push(r)
  }
  rs.sort((a, b) => a - b)
  if (rs.length === 0) return { lower: NaN, upper: NaN }
  return { lower: rs[Math.floor(0.025 * rs.length)], upper: rs[Math.min(rs.length - 1, Math.floor(0.975 * rs.length))] }
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
      default:
        return null
    }
  }
}
