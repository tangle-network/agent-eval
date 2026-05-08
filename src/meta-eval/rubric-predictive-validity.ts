/**
 * Rubric predictive validity — does our eval rubric predict deployment
 * outcomes?
 *
 * `correlationStudy` (already in this package) joins a `TraceStore` to an
 * `OutcomeStore` and computes Pearson + Spearman + bootstrap CI for each
 * (eval-metric, outcome-metric) pair. That answers "does X correlate with
 * Y at all." `rubricPredictiveValidity` is the campaign-shaped wrapper
 * around it: take a sequence of `RunRecord`s (the canonical campaign
 * artifact) and a `DeploymentOutcomeStore`, join on `runId`, return a
 * ranked verdict on every rubric whose dimension scores were captured in
 * `outcome.raw`.
 *
 * The point — quoting the methodology doc — is that **without this loop
 * every rubric is faith-based**. Once it's wired, you know which rubrics
 * have earned their promotion power and which ones are decoration.
 *
 *   const validity = await rubricPredictiveValidity({
 *     runs: lastQuarter,
 *     outcomes: shipFlagOutcomeStore,
 *     outcomeMetrics: ['revenue_lift', 'retention_30d', 'csat'],
 *     rubrics: ['anti_slop', 'semantic_concept', 'tool_recovery'],
 *   })
 *   for (const r of validity.ranked) {
 *     console.log(`${r.rubric} → ${r.bestOutcome}: ρ=${r.spearman.toFixed(2)}`)
 *   }
 *
 * The function is intentionally read-only. Use the verdict to deprecate
 * decorative rubrics, re-weight composite scores, or trigger a
 * recalibration sweep when predictive validity drops below a threshold.
 */

import type { RunRecord } from '../run-record'
import type { DeploymentOutcome, OutcomeStore } from './outcome-store'

export interface RubricPredictiveValidityInput {
  /**
   * Canonical campaign output. Each record's `outcome.raw[<rubricId>]`
   * provides the eval score; missing keys are silently skipped per pair.
   */
  runs: RunRecord[]
  outcomes: OutcomeStore
  /**
   * Outcome metric names to evaluate against. Each must appear in at
   * least one `DeploymentOutcome.metrics` keyspace; pairs with too few
   * joined samples are excluded from the result.
   */
  outcomeMetrics: string[]
  /**
   * Rubric ids to evaluate. Must appear as keys in `RunRecord.outcome.raw`.
   * If omitted, every numeric key in `outcome.raw` across the run set is
   * treated as a rubric.
   */
  rubrics?: string[]
  /** Minimum joined-sample count before a pair is reported. Default 8. */
  minSamples?: number
  /** Bootstrap resamples for CI. Default 500. */
  bootstrapResamples?: number
  /** Random seed for the bootstrap (mulberry32). Default unset (Math.random). */
  seed?: number
  /**
   * Reduction when multiple outcomes attach to one runId. Default `'latest'`
   * (most recently captured).
   */
  reduction?: 'latest' | 'mean' | 'max'
}

export interface RubricOutcomePair {
  rubric: string
  outcome: string
  n: number
  pearson: number
  spearman: number
  ci95: { low: number; high: number }
  /**
   * Verdict bucket. `load_bearing` ≥ 0.7, `informative` ≥ 0.4,
   * `decorative` < 0.4 in absolute correlation. A negative correlation
   * with a desired outcome is also `decorative` — actively misleading
   * is worse than uninformative.
   */
  verdict: 'load_bearing' | 'informative' | 'decorative'
}

export interface RubricRanking {
  rubric: string
  /** Outcome metric this rubric correlated best with. */
  bestOutcome: string
  spearman: number
  pearson: number
  n: number
  verdict: RubricOutcomePair['verdict']
}

export interface RubricPredictiveValidityReport {
  pairs: RubricOutcomePair[]
  /** Per-rubric best pair, sorted descending by |spearman|. */
  ranked: RubricRanking[]
  joinedSamples: number
  skippedRuns: number
  /** Rubrics that were declared but never produced a usable score. */
  rubricsWithoutData: string[]
}

