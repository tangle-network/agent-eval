/**
 * # `analyzeRuns()` — turn a set of agent runs into an actionable decision packet.
 *
 * Wires the substrate's statistical, calibration, clustering, Pareto, and
 * release-confidence primitives into one `InsightReport`. Two top-level
 * entry points use this function:
 *
 *   - `selfImprove()` calls it on the campaign output to attach a packet
 *     to every run.
 *   - Consumers with observed `RunRecord[]` (production traces, gold
 *     corpora, approve/reject tables) call it directly via `analyzeRuns()`
 *     for analysis without a closed loop.
 *
 * Every section is opt-in based on what the input data supports — the
 * function never invents signal. If runs carry no judge scores, `judges`
 * is empty. If there's no baseline/candidate split, `lift` is undefined.
 * If no `analyst` is wired, `failureClusters` is undefined.
 *
 * The `recommendations` array is the human-readable layer; everything
 * else is the evidence backing each recommendation.
 */

import type { AnalystRegistry } from '../analyst/registry'
import type { AnalystFinding } from '../analyst/types'
import { checkCanaries } from '../contamination-guard'
import type { DatasetScenario } from '../dataset'
import type { RunRecord } from '../run-record'
import { cohensD, pairedBootstrap, pairedMde, pairedTTest, requiredSampleSize } from '../statistics'
import { type ParetoFigureSpec, paretoChart } from '../summary-report'

import type {
  FailureClusterInsight,
  InsightReport,
  InterRaterInsight,
  JudgeInsight,
  LiftInsight,
  OutcomeCorrelationInsight,
  Recommendation,
  ScalarDistribution,
} from './insight-report'

// ── Public API ───────────────────────────────────────────────────────

export interface AnalyzeRunsOptions {
  /** The runs to analyze. */
  runs: RunRecord[]
  /** Which split to score against when reading composite from RunOutcome.
   *  Default: holdout when ANY run has a `holdoutScore`, else search. */
  split?: 'search' | 'holdout' | 'auto'
  /** Pairwise analysis configuration. When both `baselineCandidateId` and
   *  `candidateCandidateId` are present, lift is computed on paired
   *  (experimentId, seed) tuples shared between the two sides. */
  baselineCandidateId?: string
  candidateCandidateId?: string
  /** Canary scenarios — checked against every run's raw output for
   *  holdout contamination. */
  canaryScenarios?: DatasetScenario[]
  /** Analyst registry for failure clustering. When omitted, the
   *  `failureClusters` section is left undefined. */
  analyst?: AnalystRegistry
  /** Downstream outcome metric per run (e.g. engagement rate, approval
   *  rate, downstream pass rate). When present, the report includes
   *  `outcomeCorrelation` + a simple linear reward model fit. */
  outcomeSignal?: {
    metric: string
    valueByRunId: Record<string, number>
  }
  /** Multi-rater feedback for inter-rater agreement. Each entry is one
   *  rater's score for one run. Two or more raters → kappa + disagreement
   *  triage list. */
  raterScores?: Array<{ runId: string; rater: string; score: number }>
  /** Number of histogram bins for distributional summaries. Default 12. */
  histogramBins?: number
  /** Decision threshold — the smallest composite lift the caller cares
   *  about. Used by the recommendations engine to call ship vs hold.
   *  Default 0.02. */
  decisionThreshold?: number
}

export async function analyzeRuns(opts: AnalyzeRunsOptions): Promise<InsightReport> {
  const runs = opts.runs
  const bins = opts.histogramBins ?? 12
  const threshold = opts.decisionThreshold ?? 0.02
  const split = resolveSplit(runs, opts.split ?? 'auto')

  const composite = distributionOf(
    runs.map((r) => compositeOf(r, split)).filter(Number.isFinite) as number[],
    bins,
  )

  const perDimension = computePerDimension(runs, bins)

  const costQuality = {
    cost: distributionOf(runs.map((r) => r.costUsd).filter(Number.isFinite), bins),
    pareto: paretoChart(runs, { split }),
  }

  const judges = computeJudgeInsights(runs)

  const interRater = opts.raterScores ? computeInterRater(opts.raterScores) : undefined

  const lift = computeLift(runs, opts.baselineCandidateId, opts.candidateCandidateId, split)

  const failureClusters = opts.analyst
    ? await computeFailureClusters(runs, opts.analyst, split)
    : undefined

  const contamination = opts.canaryScenarios
    ? computeContamination(runs, opts.canaryScenarios)
    : undefined

  const outcomeCorrelation = opts.outcomeSignal
    ? computeOutcomeCorrelation(runs, opts.outcomeSignal, split)
    : undefined

  const release = buildReleaseScorecard(composite, lift, contamination)

  const recommendations = buildRecommendations({
    composite,
    judges,
    interRater,
    lift,
    failureClusters,
    contamination,
    outcomeCorrelation,
    threshold,
  })

  return {
    n: runs.length,
    composite,
    perDimension,
    costQuality,
    judges,
    interRater,
    lift,
    failureClusters,
    contamination,
    outcomeCorrelation,
    release,
    recommendations,
  }
}

