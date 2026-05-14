/**
 * Calibration curve — binned "if eval says X, what does reality show?"
 *
 * Companion to correlationStudy. Raw correlation is a single number;
 * the calibration curve shows *where* the eval is well-calibrated vs
 * overconfident / underconfident. Buckets the eval metric, computes
 * mean outcome per bucket, reports expected-calibration-error (ECE).
 */

import type { Run } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import type { EvalMetricSpec } from './correlation-study'
import type { DeploymentOutcome, OutcomeStore } from './outcome-store'

export interface CalibrationBin {
  lower: number
  upper: number
  n: number
  evalMean: number
  outcomeMean: number
  /** |outcomeMean − evalMean|; contributes to ECE weighted by n/total. */
  gap: number
}

export interface CalibrationReport {
  evalMetric: string
  outcomeMetric: string
  n: number
  bins: CalibrationBin[]
  /** Expected Calibration Error — Σ (n_i/N) × |outcomeMean_i − evalMean_i|. */
  ece: number
  /** Max bin gap — upper bound on miscalibration. */
  maxGap: number
}

export interface CalibrationOptions {
  bins?: number
  /** Equal-width (fixed bin edges) or equal-frequency (quantile bins). */
  binning?: 'equal-width' | 'equal-frequency'
  /** Clip eval values to [lo, hi] before binning. */
  range?: { lo: number; hi: number }
}

export async function calibrationCurve(
  traceStore: TraceStore,
  outcomeStore: OutcomeStore,
  evalMetric: EvalMetricSpec,
  outcomeMetric: string,
  options: CalibrationOptions = {},
): Promise<CalibrationReport | null> {
  const runs = await traceStore.listRuns()
  const outcomes = await outcomeStore.list()
  const byRun = new Map<string, DeploymentOutcome[]>()
  for (const o of outcomes) {
    const arr = byRun.get(o.runId) ?? []
    arr.push(o)
    byRun.set(o.runId, arr)
  }

  const extract = evalMetric.extract ?? defaultExtract(evalMetric.id)
  const pairs: Array<{ x: number; y: number }> = []
  for (const run of runs) {
    const os = byRun.get(run.runId)
    if (!os?.length) continue
    const x = await extract(run, traceStore)
    if (x === null || !Number.isFinite(x)) continue
    const latest = [...os].sort((a, b) => b.capturedAt - a.capturedAt)[0]
    const y = latest.metrics[outcomeMetric]
    if (typeof y !== 'number' || !Number.isFinite(y)) continue
    pairs.push({ x, y })
  }
  if (pairs.length < 2) return null

  const numBins = options.bins ?? 10
  const binning = options.binning ?? 'equal-width'
  const xs = pairs.map((p) => p.x)
  const lo = options.range?.lo ?? Math.min(...xs)
  const hi = options.range?.hi ?? Math.max(...xs)

  const bins: CalibrationBin[] = []
  if (binning === 'equal-frequency') {
    const sorted = [...pairs].sort((a, b) => a.x - b.x)
    const perBin = Math.max(1, Math.floor(sorted.length / numBins))
    for (let i = 0; i < sorted.length; i += perBin) {
      const chunk = sorted.slice(i, i + perBin)
      if (chunk.length === 0) continue
      bins.push(toBin(chunk))
    }
  } else {
    const width = (hi - lo) / numBins
    if (width === 0) return null
    for (let i = 0; i < numBins; i++) {
      const binLo = lo + i * width
      const binHi = i === numBins - 1 ? hi + 1e-9 : lo + (i + 1) * width
      const chunk = pairs.filter((p) => p.x >= binLo && p.x < binHi)
      if (chunk.length === 0) continue
      bins.push(toBin(chunk, binLo, binHi))
    }
  }

  const total = bins.reduce((a, b) => a + b.n, 0)
  const ece = bins.reduce((a, b) => a + (b.n / total) * b.gap, 0)
  const maxGap = bins.reduce((a, b) => Math.max(a, b.gap), 0)

  return { evalMetric: evalMetric.id, outcomeMetric, n: pairs.length, bins, ece, maxGap }
}

function toBin(
  chunk: Array<{ x: number; y: number }>,
  lower?: number,
  upper?: number,
): CalibrationBin {
  const xs = chunk.map((c) => c.x)
  const ys = chunk.map((c) => c.y)
  const evalMean = mean(xs)
  const outcomeMean = mean(ys)
  return {
    lower: lower ?? Math.min(...xs),
    upper: upper ?? Math.max(...xs),
    n: chunk.length,
    evalMean,
    outcomeMean,
    gap: Math.abs(outcomeMean - evalMean),
  }
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function defaultExtract(metric: string): (run: Run, store: TraceStore) => Promise<number | null> {
  return async (run) =>
    run.outcome?.score ?? (metric === 'pass' ? (run.outcome?.pass === true ? 1 : 0) : null)
}
