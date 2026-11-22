/**
 * Race a profile matrix: run the surviving profiles on doubling case batches
 * and stop paying for a profile once it is clearly worse than the leader.
 *
 * The race is a sampling policy over a segmented plan. Each batch is one
 * `runProfileMatrixSegment` with a stable segment id, so a race interrupted
 * mid-batch resumes from the campaign cell cache and replays the same
 * decisions. Rows the race never ran stay unclaimed: running them later and
 * calling `finalizeProfileMatrix` completes the full matrix.
 */

import { ValidationError } from '../../errors'
import { assertRealBackend, summarizeBackendIntegrity } from '../../integrity/backend-integrity'
import { type RunRecord, runTaskScore } from '../../run-record'
import { makeRng } from '../../statistics/internal'
import { mean } from '../../statistics/mean'
import type { Scenario } from '../types'
import { clusteredDifference, clusterResolver } from './profile-matrix-analysis'
import {
  type ProfileMatrixPlan,
  type RunProfileMatrixSegmentOptions,
  runProfileMatrixSegment,
} from './segmented-profile-matrix'

export interface RaceProfileMatrixOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunProfileMatrixSegmentOptions<TScenario, TArtifact>, 'segmentId' | 'rows'> {
  /** Profile id kept to the end whatever its standing; the final comparison is against it. */
  baseline: string
  /** Cases seen after each batch, strictly increasing. Default: `firstBatch`, doubling until every case is in. */
  batches?: readonly number[]
  /** Cases in the first batch when `batches` is not given. Default 8. */
  firstBatch?: number
  /** Most cells (one profile on one case and rep) the race may run; a batch that would pass it is not started. */
  cellBudget?: number
  /** Independent unit per case id; every raced case needs one. Default one unit per case. */
  clusters?: Readonly<Record<string, string>>
  /** Interval level of each elimination. Default 0.95. */
  level?: number
  /** `shuffled` (default) orders cases by a draw seeded with the plan seed; `plan` keeps the plan's order. */
  caseOrder?: 'shuffled' | 'plan'
}

export interface ProfileMatrixRaceStanding {
  profileId: string
  /** Cases both this profile and the leader scored. */
  n: number
  /** Mean paired difference from the leader; null without a shared scored case. */
  difference: number | null
  low: number | null
  high: number | null
  dropped: boolean
  reason?: string
}

export interface ProfileMatrixRaceBatch {
  batch: number
  casesSeen: number
  cellsRun: number
  leader: string
  standings: ProfileMatrixRaceStanding[]
}

export interface ProfileMatrixRaceFinalRow {
  profileId: string
  quality: number | null
  /** Paired difference from the baseline; null on the baseline itself. */
  vsBaseline: { difference: number; low: number | null; high: number | null } | null
}

export interface ProfileMatrixRaceResult {
  matrixId: string
  planDigest: string
  baseline: string
  leader: string
  survivors: string[]
  stoppedBecause: 'one-left' | 'cell-budget' | 'batches-ended'
  casesRaced: string[]
  cellsRun: number
  /** Cells the complete plan holds. */
  plannedCells: number
  log: ProfileMatrixRaceBatch[]
  /** Survivors on the cases every survivor scored. */
  final: { cases: number; rows: ProfileMatrixRaceFinalRow[] }
  records: RunRecord[]
  /** The race chose its leader on these cases, so the leader's score here reads high. */
  selectionBias: string
}

type Scores = Map<string, Map<string, number>>

interface RaceContext {
  baseline: string
  level: number
  clusterOf: (caseId: string) => string
  /** Plan order with the baseline first; ties go to the earlier profile. */
  profileIds: string[]
}

/**
 * Successive halving over a profile-matrix plan. After each batch a profile
 * whose paired interval against the current leader lies wholly below zero is
 * dropped, as is one whose cells in the batch produced no score; the baseline
 * is always kept. The race stops when one profile is left, the next batch
 * would pass `cellBudget`, or the batch list ends.
 */
