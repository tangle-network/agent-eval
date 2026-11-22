/**
 * The numbers behind a profile-matrix decision page, computed once from the
 * matrix's RunRecords so the page and any caller read the same analysis.
 *
 * Every comparative number (quality, cost, latency, the frontier, paired
 * differences, factor effects and error overlap) is measured on the shared
 * cases: the cases every compared profile scored. A case a profile failed has
 * no score, so it leaves the shared set instead of counting as wrong, and the
 * failure shows as that profile's failure rate. Cases drawn from one source (a
 * docket, a repository, a user) are not independent, so intervals resample
 * whole clusters when the caller names them.
 */

import { ValidationError } from '../../errors'
import { clusteredPower } from '../../experiment/power'
import { brierScore, type CalibrationBin, calibrationFromPairs } from '../../meta-eval/calibration'
import { paretoFrontier } from '../../pareto'
import { type RunRecord, runTaskScore } from '../../run-record'
import {
  clusteredPairedContrast,
  clusterJackknife,
  mcnemarRequiredN,
  percentileNearestRank,
  requiredPairedSampleSize,
  wilson,
} from '../../statistics'
import { mean } from '../../statistics/mean'
import type { ProfileMatrixRaceResult } from './race-profile-matrix'

/** A cost drawn against quality. `seconds` is the latency axis. */
export type ProfileMatrixCostAxis = 'usd' | 'tokens' | 'seconds'

export const PROFILE_MATRIX_COST_AXES: readonly ProfileMatrixCostAxis[] = [
  'usd',
  'tokens',
  'seconds',
]

export interface ProfileMatrixReportOptions {
  /** A `runProfileMatrix` or `raceProfileMatrix` result, or the RunRecords alone. */
  source: { readonly records: readonly RunRecord[] } | readonly RunRecord[]
  /** Profile id (`candidateId`) every paired difference is measured against. */
  baseline: string
  /** Profiles to compare, in display order. Default: every profile in the records, baseline first. */
  profiles?: readonly string[]
  /** Independent unit per case id. Every shared case needs one; default one unit per case. */
  clusters?: Readonly<Record<string, string>>
  /** Slice per case id for the slice heatmap. */
  slices?: Readonly<Record<string, string>>
  /** Factor levels per profile id, such as model, harness, effort or instructions. */
  factors?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Costs to draw against quality. Default all three; an axis without measurements is reported, not drawn. */
  costAxes?: readonly ProfileMatrixCostAxis[]
  /** A case counts as correct at or above this score. Default 0.5, which pass/fail scores do not notice. */
  passScore?: number
  /** The profile's own forecast, in [0, 1], that its answer is correct, when it returned one. */
  probabilityOf?: (record: RunRecord) => number | undefined
  /** A race over these profiles: the page prints its elimination log and its selection-bias note. */
  race?: ProfileMatrixRaceResult
  /** Interval level. Default 0.95. */
  level?: number
  title?: string
}

export interface ProfileMatrixInterval {
  estimate: number
  /** Null when the interval is undefined, as with fewer than two clusters. */
  low: number | null
  high: number | null
}

export interface ProfileMatrixPairedDifference extends ProfileMatrixInterval {
  n: number
  /** Cluster sign-flip p-value for a zero difference. */
  pValue: number | null
  /** Share of shared cases where exactly one of the two profiles was correct. */
  discordance: number
  /** Paired cases a two-sided test needs for 80% power at the observed difference; null at a zero difference. Ignores clustering. */
  casesToResolve: number | null
}

export interface ProfileMatrixProfileStats {
  profileId: string
  factors: Readonly<Record<string, string>>
  casesAttempted: number
  casesScored: number
  /** Share of this profile's records without a score: a dispatch or judge failure. */
  failureRate: number
  /** Mean score on the shared cases. */
  quality: ProfileMatrixInterval | null
  /** Paired difference from the baseline on the shared cases; absent on the baseline. */
  vsBaseline?: ProfileMatrixPairedDifference
  /** Mean per shared case; null when a record in it did not measure that cost. */
  costPerCase: Record<ProfileMatrixCostAxis, number | null>
  /** Shared-case total divided by the shared cases answered correctly; null with none correct. */
  costPerCorrect: Record<ProfileMatrixCostAxis, number | null>
  /** Seconds per shared case. */
  latency: { p50: number; p90: number } | null
}