// ── Composite + split selection ─────────────────────────────────────

function resolveSplit(
  runs: RunRecord[],
  pref: 'search' | 'holdout' | 'auto',
): 'search' | 'holdout' {
  if (pref !== 'auto') return pref
  const hasHoldout = runs.some((r) => Number.isFinite(r.outcome.holdoutScore))
  return hasHoldout ? 'holdout' : 'search'
}

function compositeOf(run: RunRecord, split: 'search' | 'holdout'): number {
  const primary = split === 'holdout' ? run.outcome.holdoutScore : run.outcome.searchScore
  if (Number.isFinite(primary)) return primary as number
  // Fall through to the other split if the preferred one is missing —
  // analyzeRuns shouldn't refuse to summarise a run just because the
  // caller asked for the split that wasn't recorded.
  const alt = split === 'holdout' ? run.outcome.searchScore : run.outcome.holdoutScore
  return Number.isFinite(alt) ? (alt as number) : Number.NaN
}

// ── Distribution helpers ────────────────────────────────────────────

function distributionOf(values: number[], bins: number): ScalarDistribution {
  if (values.length === 0) {
    return {
      n: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      stddev: 0,
      min: 0,
      max: 0,
      histogram: [],
    }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, v) => s + v, 0) / n
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)
  return {
    n,
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    stddev,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    histogram: histogram(sorted, bins),
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const idx = (sorted.length - 1) * q
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  const w = idx - lo
  return sorted[lo]! * (1 - w) + sorted[hi]! * w
}

/** Even-width histogram over the value range. Returns inclusive-lo /
 *  exclusive-hi bins (closed on right for the last bin) compatible with
 *  the substrate's `GainDistributionBin` shape. */
function histogram(sorted: number[], bins: number): ScalarDistribution['histogram'] {
  if (sorted.length === 0 || bins < 1) return []
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!
  if (min === max) return [{ lo: min, hi: max, count: sorted.length }]
  const width = (max - min) / bins
  const out: ScalarDistribution['histogram'] = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * width
    const hi = i === bins - 1 ? max : lo + width
    out.push({ lo, hi, count: 0 })
  }
  for (const v of sorted) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / width))
    out[idx]!.count++
  }
  return out
}

function computePerDimension(runs: RunRecord[], bins: number): Record<string, ScalarDistribution> {
  // JudgeScoresRecord pre-aggregates `perDimMean` (mean across judges per
  // dimension). We collect those means across runs to produce a per-dim
  // distribution at the corpus level. Consumers who want per-judge
  // dimension values reach into `perJudge[judgeId][dim]` themselves.
  const byDim = new Map<string, number[]>()
  for (const run of runs) {
    const scores = run.outcome.judgeScores
    if (!scores) continue
    for (const [dim, value] of Object.entries(scores.perDimMean ?? {})) {
      if (!Number.isFinite(value)) continue
      const arr = byDim.get(dim) ?? []
      arr.push(value)
      byDim.set(dim, arr)
    }
  }
  const out: Record<string, ScalarDistribution> = {}
  for (const [dim, values] of byDim) out[dim] = distributionOf(values, bins)
  return out
}

// ── Judge insights ──────────────────────────────────────────────────

