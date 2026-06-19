/**
 * Inference-time PRM scoring — pick the best of N candidate trajectories
 * using a trained reward model (or a rule-based PRM as a proxy).
 *
 * The canonical Best-of-N pattern: generate N completions, score each
 * with a PRM, pick the winner. Here the scoring loop is framework-agnostic
 * — supply a TraceStore + PrmGrader + N run IDs → get ranking + winner.
 */

import type { TraceStore } from '../trace/store'
import type { PrmGradedTrace, PrmGrader } from './rubric'

export interface BestOfNResult {
  winner: PrmGradedTrace
  ranked: PrmGradedTrace[]
  /** Standard deviation of aggregate scores — small = candidates were homogenous. */
  stdDev: number
}

/** Default max concurrent grader calls. Bounds LLM fan-out so a wide ensemble
 *  doesn't trigger a provider rate-limit storm. */
const DEFAULT_PRM_CONCURRENCY = 4

export interface PrmBestOfNOptions {
  /** Max concurrent `grader.grade` calls. Default 4. */
  concurrency?: number
}

export async function prmBestOfN(
  store: TraceStore,
  grader: PrmGrader,
  runIds: string[],
  options: PrmBestOfNOptions = {},
): Promise<BestOfNResult> {
  if (runIds.length === 0) throw new Error('prmBestOfN: at least 1 candidate required')
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_PRM_CONCURRENCY)
  const graded: PrmGradedTrace[] = new Array(runIds.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= runIds.length) return
      graded[i] = await grader.grade(store, runIds[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, runIds.length) }, () => worker()))
  const ranked = [...graded].sort((a, b) => b.aggregateScore - a.aggregateScore)
  const mean = graded.reduce((a, g) => a + g.aggregateScore, 0) / graded.length
  const variance = graded.reduce((a, g) => a + (g.aggregateScore - mean) ** 2, 0) / graded.length
  return { winner: ranked[0]!, ranked, stdDev: Math.sqrt(variance) }
}

/**
 * Weighted vote across multiple graders — use when you want a PRM ensemble
 * (e.g. rule-based + LLM-based + trained model). Each grader produces its
 * own ranking; we aggregate via rank-sum (Borda count) so no single grader
 * dominates via a different score scale.
 */
export async function prmEnsembleBestOfN(
  store: TraceStore,
  graders: PrmGrader[],
  runIds: string[],
  options: PrmBestOfNOptions = {},
): Promise<BestOfNResult> {
  if (graders.length === 0) throw new Error('prmEnsembleBestOfN: at least 1 grader')
  if (runIds.length === 0) throw new Error('prmEnsembleBestOfN: at least 1 candidate required')
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_PRM_CONCURRENCY)

  // Flatten the (grader, runId) product and run it through a single bounded
  // pool. Nested unbounded fan-out (graders × runIds) would launch every LLM
  // call at once. allSettled isolates failures: one grader (or one runId)
  // failing doesn't void the whole ensemble.
  type Job = { graderIdx: number; runId: string }
  const jobs: Job[] = []
  for (let gi = 0; gi < graders.length; gi++) {
    for (const runId of runIds) jobs.push({ graderIdx: gi, runId })
  }
  const settled: PromiseSettledResult<PrmGradedTrace>[] = new Array(jobs.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= jobs.length) return
      const job = jobs[i]!
      settled[i] = await graders[job.graderIdx]!.grade(store, job.runId)
        .then((value): PromiseSettledResult<PrmGradedTrace> => ({ status: 'fulfilled', value }))
        .catch((reason): PromiseSettledResult<PrmGradedTrace> => ({ status: 'rejected', reason }))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))

  // Regroup fulfilled results into per-grader rankings. A grader contributes
  // only the candidates it successfully graded; a grader that graded nothing
  // is dropped from the vote rather than skewing it with phantom zeros.
  const perGrader: PrmGradedTrace[][] = graders.map(() => [])
  const failures: { graderIdx: number; runId: string; error: string }[] = []
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!
    const result = settled[i]!
    if (result.status === 'fulfilled') perGrader[job.graderIdx]!.push(result.value)
    else {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason)
      failures.push({ graderIdx: job.graderIdx, runId: job.runId, error })
    }
  }
  const survivingGraders = perGrader.filter((ranking) => ranking.length > 0)
  if (survivingGraders.length === 0) {
    throw new Error(
      `prmEnsembleBestOfN: every grader failed on every candidate (${failures.length} call(s)). First error: ${failures[0]?.error ?? 'unknown'}`,
    )
  }
  for (const ranking of survivingGraders)
    ranking.sort((a, b) => b.aggregateScore - a.aggregateScore)

  // Borda: rank-sum across surviving graders.
  const bordaScores = new Map<string, number>()
  for (const ranking of survivingGraders) {
    ranking.forEach((g, rank) => {
      bordaScores.set(g.runId, (bordaScores.get(g.runId) ?? 0) + (ranking.length - rank))
    })
  }
  // Synthesize a ranking from the union of every successfully-graded trace,
  // ordered by Borda score. aggregateScore field kept for UX. Using the union
  // (not just the first grader) keeps a candidate that one grader dropped but
  // another graded.
  const byRun = new Map<string, PrmGradedTrace>()
  for (const ranking of survivingGraders) {
    for (const g of ranking) if (!byRun.has(g.runId)) byRun.set(g.runId, g)
  }
  const ranked = [...byRun.values()].sort(
    (a, b) => (bordaScores.get(b.runId) ?? 0) - (bordaScores.get(a.runId) ?? 0),
  )
  const mean = ranked.reduce((a, g) => a + g.aggregateScore, 0) / ranked.length
  const variance = ranked.reduce((a, g) => a + (g.aggregateScore - mean) ** 2, 0) / ranked.length
  return { winner: ranked[0]!, ranked, stdDev: Math.sqrt(variance) }
}