export interface ProfileMatrixAxisSummary {
  axis: ProfileMatrixCostAxis
  drawn: boolean
  /** What the axis measures, or why it is not drawn. */
  note: string
  /** Profiles on the quality-versus-this-axis Pareto set, cheapest first. */
  frontier: string[]
}

export interface ProfileMatrixFactorEffect {
  factor: string
  level: string
  /** The baseline's level of this factor, or its most common level. */
  reference: string
  /** Profile pairs that differ only in this factor; zero means the effect is confounded. */
  matchedPairs: number
  n: number
  effect: ProfileMatrixInterval | null
  pValue: number | null
}

export interface ProfileMatrixSliceCell {
  profileId: string
  slice: string
  /** This profile's scored cases in the slice. */
  n: number
  quality: number | null
}

export interface ProfileMatrixErrorOverlap {
  a: string
  b: string
  /** Share of shared cases both got wrong. */
  bothWrong: number
  /** Share of shared cases exactly one got right. */
  disagree: number
}

export interface ProfileMatrixCaseDifficulty {
  caseId: string
  slice?: string
  /** Profiles that got the case right. */
  solved: number
  /** Profiles that scored the case. */
  scored: number
  share: number
}

export interface ProfileMatrixCalibration {
  profileId: string
  n: number
  ece: number
  brier: number
  bins: CalibrationBin[]
}

export interface ProfileMatrixPower {
  n: number
  clusters: number
  /** Median share of shared cases on which a profile and the baseline disagree on correctness. */
  discordance: number
  /** Smallest paired difference detected with 80% power; null when not even a difference of 1 is. */
  detectable: number | null
  /** False when this many clusters cannot reach the level by an exact sign-flip test at any effect. */
  certifiable: boolean
  minClusters: number
}

export interface ProfileMatrixAnalysis {
  title: string
  baseline: string
  level: number
  passScore: number
  /** True when every per-case score is 0 or 1. */
  passFail: boolean
  sharedCases: string[]
  sharedClusters: number
  axes: ProfileMatrixAxisSummary[]
  profiles: ProfileMatrixProfileStats[]
  factorEffects: ProfileMatrixFactorEffect[]
  /** Slice names, the slice with the most attempted cases first. */
  slices: string[]
  sliceCells: ProfileMatrixSliceCell[]
  errorOverlap: ProfileMatrixErrorOverlap[]
  /** Share of shared cases at least one profile got right. */
  oracle: number | null
  difficulty: ProfileMatrixCaseDifficulty[]
  calibration: ProfileMatrixCalibration[]
  power: ProfileMatrixPower | null
}

const TARGET_POWER = 0.8
const UNLABELLED_SLICE = 'unlabelled'

/** One profile's records on one case, reps averaged. */
interface CaseView {
  score: number | undefined
  usd: number | null
  tokens: number | null
  seconds: number
}

interface Context {
  options: ProfileMatrixReportOptions
  level: number
  passScore: number
  profileIds: string[]
  views: Map<string, Map<string, CaseView>>
  recordsByProfile: Map<string, RunRecord[]>
  shared: string[]
  passFail: boolean
  clusterOf: (caseId: string) => string
}

/**
 * Compare profile-matrix cells against one baseline: quality with clustered
 * intervals, paired differences, the cost and latency frontiers, factor main
 * effects, slices, error overlap, item difficulty, calibration and power.
 */