export async function rubricPredictiveValidity(
  input: RubricPredictiveValidityInput,
): Promise<RubricPredictiveValidityReport> {
  const minSamples = input.minSamples ?? 8
  const reduction = input.reduction ?? 'latest'
  const resamples = input.bootstrapResamples ?? 500
  const rng = makeRng(input.seed)

  const outcomes = await input.outcomes.list()
  const outcomesByRun = new Map<string, DeploymentOutcome[]>()
  for (const o of outcomes) {
    const arr = outcomesByRun.get(o.runId) ?? []
    arr.push(o)
    outcomesByRun.set(o.runId, arr)
  }

  // Discover rubrics: caller-declared OR every numeric key in outcome.raw
  // observed across runs.
  const observedRubrics = new Set<string>()
  for (const r of input.runs) {
    for (const k of Object.keys(r.outcome.raw)) observedRubrics.add(k)
  }
  const rubrics = input.rubrics ?? [...observedRubrics]

  // Collect aligned (x, y) pairs per (rubric, outcome).
  type Bucket = { rubric: string; outcome: string; xs: number[]; ys: number[] }
  const buckets: Bucket[] = []
  for (const r of rubrics) {
    for (const o of input.outcomeMetrics) {
      buckets.push({ rubric: r, outcome: o, xs: [], ys: [] })
    }
  }

  let joined = 0
  let skipped = 0
  for (const run of input.runs) {
    const os = outcomesByRun.get(run.runId)
    if (!os || os.length === 0) { skipped++; continue }
    let joinedThisRun = false
    for (const r of rubrics) {
      const x = run.outcome.raw[r]
      if (typeof x !== 'number' || !Number.isFinite(x)) continue
      for (const o of input.outcomeMetrics) {
        const values = os
          .map((row) => row.metrics[o])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        if (values.length === 0) continue
        const y = reduce(values, os, o, reduction)
        if (y === null) continue
        const bucket = buckets.find((b) => b.rubric === r && b.outcome === o)!
        bucket.xs.push(x)
        bucket.ys.push(y)
        joinedThisRun = true
      }
    }
    if (joinedThisRun) joined++
  }

  const pairs: RubricOutcomePair[] = []
  for (const b of buckets) {
    if (b.xs.length < minSamples) continue
    const pearson = pearsonR(b.xs, b.ys)
    const spearman = pearsonR(rankWithTies(b.xs), rankWithTies(b.ys))
    const ci = bootstrapCi(b.xs, b.ys, resamples, rng)
    const verdict: RubricOutcomePair['verdict'] =
      Math.abs(spearman) >= 0.7 ? 'load_bearing'
      : Math.abs(spearman) >= 0.4 ? 'informative'
      : 'decorative'
    pairs.push({
      rubric: b.rubric, outcome: b.outcome, n: b.xs.length,
      pearson, spearman, ci95: ci, verdict,
    })
  }

  const byRubric = new Map<string, RubricOutcomePair[]>()
  for (const p of pairs) {
    const arr = byRubric.get(p.rubric) ?? []
    arr.push(p)
    byRubric.set(p.rubric, arr)
  }
  const ranked: RubricRanking[] = [...byRubric.entries()]
    .map(([rubric, ps]) => {
      const best = ps.reduce((a, b) => (Math.abs(b.spearman) > Math.abs(a.spearman) ? b : a))
      return {
        rubric,
        bestOutcome: best.outcome,
        spearman: best.spearman,
        pearson: best.pearson,
        n: best.n,
        verdict: best.verdict,
      }
    })
    .sort((a, b) => Math.abs(b.spearman) - Math.abs(a.spearman))

  const rubricsWithoutData = rubrics.filter((r) => !byRubric.has(r))

  return { pairs, ranked, joinedSamples: joined, skippedRuns: skipped, rubricsWithoutData }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function reduce(
  values: number[],
  outcomes: DeploymentOutcome[],
  metric: string,
  kind: 'latest' | 'mean' | 'max',
): number | null {
  if (values.length === 0) return null
  if (kind === 'mean') return values.reduce((s, v) => s + v, 0) / values.length
  if (kind === 'max') return Math.max(...values)
  // 'latest'
  const sorted = [...outcomes]
    .filter((o) => typeof o.metrics[metric] === 'number')
    .sort((a, b) => b.capturedAt - a.capturedAt)
  return sorted[0]?.metrics[metric] ?? null
}

function pearsonR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return Number.NaN
  const ma = a.reduce((s, v) => s + v, 0) / a.length
  const mb = b.reduce((s, v) => s + v, 0) / b.length
  let num = 0, da = 0, db = 0
  for (let i = 0; i < a.length; i++) {
    const xa = a[i]! - ma
    const xb = b[i]! - mb
    num += xa * xb; da += xa * xa; db += xb * xb
  }
  if (da === 0 || db === 0) return da === 0 && db === 0 ? 1 : 0
  return num / Math.sqrt(da * db)
}

function rankWithTies(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const r = new Array<number>(xs.length)
  for (let i = 0; i < indexed.length; ) {
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++
    const avg = (i + j + 2) / 2
    for (let k = i; k <= j; k++) r[indexed[k]!.i] = avg
    i = j + 1
  }
  return r
}

function bootstrapCi(
  xs: number[],
  ys: number[],
  iterations: number,
  rng: () => number,
): { low: number; high: number } {
  const n = xs.length
  if (n < 3) return { low: Number.NaN, high: Number.NaN }
  const samples: number[] = []
  for (let b = 0; b < iterations; b++) {
    const rx = new Array<number>(n)
    const ry = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n)
      rx[i] = xs[idx]!
      ry[i] = ys[idx]!
    }
    const r = pearsonR(rx, ry)
    if (Number.isFinite(r)) samples.push(r)
  }
  samples.sort((a, b) => a - b)
  if (samples.length === 0) return { low: Number.NaN, high: Number.NaN }
  return {
    low: samples[Math.floor(0.025 * samples.length)]!,
    high: samples[Math.min(samples.length - 1, Math.floor(0.975 * samples.length))]!,
  }
}

function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
