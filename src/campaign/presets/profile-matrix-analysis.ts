/**
 * The numbers behind a profile-matrix decision page, computed once from the
 * matrix's RunRecords so the page and any caller read the same analysis.
 *
 * Cells often run on different numbers of cases, so the analysis keeps two
 * case sets apart. Every paired difference (from the baseline, inside a factor
 * effect, in a race) is measured on the cases both profiles scored, so each
 * comparison uses all the evidence it has and carries its own n. The panels
 * that need one case set for every profile (the frontiers, error overlap, item
 * difficulty, slices and power) use the common set of the panel profiles: the
 * profiles that scored at least `minCoverage` of the baseline's scored cases. A
 * profile under that line is reported in its own partial-coverage rows instead
 * of shrinking the common set for everyone.
 *
 * A case a profile failed has no score, so it leaves that profile's cases
 * instead of counting as wrong, and the failure shows as its failure rate.
 * Cases drawn from one source (a docket, a repository, a user) are not
 * independent, so intervals resample whole clusters when the caller names them.
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
  /**
   * Share of the baseline's scored cases a profile must also have scored to join the
   * common-set panels, in (0, 1]. Default 0.9. When the source is a race result, its
   * survivors form the panel instead.
   */
  minCoverage?: number
  /** Independent unit per case id. Every scored case needs one; default one unit per case. */
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

/** One profile against another on the cases both scored. */
export interface ProfileMatrixPairedDifference extends ProfileMatrixInterval {
  /** Cases both profiles scored. */
  n: number
  /** Independent clusters among those cases. */
  clusters: number
  /** Exact cluster sign-flip p-value for a zero difference. */
  pValue: number | null
  /** Share of the paired cases where exactly one of the two profiles was correct. */
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
  /** Share of the baseline's scored cases this profile also scored. */
  coverage: number
  /** In the common-set panels: the frontiers, error overlap, difficulty, slices and power. */
  panel: boolean
  /** Cases this profile and the baseline both scored, the n of `vsBaseline`; on the baseline, its own scored cases. */
  pairedN: number
  /** The race batch whose standings dropped this profile. */
  droppedAtBatch?: number
  /** Mean score on this profile's own scored cases. */
  ownQuality: ProfileMatrixInterval | null
  /** Mean score on the common set; null outside the panel. */
  quality: ProfileMatrixInterval | null
  /** Paired difference from the baseline on the cases both scored; absent on the baseline. */
  vsBaseline?: ProfileMatrixPairedDifference
  /** Mean per common case; null outside the panel or when a record in it did not measure that cost. */
  costPerCase: Record<ProfileMatrixCostAxis, number | null>
  /** Common-set total divided by the common cases answered correctly; null outside the panel or with none correct. */
  costPerCorrect: Record<ProfileMatrixCostAxis, number | null>
  /** Seconds per common case; null outside the panel. */
  latency: { p50: number; p90: number } | null
}

export interface ProfileMatrixAxisSummary {
  axis: ProfileMatrixCostAxis
  drawn: boolean
  /** What the axis measures, or why it is not drawn. */
  note: string
  /** Panel profiles on the quality-versus-this-axis Pareto set, cheapest first. */
  frontier: string[]
}

export interface ProfileMatrixFactorEffect {
  factor: string
  level: string
  /** The baseline's level of this factor, or its most common level. */
  reference: string
  /** Profile pairs that differ only in this factor; zero means the effect is confounded. */
  matchedPairs: number
  /** Cases at least one matched pair scored on both sides. */
  n: number
  /** Fewest and most cases one matched pair shares; null without a matched pair. */
  pairCases: { min: number; max: number } | null
  /** Mean over those cases of the matched pairs' mean difference on each case. */
  effect: ProfileMatrixInterval | null
  pValue: number | null
}

export interface ProfileMatrixSliceCell {
  profileId: string
  slice: string
  /** Common cases in the slice. */
  n: number
  quality: number | null
}

export interface ProfileMatrixErrorOverlap {
  a: string
  b: string
  /** Share of common cases both got wrong. */
  bothWrong: number
  /** Share of common cases exactly one got right. */
  disagree: number
}