function computeJudgeInsights(runs: RunRecord[]): Record<string, JudgeInsight> {
  // Each judge's per-run mean is the average of its per-dimension scores
  // for that run. We aggregate those means across all runs each judge
  // scored — giving consumers a "this judge's typical verdict" reading.
  const out: Record<string, JudgeInsight> = {}
  const byJudge = new Map<string, number[]>()
  for (const run of runs) {
    const scores = run.outcome.judgeScores
    if (!scores?.perJudge) continue
    for (const [judgeId, dims] of Object.entries(scores.perJudge)) {
      const dimValues = Object.values(dims).filter(Number.isFinite) as number[]
      if (dimValues.length === 0) continue
      const judgeMean = dimValues.reduce((s, v) => s + v, 0) / dimValues.length
      const arr = byJudge.get(judgeId) ?? []
      arr.push(judgeMean)
      byJudge.set(judgeId, arr)
    }
  }
  for (const [judgeId, values] of byJudge) {
    out[judgeId] = {
      n: values.length,
      meanScore: values.reduce((s, v) => s + v, 0) / values.length,
    }
  }
  return out
}

// ── Inter-rater agreement ───────────────────────────────────────────

function computeInterRater(
  ratings: Array<{ runId: string; rater: string; score: number }>,
): InterRaterInsight | undefined {
  const byRun = new Map<string, Array<{ rater: string; score: number }>>()
  for (const r of ratings) {
    if (!Number.isFinite(r.score)) continue
    const list = byRun.get(r.runId) ?? []
    list.push({ rater: r.rater, score: r.score })
    byRun.set(r.runId, list)
  }
  const raters = new Set(ratings.map((r) => r.rater))
  const jointlyRated: string[] = []
  for (const [runId, ratersForRun] of byRun) {
    const seen = new Set(ratersForRun.map((r) => r.rater))
    let all = true
    for (const r of raters) if (!seen.has(r)) all = false
    if (all) jointlyRated.push(runId)
  }
  if (raters.size < 2 || jointlyRated.length === 0) return undefined

  const raterList = [...raters].sort()
  const perPair: Record<string, number> = {}
  for (let i = 0; i < raterList.length; i++) {
    for (let j = i + 1; j < raterList.length; j++) {
      const a = raterList[i]!
      const b = raterList[j]!
      const aScores: number[] = []
      const bScores: number[] = []
      for (const runId of jointlyRated) {
        const ratersForRun = byRun.get(runId)!
        const sa = ratersForRun.find((r) => r.rater === a)?.score
        const sb = ratersForRun.find((r) => r.rater === b)?.score
        if (sa !== undefined && sb !== undefined) {
          aScores.push(sa)
          bScores.push(sb)
        }
      }
      perPair[`${a}::${b}`] = pearson(aScores, bScores)
    }
  }
  const pairKappas = Object.values(perPair)
  const kappa =
    pairKappas.length === 0 ? 0 : pairKappas.reduce((s, v) => s + v, 0) / pairKappas.length

  const disagreementCases = jointlyRated
    .map((runId) => {
      const ratersForRun = byRun.get(runId)!
      const scores = ratersForRun.map((r) => r.score)
      const range = Math.max(...scores) - Math.min(...scores)
      return { runId, ratings: ratersForRun, range }
    })
    .sort((a, b) => b.range - a.range)
    .slice(0, 20)

  return {
    raters: raters.size,
    jointlyRated: jointlyRated.length,
    kappa,
    perPair,
    disagreementCases,
  }
}

function pearson(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  const n = a.length
  const meanA = a.reduce((s, v) => s + v, 0) / n
  const meanB = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let denomA = 0
  let denomB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA
    const db = b[i]! - meanB
    num += da * db
    denomA += da * da
    denomB += db * db
  }
  const denom = Math.sqrt(denomA * denomB)
  return denom === 0 ? 0 : num / denom
}

// ── Lift ────────────────────────────────────────────────────────────

