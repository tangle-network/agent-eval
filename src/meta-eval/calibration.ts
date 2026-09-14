/**
 * Calibration curve — binned "if eval says X, what does reality show?"
 *
 * Companion to correlationStudy. Raw correlation is a single number;
 * the calibration curve shows *where* the eval is well-calibrated vs
 * overconfident / underconfident. Buckets the eval metric, computes
 * mean outcome per bucket, reports expected-calibration-error (ECE).
 */

import { runMetricExtractor } from '../trace/query'
import type { TraceStore } from '../trace/store'
import type { EvalMetricSpec } from './correlation-study'
import { assertUniqueObservationIds, reduceOutcomeMetric } from './outcome-observations'
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
  /** Largest observed difference between a bin's mean score and mean outcome. */
  maxGap: number
}

export interface CalibrationOptions {
  /** Positive integer; empty bins are omitted. Default 10. */
  bins?: number
  /** Equal-width (fixed bin edges) or equal-frequency (quantile bins). */
  binning?: 'equal-width' | 'equal-frequency'
  /** Clip eval values to [lo, hi] before binning. */
  range?: { lo: number; hi: number }
}

export interface CalibrationPair {
  evalScore: number
  outcome: number
}

export async function calibrationCurve(
  traceStore: TraceStore,
  outcomeStore: OutcomeStore,
  evalMetric: EvalMetricSpec,
  outcomeMetric: string,
  options: CalibrationOptions = {},
): Promise<CalibrationReport | null> {
  const settings = {
    ...options,
    range: options.range === undefined ? undefined : { ...options.range },
  }
  validateCalibrationRequest(evalMetric.id, outcomeMetric, settings)
  const extract = evalMetric.extract ?? runMetricExtractor(evalMetric.id)
  const metricId = evalMetric.id
  const runs = await traceStore.listRuns()
  assertUniqueObservationIds(
    runs.map((run) => run.runId),
    'runId',
  )
  const outcomes = await outcomeStore.list()
  const byRun = new Map<string, DeploymentOutcome[]>()
  for (const o of outcomes) {
    const arr = byRun.get(o.runId) ?? []
    arr.push(o)
    byRun.set(o.runId, arr)
  }

  const pairs: Array<{ x: number; y: number }> = []
  for (const run of runs) {
    const os = byRun.get(run.runId)
    if (!os?.length) continue
    const x = await extract(run, traceStore)
    if (x === null || !Number.isFinite(x)) continue
    const y = reduceOutcomeMetric(os, outcomeMetric, 'latest')
    if (y === null) continue
    pairs.push({ x, y })
  }
  if (pairs.length < 2) return null

  return calibrationFromPairs(
    pairs.map((p) => ({ evalScore: p.x, outcome: p.y })),
    metricId,
    outcomeMetric,
    settings,
  )
}

/** Measure already joined observations without constructing trace and outcome stores. */
export function calibrationFromPairs(
  inputPairs: readonly CalibrationPair[],
  evalMetric: string,
  outcomeMetric: string,
  options: CalibrationOptions = {},
): CalibrationReport | null {
  validateCalibrationRequest(evalMetric, outcomeMetric, options)
  for (const [index, pair] of inputPairs.entries()) {
    if (
      pair === null ||
      typeof pair !== 'object' ||
      !Number.isFinite(pair.evalScore) ||
      !Number.isFinite(pair.outcome)
    ) {
      throw new Error(`calibration pair ${index} must contain finite evalScore and outcome values`)
    }
  }
  const pairs = inputPairs
  if (pairs.length < 2) return null

  const numBins = options.bins ?? 10
  const binning = options.binning ?? 'equal-width'
  const xs = pairs.map((p) => p.evalScore)
  const lo = options.range?.lo ?? Math.min(...xs)
  const hi = options.range?.hi ?? Math.max(...xs)
  const span = hi - lo
  if (!Number.isFinite(span)) throw new Error('calibration range span must be finite')
  const clipped = pairs.map((pair) => ({
    ...pair,
    evalScore: Math.min(hi, Math.max(lo, pair.evalScore)),
  }))

  const bins: CalibrationBin[] = []
  if (span === 0 || clipped.every((pair) => pair.evalScore === clipped[0]!.evalScore)) {
    bins.push(toBin(clipped))
  } else if (binning === 'equal-frequency') {
    const sorted = [...clipped].sort((a, b) => a.evalScore - b.evalScore)
    const count = Math.min(numBins, sorted.length)
    for (let i = 0; i < count; i++) {
      const start = Math.floor((i * sorted.length) / count)
      const end = Math.floor(((i + 1) * sorted.length) / count)
      bins.push(toBin(sorted.slice(start, end)))
    }
  } else {
    const groups = new Map<number, CalibrationPair[]>()
    for (const pair of clipped) {
      const index = Math.min(numBins - 1, Math.floor(((pair.evalScore - lo) / span) * numBins))
      const group = groups.get(index) ?? []
      group.push(pair)
      groups.set(index, group)
    }
    for (const [index, chunk] of [...groups].sort(([a], [b]) => a - b)) {
      bins.push(toBin(chunk, lo + span * (index / numBins), lo + span * ((index + 1) / numBins)))
    }
  }

  const total = bins.reduce((a, b) => a + b.n, 0)
  const ece = bins.reduce((a, b) => a + (b.n / total) * b.gap, 0)
  const maxGap = bins.reduce((a, b) => Math.max(a, b.gap), 0)

  return { evalMetric, outcomeMetric, n: pairs.length, bins, ece, maxGap }
}

function toBin(chunk: CalibrationPair[], lower?: number, upper?: number): CalibrationBin {
  const xs = chunk.map((c) => c.evalScore)
  const ys = chunk.map((c) => c.outcome)
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
  return xs.reduce((sum, value) => sum + value / xs.length, 0)
}

function validateCalibrationRequest(
  evalMetric: string,
  outcomeMetric: string,
  options: CalibrationOptions,
): void {
  assertUniqueObservationIds([evalMetric], 'eval metric')
  assertUniqueObservationIds([outcomeMetric], 'outcome metric')
  if (evalMetric.trim() !== evalMetric || outcomeMetric.trim() !== outcomeMetric) {
    throw new Error('calibration metric identities must not have surrounding whitespace')
  }
  if (options.bins !== undefined && (!Number.isSafeInteger(options.bins) || options.bins < 1)) {
    throw new Error('calibration bins must be a positive safe integer')
  }
  if (
    options.binning !== undefined &&
    !['equal-width', 'equal-frequency'].includes(options.binning)
  ) {
    throw new Error('calibration binning must be equal-width or equal-frequency')
  }
  if (
    options.range !== undefined &&
    (!Number.isFinite(options.range.lo) ||
      !Number.isFinite(options.range.hi) ||
      !Number.isFinite(options.range.hi - options.range.lo) ||
      options.range.hi < options.range.lo)
  ) {
    throw new Error('calibration range must have finite ordered bounds')
  }
}
