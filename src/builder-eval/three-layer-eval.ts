/**
 * Three-layer evaluation — the canonical scoring breakdown for
 * builder-of-builders workflows.
 *
 *   meta_score:    did the builder understand + satisfy user intent?
 *                  (judge verdict attached to the builder run)
 *   build_score:   did the generated scaffold build + pass its own tests?
 *                  (outcome.score on the app-build child run)
 *   runtime_score: did the generated agent pass its domain scenarios?
 *                  (mean outcome.score over app-runtime grandchild runs)
 *
 * Returns a structured report per project. The cross-layer correlation
 * is the highest-leverage signal the framework computes — if
 * meta_score doesn't predict runtime_score, the builder's self-scoring
 * is broken.
 */

import type { Run } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { judgeSpans } from '../trace/query'

export interface ThreeLayerProjectReport {
  projectId: string
  builderRunId?: string
  /** Judge-verdict score on the builder run (0..1 after normalization). */
  metaScore: number | null
  buildRunId?: string
  /** 0..1 from the sandbox harness (testsPassed / testsTotal). */
  buildScore: number | null
  appRuntimeRunIds: string[]
  /** Mean of outcome.score over app-runtime runs, 0..1. */
  runtimeScore: number | null
  runtimePassRate: number | null
  /** True when all three layers produced a score. */
  complete: boolean
}

export async function scoreProject(store: TraceStore, projectId: string): Promise<ThreeLayerProjectReport> {
  const allRuns = await store.listRuns({ projectId })
  const builder = latestByLayer(allRuns, 'builder')
  const build = latestByLayer(allRuns, 'app-build')
  const runtime = allRuns.filter((r) => r.layer === 'app-runtime')

  const metaScore = builder ? await extractMetaScore(store, builder.runId) : null
  const buildScore = build?.outcome?.score ?? null
  const runtimeScores = runtime.map((r) => r.outcome?.score).filter((s): s is number => typeof s === 'number')
  const runtimeScore = runtimeScores.length > 0 ? runtimeScores.reduce((a, b) => a + b, 0) / runtimeScores.length : null
  const runtimePassed = runtime.filter((r) => r.outcome?.pass === true).length
  const runtimePassRate = runtime.length > 0 ? runtimePassed / runtime.length : null

  return {
    projectId,
    builderRunId: builder?.runId,
    metaScore,
    buildRunId: build?.runId,
    buildScore,
    appRuntimeRunIds: runtime.map((r) => r.runId),
    runtimeScore,
    runtimePassRate,
    complete: metaScore !== null && buildScore !== null && runtimeScore !== null,
  }
}

/** Aggregate scoring across every project in a corpus. */
export async function scoreAllProjects(store: TraceStore): Promise<ThreeLayerProjectReport[]> {
  const runs = await store.listRuns()
  const projectIds = [...new Set(runs.map((r) => r.projectId).filter((p): p is string => !!p))]
  return Promise.all(projectIds.map((p) => scoreProject(store, p)))
}

function latestByLayer(runs: Run[], layer: Run['layer']): Run | undefined {
  const filtered = runs.filter((r) => r.layer === layer).sort((a, b) => b.startedAt - a.startedAt)
  return filtered[0]
}

async function extractMetaScore(store: TraceStore, builderRunId: string): Promise<number | null> {
  const js = await judgeSpans(store, builderRunId)
  const meta = js.find((s) => s.judgeId === 'builder-meta' && s.dimension === 'user_intent_satisfaction')
  if (!meta) return null
  // Normalize score to 0..1. Accept 0-1 natively; 0-10 scale is also common.
  if (meta.score >= 0 && meta.score <= 1) return meta.score
  if (meta.score >= 0 && meta.score <= 10) return meta.score / 10
  return null
}