export interface ProfileMatrixCaseDifficulty {
  caseId: string
  slice?: string
  /** Panel profiles that got the case right. */
  solved: number
  /** Panel profiles that scored the case. */
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
  /** Median share of common cases on which a panel profile and the baseline disagree on correctness. */
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
  minCoverage: number
  /** `coverage`: profiles at `minCoverage` or above; `race-survivors`: the source race's survivors. */
  panelRule: 'coverage' | 'race-survivors'
  /** Profiles in the common-set panels, baseline first. */
  panelProfiles: string[]
  /** Cases every panel profile scored: the set the frontiers, overlap, difficulty, slices and power use. */
  commonCases: string[]
  commonClusters: number
  axes: ProfileMatrixAxisSummary[]
  /** Every profile, baseline first; `panel` marks the panel profiles. */
  profiles: ProfileMatrixProfileStats[]
  factorEffects: ProfileMatrixFactorEffect[]
  /** Slice names, the slice with the most common cases first. */
  slices: string[]
  sliceCells: ProfileMatrixSliceCell[]
  errorOverlap: ProfileMatrixErrorOverlap[]
  /** Share of common cases at least one panel profile got right. */
  oracle: number | null
  difficulty: ProfileMatrixCaseDifficulty[]
  calibration: ProfileMatrixCalibration[]
  power: ProfileMatrixPower | null
}

/** How two profiles are paired: clusters, level, and what counts as correct. */
export interface ProfilePairingRule {
  clusterOf: (caseId: string) => string
  level: number
  passScore: number
  /** Every score is 0 or 1, so the required n follows McNemar. */
  passFail: boolean
}

const TARGET_POWER = 0.8
const UNLABELLED_SLICE = 'unlabelled'

/** One profile's records on one case, reps averaged. */
interface CaseCost {
  usd: number | null
  tokens: number | null
  seconds: number
}

interface Context {
  options: ProfileMatrixReportOptions
  rule: ProfilePairingRule
  minCoverage: number
  race: ProfileMatrixRaceResult | undefined
  panelRule: ProfileMatrixAnalysis['panelRule']
  profileIds: string[]
  panel: string[]
  scores: Map<string, Map<string, number>>
  costs: Map<string, Map<string, CaseCost>>
  recordsByProfile: Map<string, RunRecord[]>
  baselineCases: string[]
  common: string[]
}

/**
 * Compare profile-matrix cells against one baseline: quality with clustered
 * intervals, paired differences, the cost and latency frontiers, factor main
 * effects, slices, error overlap, item difficulty, calibration and power.
 */
export function analyzeProfileMatrix(options: ProfileMatrixReportOptions): ProfileMatrixAnalysis {
  const ctx = buildContext(options)
  const profiles = ctx.profileIds.map((profileId) => profileStats(ctx, profileId))
  const panel = profiles.filter((stats) => stats.panel)
  const slices = sliceNames(ctx)
  return {
    title: options.title ?? 'Profile matrix',
    baseline: options.baseline,
    level: ctx.rule.level,
    passScore: ctx.rule.passScore,
    passFail: ctx.rule.passFail,
    minCoverage: ctx.minCoverage,
    panelRule: ctx.panelRule,
    panelProfiles: ctx.panel,
    commonCases: ctx.common,
    commonClusters: new Set(ctx.common.map((caseId) => ctx.rule.clusterOf(caseId))).size,
    axes: axisSummaries(ctx, panel),
    profiles,
    factorEffects: factorEffects(ctx),
    slices,
    sliceCells: sliceCells(ctx, slices),
    ...errorOverlap(ctx),
    difficulty: difficulty(ctx),
    calibration: calibration(ctx),
    power: power(ctx, panel),
  }
}

