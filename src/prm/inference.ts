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

export async function prmBestOfN(
  store: TraceStore,
  grader: PrmGrader,
  runIds: string[],
): Promise<BestOfNResult> {
  if (runIds.length === 0) throw new Error('prmBestOfN: at least 1 candidate required')
  const graded = await Promise.all(runIds.map((id) => grader.grade(store, id)))
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
): Promise<BestOfNResult> {
  if (graders.length === 0) throw new Error('prmEnsembleBestOfN: at least 1 grader')
  const perGrader = await Promise.all(
    graders.map(async (g) => {
      const graded = await Promise.all(runIds.map((id) => g.grade(store, id)))
      return graded.sort((a, b) => b.aggregateScore - a.aggregateScore)
    }),
  )
  // Borda: rank-sum across graders.
  const bordaScores = new Map<string, number>()
  for (const ranking of perGrader) {
    ranking.forEach((g, rank) => {
      bordaScores.set(g.runId, (bordaScores.get(g.runId) ?? 0) + (ranking.length - rank))
    })
  }
  // Return a synthesized ranking using the first grader's graded traces
  // ordered by Borda score. aggregateScore field kept for UX.
  const canonical = perGrader[0]!
  const byRun = new Map(canonical.map((g) => [g.runId, g]))
  const ranked = [...byRun.values()].sort(
    (a, b) => (bordaScores.get(b.runId) ?? 0) - (bordaScores.get(a.runId) ?? 0),
  )
  const mean = ranked.reduce((a, g) => a + g.aggregateScore, 0) / ranked.length
  const variance = ranked.reduce((a, g) => a + (g.aggregateScore - mean) ** 2, 0) / ranked.length
  return { winner: ranked[0]!, ranked, stdDev: Math.sqrt(variance) }
}