function computeLift(
  runs: RunRecord[],
  baselineId: string | undefined,
  candidateId: string | undefined,
  split: 'search' | 'holdout',
): LiftInsight | undefined {
  let bId = baselineId
  let cId = candidateId
  if (!bId || !cId) {
    // Auto-detect: when exactly two distinct candidateIds appear, treat the
    // lower-mean side as baseline.
    const ids = [...new Set(runs.map((r) => r.candidateId))]
    if (ids.length !== 2) return undefined
    const [idA, idB] = ids as [string, string]
    const meanA = mean(runs.filter((r) => r.candidateId === idA).map((r) => compositeOf(r, split)))
    const meanB = mean(runs.filter((r) => r.candidateId === idB).map((r) => compositeOf(r, split)))
    bId = meanA <= meanB ? idA : idB
    cId = meanA <= meanB ? idB : idA
  }

  const baseline = runs.filter((r) => r.candidateId === bId)
  const candidate = runs.filter((r) => r.candidateId === cId)
  if (baseline.length === 0 || candidate.length === 0) return undefined

  // Pair on (experimentId, seed). When that key doesn't match, fall back
  // to ordinal pairing — common for fresh runs from the same scenario list.
  const baselineByKey = new Map(baseline.map((r) => [pairingKey(r), r]))
  const pairedBaseline: number[] = []
  const pairedCandidate: number[] = []
  let usedKeyPairing = false
  for (const cand of candidate) {
    const b = baselineByKey.get(pairingKey(cand))
    if (b) {
      const bC = compositeOf(b, split)
      const cC = compositeOf(cand, split)
      if (Number.isFinite(bC) && Number.isFinite(cC)) {
        pairedBaseline.push(bC)
        pairedCandidate.push(cC)
        usedKeyPairing = true
      }
    }
  }
  if (!usedKeyPairing) {
    const n = Math.min(baseline.length, candidate.length)
    for (let i = 0; i < n; i++) {
      const bC = compositeOf(baseline[i]!, split)
      const cC = compositeOf(candidate[i]!, split)
      if (Number.isFinite(bC) && Number.isFinite(cC)) {
        pairedBaseline.push(bC)
        pairedCandidate.push(cC)
      }
    }
  }
  if (pairedBaseline.length === 0) return undefined

  const baselineMean = mean(pairedBaseline)
  const candidateMean = mean(pairedCandidate)
  const delta = candidateMean - baselineMean

  const bootstrap = pairedBootstrap(pairedBaseline, pairedCandidate, {
    confidence: 0.95,
    resamples: 2000,
    statistic: 'mean',
  })
  const tTest = pairedTTest(pairedBaseline, pairedCandidate)
  const d = cohensD(pairedBaseline, pairedCandidate)
  const mde = pairedMde({ nPaired: pairedBaseline.length, power: 0.8, alpha: 0.05 })
  const requiredN = requiredSampleSize({
    effect: Math.max(Math.abs(delta), 1e-6),
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
    cohensD: d,
    mde,
    requiredN,
  }
}

function pairingKey(r: RunRecord): string {
  return `${r.experimentId}::${r.seed}`
}

function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length
}

// ── Failure clustering ──────────────────────────────────────────────

async function computeFailureClusters(
  runs: RunRecord[],
  analyst: AnalystRegistry,
  split: 'search' | 'holdout',
): Promise<FailureClusterInsight | undefined> {
  const failed = runs.filter((r) => compositeOf(r, split) < 0.5 || r.failureMode !== undefined)
  if (failed.length === 0) return { clusters: [], totalFailures: 0 }

  const clusters = new Map<string, { exemplars: string[]; share: number }>()
  for (const run of failed) {
    try {
      const result = await analyst.run(run.runId, {
        kind: 'run-record',
        run,
      } as Parameters<typeof analyst.run>[1])
      for (const finding of result.findings as AnalystFinding[]) {
        const key = finding.area || finding.analyst_id || 'unclassified'
        const c = clusters.get(key) ?? { exemplars: [], share: 0 }
        if (c.exemplars.length < 5) c.exemplars.push(run.runId)
        clusters.set(key, c)
      }
    } catch {
      const c = clusters.get('analyst-error') ?? { exemplars: [], share: 0 }
      if (c.exemplars.length < 5) c.exemplars.push(run.runId)
      clusters.set('analyst-error', c)
    }
  }
  const clusterList = [...clusters.entries()].map(([id, c]) => ({
    id,
    name: id,
    share: c.exemplars.length / failed.length,
    exemplars: c.exemplars,
  }))
  clusterList.sort((a, b) => b.share - a.share)
  return { clusters: clusterList, totalFailures: failed.length }
}

// ── Contamination ──────────────────────────────────────────────────

function computeContamination(
  runs: RunRecord[],
  canaries: DatasetScenario[],
): InsightReport['contamination'] {
  let leaks = 0
  const details: Array<{ runId: string; canary: string; matched: string }> = []
  for (const run of runs) {
    const output = stringifyOutput(run)
    if (!output) continue
    const leaksHere = checkCanaries(output, canaries)
    for (const leak of leaksHere) {
      leaks++
      details.push({ runId: run.runId, canary: leak.canary, matched: leak.evidence })
    }
  }
  return { leaks, holdoutAuditPassed: leaks === 0, details }
}