/** Mean score per profile and case over its scored reps; a case without a scored rep is absent. */
export function scoresByProfile(records: readonly RunRecord[]): Map<string, Map<string, number>> {
  const scored = new Map<string, Map<string, number[]>>()
  for (const record of records) {
    const score = runTaskScore(record)
    if (score === undefined) continue
    const cases = scored.get(record.candidateId) ?? new Map<string, number[]>()
    cases.set(record.scenarioId, [...(cases.get(record.scenarioId) ?? []), score])
    scored.set(record.candidateId, cases)
  }
  return new Map(
    [...scored].map(([id, cases]) => [id, new Map([...cases].map(([c, xs]) => [c, mean(xs)]))]),
  )
}

/**
 * Profile `a` against profile `b` on the cases both scored, restricted to `cases` when
 * given. Every paired number on the page and in the race comes from here.
 */
export function pairProfiles(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
  rule: ProfilePairingRule,
  cases?: readonly string[],
): ProfileMatrixPairedDifference | undefined {
  const both = (cases ?? [...a.keys()]).filter((c) => a.has(c) && b.has(c)).sort()
  if (both.length === 0) return undefined
  const deltas = both.map((caseId) => ({ caseId, delta: a.get(caseId)! - b.get(caseId)! }))
  const right = (score: number) => score >= rule.passScore
  const wins = both.filter((c) => right(a.get(c)!) && !right(b.get(c)!)).length
  const losses = both.filter((c) => !right(a.get(c)!) && right(b.get(c)!)).length
  return {
    ...clusteredDifference(deltas, rule.clusterOf, rule.level),
    discordance: (wins + losses) / both.length,
    casesToResolve: casesToResolve(
      rule,
      deltas.map((d) => d.delta),
      wins / both.length,
      losses / both.length,
    ),
  }
}