export function analyzeProfileMatrix(options: ProfileMatrixReportOptions): ProfileMatrixAnalysis {
  const ctx = buildContext(options)
  const profiles = ctx.profileIds.map((profileId) => profileStats(ctx, profileId))
  const baseline = profiles[0]!
  for (const stats of profiles.slice(1)) stats.vsBaseline = pairedDifference(ctx, stats, baseline)
  const slices = sliceNames(ctx)
  return {
    title: options.title ?? 'Profile matrix',
    baseline: options.baseline,
    level: ctx.level,
    passScore: ctx.passScore,
    passFail: ctx.passFail,
    sharedCases: ctx.shared,
    sharedClusters: new Set(ctx.shared.map((caseId) => ctx.clusterOf(caseId))).size,
    axes: axisSummaries(ctx, profiles),
    profiles,
    factorEffects: factorEffects(ctx),
    slices,
    sliceCells: sliceCells(ctx, slices),
    ...errorOverlap(ctx),
    difficulty: difficulty(ctx),
    calibration: calibration(ctx),
    power: power(ctx, profiles),
  }
}

function buildContext(options: ProfileMatrixReportOptions): Context {
  const level = options.level ?? 0.95
  if (!(level > 0 && level < 1))
    throw new ValidationError('profile matrix: level must be in (0, 1)')
  const passScore = options.passScore ?? 0.5
  if (!Number.isFinite(passScore))
    throw new ValidationError('profile matrix: passScore must be finite')
  const records = 'records' in options.source ? options.source.records : options.source
  const recordsByProfile = new Map<string, RunRecord[]>()
  for (const record of records) {
    const list = recordsByProfile.get(record.candidateId) ?? []
    list.push(record)
    recordsByProfile.set(record.candidateId, list)
  }
  const listed = options.profiles ? [...options.profiles] : [...recordsByProfile.keys()]
  if (new Set(listed).size !== listed.length) {
    throw new ValidationError('profile matrix: profiles must be distinct')
  }
  const profileIds = [options.baseline, ...listed.filter((id) => id !== options.baseline)]
  for (const profileId of profileIds) {
    if (!recordsByProfile.has(profileId)) {
      throw new ValidationError(`profile matrix: profile '${profileId}' has no records`)
    }
  }
  const views = new Map<string, Map<string, CaseView>>()
  for (const profileId of profileIds)
    views.set(profileId, caseViews(recordsByProfile.get(profileId)!))
  const scoredBy = (profileId: string, caseId: string) =>
    views.get(profileId)!.get(caseId)?.score !== undefined
  const shared = [...views.get(options.baseline)!.keys()]
    .filter((caseId) => profileIds.every((profileId) => scoredBy(profileId, caseId)))
    .sort()
  const scores = [...views.values()].flatMap((cases) =>
    [...cases.values()].map((view) => view.score).filter((score) => score !== undefined),
  )
  const ctx: Context = {
    options,
    level,
    passScore,
    profileIds,
    views,
    recordsByProfile,
    shared,
    passFail: scores.every((score) => score === 0 || score === 1),
    clusterOf: clusterResolver(options.clusters, 'profile matrix'),
  }
  for (const caseId of shared) ctx.clusterOf(caseId)
  return ctx
}

function caseViews(records: readonly RunRecord[]): Map<string, CaseView> {
  const grouped = new Map<string, RunRecord[]>()
  for (const record of records) {
    const list = grouped.get(record.scenarioId) ?? []
    list.push(record)
    grouped.set(record.scenarioId, list)
  }
  const views = new Map<string, CaseView>()
  for (const [caseId, reps] of grouped) {
    const scores = reps.map(runTaskScore).filter((score) => score !== undefined)
    views.set(caseId, {
      score: scores.length > 0 ? mean(scores) : undefined,
      usd: reps.every((r) => r.costUsd !== null) ? mean(reps.map((r) => r.costUsd!)) : null,
      tokens: reps.every((r) => r.tokenUsage.tokensKnown !== false)
        ? mean(reps.map(tokenTotal))
        : null,
      seconds: mean(reps.map(latencySeconds)),
    })
  }
  return views
}

/** Every prompt token (fresh, cached and cache-write) plus output; reasoning is counted inside output. */
function tokenTotal(record: RunRecord): number {
  const usage = record.tokenUsage
  return usage.input + (usage.cached ?? 0) + (usage.cacheWrite ?? 0) + usage.output
}