function stringifyOutput(run: RunRecord): string | undefined {
  // RunRecord doesn't fix where "the agent's output" lives — different
  // consumers stash it differently. We probe the common shapes: the
  // outcome.raw map (numeric only by design — unlikely to contain text),
  // and any string-valued fields tucked under metadata via type casting.
  // Consumers with bespoke shapes pass canaryScenarios only when they
  // know their runs carry a stringifiable surface.
  const metadata = (run as unknown as { metadata?: Record<string, unknown> }).metadata
  if (typeof metadata?.output === 'string') return metadata.output
  if (typeof metadata?.text === 'string') return metadata.text
  return undefined
}

// ── Outcome correlation + linear reward model ──────────────────────

function computeOutcomeCorrelation(
  runs: RunRecord[],
  outcome: { metric: string; valueByRunId: Record<string, number> },
  split: 'search' | 'holdout',
): OutcomeCorrelationInsight | undefined {
  const xs: number[] = []
  const ys: number[] = []
  for (const run of runs) {
    const y = outcome.valueByRunId[run.runId]
    if (y === undefined || !Number.isFinite(y)) continue
    const x = compositeOf(run, split)
    if (!Number.isFinite(x)) continue
    xs.push(x)
    ys.push(y)
  }
  if (xs.length < 3) return undefined

  const p = pearson(xs, ys)
  const s = spearman(xs, ys)
  const meanX = mean(xs)
  const meanY = mean(ys)
  let num = 0
  let denom = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY)
    denom += (xs[i]! - meanX) ** 2
  }
  const slope = denom === 0 ? 0 : num / denom
  const intercept = meanY - slope * meanX
  const ssTot = ys.reduce((a, y) => a + (y - meanY) ** 2, 0)
  const ssRes = ys.reduce((a, y, i) => a + (y - (intercept + slope * xs[i]!)) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot

  return {
    metric: outcome.metric,
    n: xs.length,
    pearson: p,
    spearman: s,
    rewardModel: { intercept, slope, r2 },
  }
}

function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  return pearson(rank(a), rank(b))
}

function rank(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }))
  indexed.sort((x, y) => x.v - y.v)
  const ranks = new Array(arr.length).fill(0)
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++
    const avg = (i + j + 2) / 2
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avg
    i = j + 1
  }
  return ranks
}

// ── Release confidence scorecard ───────────────────────────────────

function buildReleaseScorecard(
  composite: ScalarDistribution,
  lift: LiftInsight | undefined,
  contamination: InsightReport['contamination'],
): InsightReport['release'] {
  // Synthesise a minimal scorecard from the rolled-up signal. The
  // substrate's `evaluateReleaseConfidence` primitive consumes a richer
  // input shape that callers can produce by wiring SLO definitions; the
  // shape here is the contract `selfImprove`/`analyzeRuns` consumers
  // receive automatically. They can call `evaluateReleaseConfidence`
  // directly when they want SLO-based axis evaluation.
  const axes: InsightReport['release']['axes'] = []
  const liftPass =
    lift === undefined || lift.ci95[0] > 0
      ? ('pass' as const)
      : lift.delta > 0
        ? ('warn' as const)
        : ('fail' as const)
  axes.push({
    name: 'quality-lift',
    status: liftPass,
    detail: lift
      ? `delta=${lift.delta.toFixed(3)}, CI95=[${lift.ci95[0].toFixed(3)}, ${lift.ci95[1].toFixed(3)}], n=${lift.n}`
      : 'no baseline/candidate pair available',
  })
  const contamPass =
    contamination === undefined || contamination.leaks === 0 ? ('pass' as const) : ('fail' as const)
  axes.push({
    name: 'contamination',
    status: contamPass,
    detail: contamination ? `${contamination.leaks} canary leak(s)` : 'no canaries supplied',
  })
  axes.push({
    name: 'composite-distribution',
    status: composite.mean >= 0.5 ? 'pass' : composite.mean >= 0.3 ? 'warn' : 'fail',
    detail: `mean=${composite.mean.toFixed(3)}, p50=${composite.p50.toFixed(3)}, p95=${composite.p95.toFixed(3)} over n=${composite.n}`,
  })
  const status = axes.some((a) => a.status === 'fail')
    ? 'fail'
    : axes.some((a) => a.status === 'warn')
      ? 'warn'
      : 'pass'
  return {
    status,
    axes,
    issues: [],
  }
}

// ── Recommendations engine ─────────────────────────────────────────