export async function raceProfileMatrix<TScenario extends Scenario, TArtifact>(
  opts: RaceProfileMatrixOptions<TScenario, TArtifact>,
): Promise<ProfileMatrixRaceResult> {
  const {
    baseline,
    batches: requestedBatches,
    firstBatch,
    cellBudget,
    clusters,
    level = 0.95,
    caseOrder = 'shuffled',
    ...segment
  } = opts
  const { plan } = segment
  const planned = [...new Set(plan.rows.map((row) => row.profileId))]
  if (!planned.includes(baseline)) {
    throw new ValidationError(`raceProfileMatrix: baseline '${baseline}' is not a planned profile`)
  }
  if (!(level > 0 && level < 1))
    throw new ValidationError('raceProfileMatrix: level must be in (0, 1)')
  if (cellBudget !== undefined && !(Number.isSafeInteger(cellBudget) && cellBudget > 0)) {
    throw new ValidationError('raceProfileMatrix: cellBudget must be a positive integer')
  }
  const ctx: RaceContext = {
    baseline,
    level,
    clusterOf: clusterResolver(clusters, 'raceProfileMatrix'),
    profileIds: [baseline, ...planned.filter((id) => id !== baseline)],
  }
  const order = orderCases(plan, caseOrder)
  const batches = batchSizes(requestedBatches, firstBatch, order.length)

  let survivors = [...ctx.profileIds]
  const records = new Map<string, RunRecord>()
  const log: ProfileMatrixRaceBatch[] = []
  let cellsRun = 0
  let seen = 0
  let stoppedBecause: ProfileMatrixRaceResult['stoppedBecause'] = 'batches-ended'
  for (const [index, total] of batches.entries()) {
    if (survivors.length === 1) break
    const batchCases = order.slice(seen, total)
    const inBatch = new Set(batchCases)
    const rows = plan.rows.filter(
      (row) => survivors.includes(row.profileId) && inBatch.has(row.scenarioId),
    )
    if (cellBudget !== undefined && cellsRun + rows.length > cellBudget) {
      if (index === 0) {
        throw new ValidationError(
          `raceProfileMatrix: cellBudget ${cellBudget} is below the first batch's ${rows.length} cells`,
        )
      }
      stoppedBecause = 'cell-budget'
      break
    }
    const result = await runProfileMatrixSegment({
      ...segment,
      segmentId: `race-batch-${index + 1}`,
      rows: rows.map((row) => row.rowId),
    })
    enforceIntegrity(plan, result.matrix.records)
    for (const record of result.matrix.records) records.set(record.runId, record)
    cellsRun += rows.length
    seen = total
    const entry = standings(
      ctx,
      scoreTable([...records.values()]),
      survivors,
      order.slice(0, seen),
      batchCases,
    )
    log.push({ batch: index + 1, casesSeen: seen, cellsRun: rows.length, ...entry })
    const dropped = new Set(entry.standings.filter((s) => s.dropped).map((s) => s.profileId))
    survivors = survivors.filter((id) => !dropped.has(id))
  }
  if (survivors.length === 1) stoppedBecause = 'one-left'

  const casesRaced = order.slice(0, seen)
  const final = finalComparison(ctx, scoreTable([...records.values()]), survivors, casesRaced)
  return {
    matrixId: plan.matrixId,
    planDigest: plan.planDigest,
    baseline,
    leader: final.leader,
    survivors,
    stoppedBecause,
    casesRaced,
    cellsRun,
    plannedCells: plan.rows.length,
    log,
    final: { cases: final.cases, rows: final.rows },
    records: [...records.values()],
    selectionBias:
      `${final.leader} leads on the ${casesRaced.length} raced cases, which the race also used to ` +
      'choose it, so its score there is biased upward; confirm it on fresh held-out cases before acting on it.',
  }
}

function orderCases<TScenario extends Scenario, TArtifact>(
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
  caseOrder: 'shuffled' | 'plan',
): string[] {
  const ids = plan.scenarios.map((scenario) => scenario.id)
  if (caseOrder === 'plan') return ids
  const rng = makeRng(plan.seed)
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
  }
  return ids
}

function batchSizes(
  requested: readonly number[] | undefined,
  firstBatch: number | undefined,
  caseCount: number,
): number[] {
  if (requested !== undefined) {
    const valid =
      requested.length > 0 &&
      requested.every(
        (total, i) =>
          Number.isSafeInteger(total) &&
          total > (i === 0 ? 0 : requested[i - 1]!) &&
          total <= caseCount,
      )
    if (!valid) {
      throw new ValidationError(
        `raceProfileMatrix: batches must be strictly increasing case counts within 1..${caseCount}`,
      )
    }
    return [...requested]
  }
  const first = firstBatch ?? Math.min(8, caseCount)
  if (!(Number.isSafeInteger(first) && first > 0 && first <= caseCount)) {
    throw new ValidationError(
      `raceProfileMatrix: firstBatch must be an integer within 1..${caseCount}`,
    )
  }
  const sizes: number[] = []
  for (let total = first; total < caseCount; total *= 2) sizes.push(total)
  sizes.push(caseCount)
  return sizes
}