/** Dispatch time when the cell recorded it, so judging does not count as latency; else the wall clock. */
function latencySeconds(record: RunRecord): number {
  const dispatchMs = record.outcome.raw.dispatch_ms
  return (Number.isFinite(dispatchMs) ? dispatchMs! : record.wallMs) / 1000
}

/**
 * Each case's independent unit, one per case when no clusters are given. A case missing from
 * a given cluster map is refused rather than counted as its own unit. Shared with the race.
 */
export function clusterResolver(
  clusters: Readonly<Record<string, string>> | undefined,
  owner: string,
): (caseId: string) => string {
  return (caseId) => {
    if (!clusters) return caseId
    const cluster = clusters[caseId]
    if (typeof cluster !== 'string' || cluster.length === 0) {
      throw new ValidationError(`${owner}: case '${caseId}' has no cluster`)
    }
    return cluster
  }
}

function scoreOf(ctx: Context, profileId: string, caseId: string): number {
  return ctx.views.get(profileId)!.get(caseId)!.score!
}

function correct(ctx: Context, profileId: string, caseId: string): boolean {
  return scoreOf(ctx, profileId, caseId) >= ctx.passScore
}

function profileStats(ctx: Context, profileId: string): ProfileMatrixProfileStats {
  const views = ctx.views.get(profileId)!
  const records = ctx.recordsByProfile.get(profileId)!
  const sharedViews = ctx.shared.map((caseId) => views.get(caseId)!)
  const correctCount = ctx.shared.filter((caseId) => correct(ctx, profileId, caseId)).length
  const costPerCase = {} as Record<ProfileMatrixCostAxis, number | null>
  const costPerCorrect = {} as Record<ProfileMatrixCostAxis, number | null>
  for (const axis of PROFILE_MATRIX_COST_AXES) {
    const values = sharedViews.map((view) => view[axis])
    const known = values.length > 0 && values.every((value) => value !== null)
    costPerCase[axis] = known ? mean(values as number[]) : null
    costPerCorrect[axis] =
      known && correctCount > 0
        ? (values as number[]).reduce((a, b) => a + b, 0) / correctCount
        : null
  }
  const seconds = sharedViews.map((view) => view.seconds)
  return {
    profileId,
    factors: ctx.options.factors?.[profileId] ?? {},
    casesAttempted: views.size,
    casesScored: [...views.values()].filter((view) => view.score !== undefined).length,
    failureRate: records.filter((r) => runTaskScore(r) === undefined).length / records.length,
    quality: quality(ctx, profileId),
    costPerCase,
    costPerCorrect,
    latency:
      seconds.length > 0
        ? { p50: percentileNearestRank(seconds, 50), p90: percentileNearestRank(seconds, 90) }
        : null,
  }
}

function quality(ctx: Context, profileId: string): ProfileMatrixInterval | null {
  const items = ctx.shared.map((caseId) => ({ caseId, score: scoreOf(ctx, profileId, caseId) }))
  if (items.length === 0) return null
  const estimate = mean(items.map((item) => item.score))
  if (ctx.passFail && !ctx.options.clusters) {
    const successes = items.filter((item) => item.score === 1).length
    const interval = wilson(successes, items.length, ctx.level)
    return { estimate, low: interval.lower, high: interval.upper }
  }
  const interval = clusterJackknife(
    items,
    (item) => ctx.clusterOf(item.caseId),
    (sample) => mean(sample.map((item) => item.score)),
    { level: ctx.level },
  )
  return { estimate, low: interval.low, high: interval.high }
}

/**
 * Mean of per-case differences with its cluster-jackknife interval and exact sign-flip p.
 * The page's paired numbers and the race's eliminations both come from here.
 */