interface RecommendationContext {
  composite: ScalarDistribution
  judges: Record<string, JudgeInsight>
  interRater?: InterRaterInsight
  lift?: LiftInsight
  failureClusters?: FailureClusterInsight
  contamination?: InsightReport['contamination']
  outcomeCorrelation?: OutcomeCorrelationInsight
  threshold: number
}

function buildRecommendations(ctx: RecommendationContext): Recommendation[] {
  const out: Recommendation[] = []

  if (ctx.lift) {
    const decisive = ctx.lift.ci95[0] > ctx.threshold
    const inconclusive = ctx.lift.ci95[0] <= ctx.threshold && ctx.lift.ci95[1] > ctx.threshold
    if (decisive) {
      out.push({
        priority: 'critical',
        kind: 'ship',
        title: `Ship — lift ${ctx.lift.delta.toFixed(3)} (95% CI ${ctx.lift.ci95[0].toFixed(3)}..${ctx.lift.ci95[1].toFixed(3)})`,
        detail: `Holdout lift exceeds threshold ${ctx.threshold} with 95% bootstrap confidence (n=${ctx.lift.n}, p=${ctx.lift.pValue.toFixed(4)}, d=${ctx.lift.cohensD.toFixed(2)}).`,
        evidencePath: 'lift',
      })
    } else if (inconclusive) {
      out.push({
        priority: 'high',
        kind: 'expand-corpus',
        title: `Inconclusive — need ~${ctx.lift.requiredN} paired runs (have ${ctx.lift.n}) at current effect size`,
        detail: `CI straddles threshold. Current MDE at 80% power is ${ctx.lift.mde.toFixed(3)}; observed delta is ${ctx.lift.delta.toFixed(3)}.`,
        evidencePath: 'lift',
      })
    } else {
      out.push({
        priority: 'critical',
        kind: 'hold',
        title: `Hold — lift CI lower bound ${ctx.lift.ci95[0].toFixed(3)} is at or below threshold ${ctx.threshold}`,
        detail: `Bootstrap CI provides no statistical evidence the candidate is better. Consider tightening the mutation or expanding the holdout.`,
        evidencePath: 'lift',
      })
    }
  }

  if (ctx.contamination && ctx.contamination.leaks > 0) {
    out.push({
      priority: 'critical',
      kind: 'fix',
      title: `${ctx.contamination.leaks} canary leak${ctx.contamination.leaks === 1 ? '' : 's'} detected`,
      detail: `Holdout integrity is compromised. The lift number is unreliable until you investigate.`,
      evidencePath: 'contamination',
    })
  }

  if (ctx.interRater && ctx.interRater.kappa < 0.5) {
    out.push({
      priority: 'high',
      kind: 'recalibrate',
      title: `Inter-rater agreement κ=${ctx.interRater.kappa.toFixed(2)} is below 0.5`,
      detail: `Raters disagree on what 'good' looks like. Top disagreement cases listed in interRater.disagreementCases — consider a triage meeting or refining the rubric.`,
      evidencePath: 'interRater',
    })
  }

  if (ctx.failureClusters && ctx.failureClusters.clusters.length > 0) {
    const top = ctx.failureClusters.clusters[0]!
    out.push({
      priority: 'high',
      kind: 'investigate',
      title: `Top failure cluster: ${top.name} (${(top.share * 100).toFixed(0)}% of failures)`,
      detail: `${ctx.failureClusters.totalFailures} runs failed. The largest cluster groups ${top.exemplars.length} exemplars under '${top.name}'.`,
      evidencePath: 'failureClusters.clusters[0]',
    })
  }

  if (ctx.outcomeCorrelation && Math.abs(ctx.outcomeCorrelation.spearman) < 0.3) {
    out.push({
      priority: 'medium',
      kind: 'recalibrate',
      title: `Judge scores decoupled from ${ctx.outcomeCorrelation.metric} (Spearman ρ=${ctx.outcomeCorrelation.spearman.toFixed(2)})`,
      detail: `Your judges score what they were trained to score, but it isn't predicting downstream ${ctx.outcomeCorrelation.metric}. Consider retraining the judge against ${ctx.outcomeCorrelation.metric} as the gold signal.`,
      evidencePath: 'outcomeCorrelation',
    })
  }

  return out
}

// ── Re-export pareto figure spec for hosted-side rendering ─────────

export type { ParetoFigureSpec }