function enforceIntegrity<TScenario extends Scenario, TArtifact>(
  plan: ProfileMatrixPlan<TScenario, TArtifact>,
  records: readonly RunRecord[],
): void {
  if (plan.integrity === 'assert') assertRealBackend(records, { allowMixed: plan.allowMixed })
  if (plan.integrity !== 'warn') return
  const report = summarizeBackendIntegrity(records)
  if (report.verdict !== 'real') {
    console.warn(`[raceProfileMatrix] backend integrity: ${report.verdict} — ${report.diagnosis}`)
  }
}

/** Mean score per profile and case over its scored reps. */
function scoreTable(records: readonly RunRecord[]): Scores {
  const sums = new Map<string, Map<string, number[]>>()
  for (const record of records) {
    const score = runTaskScore(record)
    if (score === undefined) continue
    const cases = sums.get(record.candidateId) ?? new Map<string, number[]>()
    cases.set(record.scenarioId, [...(cases.get(record.scenarioId) ?? []), score])
    sums.set(record.candidateId, cases)
  }
  return new Map(
    [...sums].map(([id, cases]) => [id, new Map([...cases].map(([c, xs]) => [c, mean(xs)]))]),
  )
}

/** The highest mean on the cases every candidate scored; ties go to the earlier profile. */
function leaderOf(
  ctx: RaceContext,
  scores: Scores,
  candidates: readonly string[],
  cases: readonly string[],
) {
  const shared = cases.filter((c) => candidates.every((p) => scores.get(p)?.has(c)))
  let leader = candidates.includes(ctx.baseline) ? ctx.baseline : candidates[0]!
  if (shared.length === 0) return { leader, shared }
  const quality = (p: string) => mean(shared.map((c) => scores.get(p)!.get(c)!))
  for (const p of ctx.profileIds) {
    if (candidates.includes(p) && quality(p) > quality(leader)) leader = p
  }
  return { leader, shared }
}

function pairedAgainst(
  ctx: RaceContext,
  scores: Scores,
  p: string,
  q: string,
  cases: readonly string[],
) {
  const both = cases.filter((c) => scores.get(p)?.has(c) && scores.get(q)?.has(c))
  if (both.length === 0) return null
  const deltas = both.map((caseId) => ({
    caseId,
    delta: scores.get(p)!.get(caseId)! - scores.get(q)!.get(caseId)!,
  }))
  const result = clusteredDifference(deltas, ctx.clusterOf, ctx.level)
  return { n: both.length, difference: result.estimate, low: result.low, high: result.high }
}

function standings(
  ctx: RaceContext,
  scores: Scores,
  survivors: readonly string[],
  seen: readonly string[],
  batchCases: readonly string[],
): Pick<ProfileMatrixRaceBatch, 'leader' | 'standings'> {
  const { leader } = leaderOf(ctx, scores, survivors, seen)
  return {
    leader,
    standings: survivors.map((profileId) => {
      const paired = pairedAgainst(ctx, scores, profileId, leader, seen)
      const base = {
        profileId,
        n: paired?.n ?? 0,
        difference: paired?.difference ?? null,
        low: paired?.low ?? null,
        high: paired?.high ?? null,
      }
      const protectedProfile = profileId === ctx.baseline || profileId === leader
      if (!batchCases.some((c) => scores.get(profileId)?.has(c))) {
        return protectedProfile
          ? { ...base, dropped: false, reason: 'kept: no cell in this batch produced a score' }
          : { ...base, dropped: true, reason: 'no cell in this batch produced a score' }
      }
      if (base.high === null || base.high >= 0) return { ...base, dropped: false }
      const interval = `[${base.low!.toFixed(3)}, ${base.high.toFixed(3)}]`
      return protectedProfile
        ? {
            ...base,
            dropped: false,
            reason: `kept as the baseline: interval ${interval} lies below zero`,
          }
        : {
            ...base,
            dropped: true,
            reason: `interval ${interval} against ${leader} lies below zero`,
          }
    }),
  }
}

function finalComparison(
  ctx: RaceContext,
  scores: Scores,
  survivors: readonly string[],
  casesRaced: readonly string[],
) {
  const { leader, shared } = leaderOf(ctx, scores, survivors, casesRaced)
  const rows = survivors.map((profileId): ProfileMatrixRaceFinalRow => {
    const quality = shared.length ? mean(shared.map((c) => scores.get(profileId)!.get(c)!)) : null
    const paired =
      profileId === ctx.baseline
        ? null
        : pairedAgainst(ctx, scores, profileId, ctx.baseline, shared)
    return {
      profileId,
      quality,
      vsBaseline: paired
        ? { difference: paired.difference, low: paired.low, high: paired.high }
        : null,
    }
  })
  return { leader, cases: shared.length, rows }
}