export function clusteredDifference(
  deltas: readonly { caseId: string; delta: number }[],
  clusterOf: (caseId: string) => string,
  level: number,
): ProfileMatrixInterval & { pValue: number | null } {
  const result = clusteredPairedContrast(
    deltas.map(({ caseId, delta }) => ({ cluster: clusterOf(caseId), delta })),
    { level, seed: 1 },
  )
  return {
    estimate: mean(deltas.map((d) => d.delta)),
    low: result.low,
    high: result.high,
    pValue: result.pValue,
  }
}

function pairedDifference(
  ctx: Context,
  stats: ProfileMatrixProfileStats,
  baseline: ProfileMatrixProfileStats,
): ProfileMatrixPairedDifference | undefined {
  const n = ctx.shared.length
  if (n === 0) return undefined
  const deltas = ctx.shared.map((caseId) => ({
    caseId,
    delta: scoreOf(ctx, stats.profileId, caseId) - scoreOf(ctx, baseline.profileId, caseId),
  }))
  const wins = ctx.shared.filter(
    (c) => correct(ctx, stats.profileId, c) && !correct(ctx, baseline.profileId, c),
  ).length
  const losses = ctx.shared.filter(
    (c) => !correct(ctx, stats.profileId, c) && correct(ctx, baseline.profileId, c),
  ).length
  return {
    ...clusteredDifference(deltas, ctx.clusterOf, ctx.level),
    n,
    discordance: (wins + losses) / n,
    casesToResolve: casesToResolve(
      ctx,
      deltas.map((d) => d.delta),
      wins / n,
      losses / n,
    ),
  }
}

function casesToResolve(ctx: Context, deltas: number[], p10: number, p01: number): number | null {
  const alpha = 1 - ctx.level
  if (ctx.passFail) {
    const needed = mcnemarRequiredN({ p10, p01, alpha, power: TARGET_POWER })
    return Number.isFinite(needed) ? needed : null
  }
  if (deltas.length < 2) return null
  const average = mean(deltas)
  const sd = Math.sqrt(deltas.reduce((sum, d) => sum + (d - average) ** 2, 0) / (deltas.length - 1))
  if (sd === 0 || average === 0) return null
  const needed = requiredPairedSampleSize({
    effect: Math.abs(average) / sd,
    alpha,
    power: TARGET_POWER,
  })
  return Number.isFinite(needed) ? needed : null
}

function axisSummaries(
  ctx: Context,
  profiles: readonly ProfileMatrixProfileStats[],
): ProfileMatrixAxisSummary[] {
  const requested = ctx.options.costAxes ?? PROFILE_MATRIX_COST_AXES
  return requested.map((axis) => {
    const x = (stats: ProfileMatrixProfileStats) =>
      axis === 'seconds' ? (stats.latency?.p50 ?? null) : stats.costPerCase[axis]
    const unmeasured = profiles.filter((stats) => x(stats) === null).map((s) => s.profileId)
    const reason =
      ctx.shared.length === 0
        ? 'no case was scored by every profile'
        : unmeasured.length > 0
          ? `${unmeasured.length} of ${profiles.length} profiles did not measure it on every shared case`
          : axis === 'usd' && profiles.every((stats) => x(stats) === 0)
            ? 'every profile costs $0 at the margin, as on flat-rate seats'
            : null
    if (reason !== null) return { axis, drawn: false, note: reason, frontier: [] }
    const { frontier } = paretoFrontier(
      [...profiles],
      [
        { name: 'quality', direction: 'maximize', value: (stats) => stats.quality!.estimate },
        { name: axis, direction: 'minimize', value: (stats) => x(stats)! },
      ],
    )
    return {
      axis,
      drawn: true,
      note: AXIS_NOTES[axis],
      frontier: frontier.sort((a, b) => x(a)! - x(b)!).map((stats) => stats.profileId),
    }
  })
}

const AXIS_NOTES: Record<ProfileMatrixCostAxis, string> = {
  usd: 'mean dollars per shared case',
  tokens:
    'mean tokens per shared case: every prompt token, cached included, plus output with reasoning counted once',
  seconds:
    'median seconds per shared case: dispatch time, or the cell wall clock where dispatch time was not recorded',
}