/** True when every score is 0 or 1. */
export function allPassFail(scores: ReadonlyMap<string, ReadonlyMap<string, number>>): boolean {
  return [...scores.values()].every((cases) =>
    [...cases.values()].every((score) => score === 0 || score === 1),
  )
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

/** Mean of per-case differences with its cluster-jackknife interval and exact sign-flip p. */
function clusteredDifference(
  deltas: readonly { caseId: string; delta: number }[],
  clusterOf: (caseId: string) => string,
  level: number,
): ProfileMatrixInterval & { n: number; clusters: number; pValue: number | null } {
  const units = deltas.map(({ caseId, delta }) => ({ cluster: clusterOf(caseId), delta }))
  const result = clusteredPairedContrast(units, { level, seed: 1 })
  return {
    estimate: mean(deltas.map((d) => d.delta)),
    low: result.low,
    high: result.high,
    pValue: result.pValue,
    n: deltas.length,
    clusters: new Set(units.map((unit) => unit.cluster)).size,
  }
}

function casesToResolve(
  rule: ProfilePairingRule,
  deltas: number[],
  p10: number,
  p01: number,
): number | null {
  const alpha = 1 - rule.level
  if (rule.passFail) {
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

/** True when the source is a `raceProfileMatrix` result. */
export function isRaceResult(
  source: ProfileMatrixReportOptions['source'],
): source is ProfileMatrixRaceResult {
  return 'survivors' in source && 'log' in source
}

function buildContext(options: ProfileMatrixReportOptions): Context {
  const level = options.level ?? 0.95
  if (!(level > 0 && level < 1))
    throw new ValidationError('profile matrix: level must be in (0, 1)')
  const passScore = options.passScore ?? 0.5
  if (!Number.isFinite(passScore))
    throw new ValidationError('profile matrix: passScore must be finite')
  const minCoverage = options.minCoverage ?? 0.9
  if (!(minCoverage > 0 && minCoverage <= 1))
    throw new ValidationError('profile matrix: minCoverage must be in (0, 1]')
  const raceSource = isRaceResult(options.source) ? options.source : undefined
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
  const baseline = options.baseline
  const profileIds = [baseline, ...listed.filter((id) => id !== baseline)]
  for (const profileId of profileIds) {
    if (!recordsByProfile.has(profileId)) {
      throw new ValidationError(`profile matrix: profile '${profileId}' has no records`)
    }
  }
  const scored = scoresByProfile(records)
  const scores = new Map(profileIds.map((id) => [id, scored.get(id) ?? new Map<string, number>()]))
  const baselineCases = [...scores.get(baseline)!.keys()].sort()
  if (baselineCases.length === 0) {
    throw new ValidationError(`profile matrix: baseline '${baseline}' scored no case`)
  }
  const clusterOf = clusterResolver(options.clusters, 'profile matrix')
  for (const cases of scores.values()) for (const caseId of cases.keys()) clusterOf(caseId)
  const covers = (id: string) => coverageOf(scores, baselineCases, id) >= minCoverage
  const panel = raceSource
    ? profileIds.filter((id) => id === baseline || raceSource.survivors.includes(id))
    : profileIds.filter((id) => id === baseline || covers(id))
  return {
    options,
    rule: { clusterOf, level, passScore, passFail: allPassFail(scores) },
    minCoverage,
    race: options.race ?? raceSource,
    panelRule: raceSource ? 'race-survivors' : 'coverage',
    profileIds,
    panel,
    scores,
    costs: new Map(profileIds.map((id) => [id, caseCosts(recordsByProfile.get(id)!)])),
    recordsByProfile,
    baselineCases,
    common: baselineCases.filter((caseId) => panel.every((id) => scores.get(id)!.has(caseId))),
  }
}

function coverageOf(
  scores: Map<string, Map<string, number>>,
  baselineCases: readonly string[],
  profileId: string,
): number {
  const own = scores.get(profileId)!
  return baselineCases.filter((caseId) => own.has(caseId)).length / baselineCases.length
}

function caseCosts(records: readonly RunRecord[]): Map<string, CaseCost> {
  const grouped = new Map<string, RunRecord[]>()
  for (const record of records) {
    const list = grouped.get(record.scenarioId) ?? []
    list.push(record)
    grouped.set(record.scenarioId, list)
  }
  const costs = new Map<string, CaseCost>()
  for (const [caseId, reps] of grouped) {
    costs.set(caseId, {
      usd: reps.every((r) => r.costUsd !== null) ? mean(reps.map((r) => r.costUsd!)) : null,
      tokens: reps.every((r) => r.tokenUsage.tokensKnown !== false)
        ? mean(reps.map(tokenTotal))
        : null,
      seconds: mean(reps.map(latencySeconds)),
    })
  }
  return costs
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

function scoreOf(ctx: Context, profileId: string, caseId: string): number {
  return ctx.scores.get(profileId)!.get(caseId)!
}

function correct(ctx: Context, profileId: string, caseId: string): boolean {
  return scoreOf(ctx, profileId, caseId) >= ctx.rule.passScore
}

const NO_COST: Record<ProfileMatrixCostAxis, null> = { usd: null, tokens: null, seconds: null }

function profileStats(ctx: Context, profileId: string): ProfileMatrixProfileStats {
  const own = [...ctx.scores.get(profileId)!.keys()]
  const records = ctx.recordsByProfile.get(profileId)!
  const isBaseline = profileId === ctx.options.baseline
  const vsBaseline = isBaseline
    ? undefined
    : pairProfiles(ctx.scores.get(profileId)!, ctx.scores.get(ctx.options.baseline)!, ctx.rule)
  const droppedAtBatch = ctx.race?.log.find((batch) =>
    batch.standings.some((s) => s.profileId === profileId && s.dropped),
  )?.batch
  const base = {
    profileId,
    factors: ctx.options.factors?.[profileId] ?? {},
    casesAttempted: ctx.costs.get(profileId)!.size,
    casesScored: own.length,
    failureRate: records.filter((r) => runTaskScore(r) === undefined).length / records.length,
    coverage: coverageOf(ctx.scores, ctx.baselineCases, profileId),
    panel: ctx.panel.includes(profileId),
    pairedN: isBaseline ? own.length : (vsBaseline?.n ?? 0),
    ...(droppedAtBatch === undefined ? {} : { droppedAtBatch }),
    ownQuality: qualityOn(ctx, profileId, own),
    ...(vsBaseline ? { vsBaseline } : {}),
  }
  if (!base.panel) {
    return { ...base, quality: null, costPerCase: NO_COST, costPerCorrect: NO_COST, latency: null }
  }
  const costs = ctx.common.map((caseId) => ctx.costs.get(profileId)!.get(caseId)!)
  const correctCount = ctx.common.filter((caseId) => correct(ctx, profileId, caseId)).length
  const costPerCase = {} as Record<ProfileMatrixCostAxis, number | null>
  const costPerCorrect = {} as Record<ProfileMatrixCostAxis, number | null>
  for (const axis of PROFILE_MATRIX_COST_AXES) {
    const values = costs.map((cost) => cost[axis])
    const known = values.length > 0 && values.every((value) => value !== null)
    costPerCase[axis] = known ? mean(values as number[]) : null
    costPerCorrect[axis] =
      known && correctCount > 0
        ? (values as number[]).reduce((a, b) => a + b, 0) / correctCount
        : null
  }
  const seconds = costs.map((cost) => cost.seconds)
  return {
    ...base,
    quality: qualityOn(ctx, profileId, ctx.common),
    costPerCase,
    costPerCorrect,
    latency:
      seconds.length > 0
        ? { p50: percentileNearestRank(seconds, 50), p90: percentileNearestRank(seconds, 90) }
        : null,
  }
}

/** Mean score on `cases`: Wilson for unclustered pass/fail scores, the cluster jackknife otherwise. */
function qualityOn(
  ctx: Context,
  profileId: string,
  cases: readonly string[],
): ProfileMatrixInterval | null {
  const items = cases.map((caseId) => ({ caseId, score: scoreOf(ctx, profileId, caseId) }))
  if (items.length === 0) return null
  const estimate = mean(items.map((item) => item.score))
  if (ctx.rule.passFail && !ctx.options.clusters) {
    const successes = items.filter((item) => item.score === 1).length
    const interval = wilson(successes, items.length, ctx.rule.level)
    return { estimate, low: interval.lower, high: interval.upper }
  }
  const interval = clusterJackknife(
    items,
    (item) => ctx.rule.clusterOf(item.caseId),
    (sample) => mean(sample.map((item) => item.score)),
    { level: ctx.rule.level },
  )
  return { estimate, low: interval.low, high: interval.high }
}

function axisSummaries(
  ctx: Context,
  panel: readonly ProfileMatrixProfileStats[],
): ProfileMatrixAxisSummary[] {
  const requested = ctx.options.costAxes ?? PROFILE_MATRIX_COST_AXES
  return requested.map((axis) => {
    const x = (stats: ProfileMatrixProfileStats) =>
      axis === 'seconds' ? (stats.latency?.p50 ?? null) : stats.costPerCase[axis]
    const unmeasured = panel.filter((stats) => x(stats) === null)
    const reason =
      ctx.common.length === 0
        ? 'no case was scored by every panel profile'
        : unmeasured.length > 0
          ? `${unmeasured.length} of ${panel.length} panel profiles did not measure it on every common case`
          : axis === 'usd' && panel.every((stats) => x(stats) === 0)
            ? 'every profile costs $0 at the margin, as on flat-rate seats'
            : null
    if (reason !== null) return { axis, drawn: false, note: reason, frontier: [] }
    const { frontier } = paretoFrontier(
      [...panel],
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
  usd: 'mean dollars per common case',
  tokens:
    'mean tokens per common case: every prompt token, cached included, plus output with reasoning counted once',
  seconds:
    'median seconds per common case: dispatch time, or the cell wall clock where dispatch time was not recorded',
}

/**
 * Each level against the reference over matched pairs: profiles that differ only in this
 * factor. Each pair is compared on the cases it shares; a case's delta is the mean over the
 * pairs that share it, so a case counts once and the clusters stay independent.
 */
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
      const perCase = new Map<string, number[]>()
      const pairSizes = matched.map(([p, q]) => {
        const [a, b] = [ctx.scores.get(p)!, ctx.scores.get(q)!]
        const both = [...a.keys()].filter((caseId) => b.has(caseId))
        for (const caseId of both) {
          perCase.set(caseId, [...(perCase.get(caseId) ?? []), a.get(caseId)! - b.get(caseId)!])
        }
        return both.length
      })
      const base = {
        factor,
        level,
        reference,
        matchedPairs: matched.length,
        n: perCase.size,
        pairCases: matched.length
          ? { min: Math.min(...pairSizes), max: Math.max(...pairSizes) }
          : null,
      }
      if (perCase.size === 0) {
        effects.push({ ...base, effect: null, pValue: null })
        continue
      }
      const deltas = [...perCase]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([caseId, values]) => ({ caseId, delta: mean(values) }))
      const { pValue, estimate, low, high } = clusteredDifference(
        deltas,
        ctx.rule.clusterOf,
        ctx.rule.level,
      )
      effects.push({ ...base, effect: { estimate, low, high }, pValue })
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

/** Slices with the most common cases first, so the columns that carry evidence lead. */
function sliceNames(ctx: Context): string[] {
  if (!ctx.options.slices) return []
  const counts = new Map<string, number>()
  for (const caseId of ctx.common) {
    const slice = sliceOf(ctx, caseId)!
    counts.set(slice, (counts.get(slice) ?? 0) + 1)
  }
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([slice]) => slice)
}

function sliceCells(ctx: Context, slices: readonly string[]): ProfileMatrixSliceCell[] {
  return ctx.panel.flatMap((profileId) =>
    slices.map((slice) => {
      const cases = ctx.common.filter((caseId) => sliceOf(ctx, caseId) === slice)
      const scores = cases.map((caseId) => scoreOf(ctx, profileId, caseId))
      return { profileId, slice, n: scores.length, quality: scores.length ? mean(scores) : null }
    }),
  )
}

function errorOverlap(ctx: Context): Pick<ProfileMatrixAnalysis, 'errorOverlap' | 'oracle'> {
  const n = ctx.common.length
  const pairs: ProfileMatrixErrorOverlap[] = []
  ctx.panel.forEach((a, index) => {
    for (const b of ctx.panel.slice(index + 1)) {
      const right = ctx.common.map((c) => [correct(ctx, a, c), correct(ctx, b, c)] as const)
      pairs.push({
        a,
        b,
        bothWrong: n ? right.filter(([x, y]) => !x && !y).length / n : 0,
        disagree: n ? right.filter(([x, y]) => x !== y).length / n : 0,
      })
    }
  })
  const solved = ctx.common.filter((c) => ctx.panel.some((p) => correct(ctx, p, c))).length
  return { errorOverlap: pairs, oracle: n ? solved / n : null }
}

function difficulty(ctx: Context): ProfileMatrixCaseDifficulty[] {
  return ctx.common
    .map((caseId) => {
      const solved = ctx.panel.filter((p) => correct(ctx, p, caseId)).length
      const slice = sliceOf(ctx, caseId)
      return {
        caseId,
        ...(slice === undefined ? {} : { slice }),
        solved,
        scored: ctx.panel.length,
        share: solved / ctx.panel.length,
      }
    })
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
      return [{ evalScore: probability, outcome: score >= ctx.rule.passScore ? 1 : 0 }]
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
  panel: readonly ProfileMatrixProfileStats[],
): ProfileMatrixPower | null {
  const baselineScores = ctx.scores.get(ctx.options.baseline)!
  const discordances = panel
    .filter((stats) => stats.profileId !== ctx.options.baseline)
    .map(
      (stats) =>
        pairProfiles(ctx.scores.get(stats.profileId)!, baselineScores, ctx.rule, ctx.common)
          ?.discordance,
    )
    .filter((value) => value !== undefined)
    .sort((a, b) => a - b)
  if (ctx.common.length < 2 || discordances.length === 0) return null
  const discordance = discordances[Math.floor((discordances.length - 1) / 2)]!
  const sizes = new Map<string, number>()
  for (const caseId of ctx.common) {
    const cluster = ctx.rule.clusterOf(caseId)
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
      confidence: ctx.rule.level,
      alpha: 1 - ctx.rule.level,
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
    n: ctx.common.length,
    clusters: clusterSizes.length,
    discordance,
    detectable,
    certifiable: largest.signFlipFloor.certifiableAtAlpha,
    minClusters: largest.signFlipFloor.minClustersForAlpha,
  }
}