function factorEffects(ctx: Context): ProfileMatrixFactorEffect[] {
  const factors = ctx.options.factors
  if (!factors) return []
  const levelOf = (profileId: string, factor: string) => factors[profileId]?.[factor]
  const names = [...new Set(ctx.profileIds.flatMap((id) => Object.keys(factors[id] ?? {})))].sort()
  const effects: ProfileMatrixFactorEffect[] = []
  for (const factor of names) {
    const defined = ctx.profileIds.filter((id) => levelOf(id, factor) !== undefined)
    const counts = new Map<string, number>()
    for (const id of defined)
      counts.set(levelOf(id, factor)!, (counts.get(levelOf(id, factor)!) ?? 0) + 1)
    const reference =
      levelOf(ctx.options.baseline, factor) ??
      [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]
    for (const level of [...counts.keys()].filter((l) => l !== reference).sort()) {
      const matched = defined.flatMap((p) =>
        levelOf(p, factor) !== level
          ? []
          : defined
              .filter(
                (q) => levelOf(q, factor) === reference && differOnlyIn(factors, p, q, factor),
              )
              .map((q) => [p, q] as const),
      )
      const base = { factor, level, reference, matchedPairs: matched.length, n: ctx.shared.length }
      if (matched.length === 0 || ctx.shared.length === 0) {
        effects.push({ ...base, effect: null, pValue: null })
        continue
      }
      const deltas = ctx.shared.map((caseId) => ({
        caseId,
        delta: mean(matched.map(([p, q]) => scoreOf(ctx, p, caseId) - scoreOf(ctx, q, caseId))),
      }))
      const { pValue, ...effect } = clusteredDifference(deltas, ctx.clusterOf, ctx.level)
      effects.push({ ...base, effect, pValue })
    }
  }
  return effects
}

function differOnlyIn(
  factors: Readonly<Record<string, Readonly<Record<string, string>>>>,
  p: string,
  q: string,
  factor: string,
): boolean {
  const keys = new Set([...Object.keys(factors[p] ?? {}), ...Object.keys(factors[q] ?? {})])
  return [...keys].every((key) => key === factor || factors[p]?.[key] === factors[q]?.[key])
}

function sliceOf(ctx: Context, caseId: string): string | undefined {
  const slices = ctx.options.slices
  return slices ? (slices[caseId] ?? UNLABELLED_SLICE) : undefined
}

/** Slices with the most attempted cases first, so the columns that carry evidence lead. */
function sliceNames(ctx: Context): string[] {
  if (!ctx.options.slices) return []
  const caseIds = new Set([...ctx.views.values()].flatMap((cases) => [...cases.keys()]))
  const counts = new Map<string, number>()
  for (const caseId of caseIds) {
    const slice = sliceOf(ctx, caseId)!
    counts.set(slice, (counts.get(slice) ?? 0) + 1)
  }
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([slice]) => slice)
}

function sliceCells(ctx: Context, slices: readonly string[]): ProfileMatrixSliceCell[] {
  return ctx.profileIds.flatMap((profileId) =>
    slices.map((slice) => {
      const scores = [...ctx.views.get(profileId)!]
        .filter(([caseId, view]) => view.score !== undefined && sliceOf(ctx, caseId) === slice)
        .map(([, view]) => view.score!)
      return { profileId, slice, n: scores.length, quality: scores.length ? mean(scores) : null }
    }),
  )
}

function errorOverlap(ctx: Context): Pick<ProfileMatrixAnalysis, 'errorOverlap' | 'oracle'> {
  const n = ctx.shared.length
  const pairs: ProfileMatrixErrorOverlap[] = []
  ctx.profileIds.forEach((a, index) => {
    for (const b of ctx.profileIds.slice(index + 1)) {
      const right = ctx.shared.map((c) => [correct(ctx, a, c), correct(ctx, b, c)] as const)
      pairs.push({
        a,
        b,
        bothWrong: n ? right.filter(([x, y]) => !x && !y).length / n : 0,
        disagree: n ? right.filter(([x, y]) => x !== y).length / n : 0,
      })
    }
  })
  const solved = ctx.shared.filter((c) => ctx.profileIds.some((p) => correct(ctx, p, c))).length
  return { errorOverlap: pairs, oracle: n ? solved / n : null }
}

function difficulty(ctx: Context): ProfileMatrixCaseDifficulty[] {
  const caseIds = [...new Set([...ctx.views.values()].flatMap((cases) => [...cases.keys()]))]
  return caseIds
    .map((caseId) => {
      const scored = ctx.profileIds.filter(
        (p) => ctx.views.get(p)!.get(caseId)?.score !== undefined,
      )
      const solved = scored.filter((p) => correct(ctx, p, caseId)).length
      const slice = sliceOf(ctx, caseId)
      return {
        caseId,
        ...(slice === undefined ? {} : { slice }),
        solved,
        scored: scored.length,
        share: scored.length ? solved / scored.length : 0,
      }
    })
    .filter((item) => item.scored > 0)
    .sort((a, b) => a.share - b.share || a.caseId.localeCompare(b.caseId))
}

function calibration(ctx: Context): ProfileMatrixCalibration[] {
  const probabilityOf = ctx.options.probabilityOf
  if (!probabilityOf) return []
  return ctx.profileIds.flatMap((profileId) => {
    const pairs = ctx.recordsByProfile.get(profileId)!.flatMap((record) => {
      const score = runTaskScore(record)
      const probability = probabilityOf(record)
      if (score === undefined || probability === undefined) return []
      if (!(probability >= 0 && probability <= 1)) {
        throw new ValidationError(
          `profile matrix: profile '${profileId}' returned probability ${probability} outside [0, 1]`,
        )
      }
      return [{ evalScore: probability, outcome: score >= ctx.passScore ? 1 : 0 }]
    })
    const report = calibrationFromPairs(pairs, 'probability', 'correct', {
      bins: 10,
      range: { lo: 0, hi: 1 },
    })
    if (report === null) return []
    return [
      { profileId, n: report.n, ece: report.ece, brier: brierScore(pairs), bins: report.bins },
    ]
  })
}

function power(
  ctx: Context,
  profiles: readonly ProfileMatrixProfileStats[],
): ProfileMatrixPower | null {
  const discordances = profiles
    .map((stats) => stats.vsBaseline?.discordance)
    .filter((value) => value !== undefined)
    .sort((a, b) => a - b)
  if (ctx.shared.length < 2 || discordances.length === 0) return null
  const discordance = discordances[Math.floor((discordances.length - 1) / 2)]!
  const sizes = new Map<string, number>()
  for (const caseId of ctx.shared) {
    const cluster = ctx.clusterOf(caseId)
    sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1)
  }
  const clusterSizes = [...sizes.values()]
  // The observed discordance is the noise floor: half of it wins and half of
  // it loses under no effect, and an effect adds wins on top of it.
  const powerAt = (effect: number) =>
    clusteredPower({
      clusterSizes,
      effects: [effect],
      minimumEffect: effect,
      seed: 1,
      trials: 400,
      resamples: 800,
      confidence: ctx.level,
      alpha: 1 - ctx.level,
      targetPower: TARGET_POWER,
      baseWinRate: discordance / 2,
      baseLossRate: discordance / 2,
    })
  const largest = powerAt(1)
  let detectable: number | null = null
  if (largest.powerAtMinimumEffect >= TARGET_POWER) {
    let [low, high] = [0, 1]
    for (let step = 0; step < 7; step++) {
      const middle = (low + high) / 2
      if (powerAt(middle).powerAtMinimumEffect >= TARGET_POWER) high = middle
      else low = middle
    }
    detectable = high
  }
  return {
    n: ctx.shared.length,
    clusters: clusterSizes.length,
    discordance,
    detectable,
    certifiable: largest.signFlipFloor.certifiableAtAlpha,
    minClusters: largest.signFlipFloor.minClustersForAlpha,
  }
}
