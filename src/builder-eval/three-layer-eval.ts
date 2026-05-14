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
 *
 * Scaffold-only mode: when a project has no `app-runtime` runs (e.g. a
 * scaffold-builder eval that grades compose + build without driving a
 * runtime scenario), `kind` is `'scaffold-only'` and `complete` measures
 * meta + build only. Consumers can tell the two apart without having to
 * interpret null-runtime as either "not yet computed" or "N/A for this
 * project shape".
 */

import { judgeSpans } from '../trace/query'
import type { Run } from '../trace/schema'
import type { TraceStore } from '../trace/store'

export type ProjectKind = 'full' | 'scaffold-only'

export interface ThreeLayerProjectReport {
  projectId: string
  /**
   * `'full'` when the project has at least one `app-runtime` run;
   * `'scaffold-only'` when it only has meta + build layers. Lets
   * downstream consumers treat a null runtime score as expected
   * (scaffold-only) vs. missing (full, pipeline broke).
   */
  kind: ProjectKind
  builderRunId?: string
  /** Judge-verdict score on the builder run (0..1 after normalization). */
  metaScore: number | null
  buildRunId?: string
  /** 0..1 from the sandbox harness (testsPassed / testsTotal). */
  buildScore: number | null
  appRuntimeRunIds: string[]
  /** Mean of outcome.score over app-runtime runs, 0..1. Always null in scaffold-only mode. */
  runtimeScore: number | null
  runtimePassRate: number | null
  /**
   * Layer-aware completeness:
   *   - `kind='full'`: all three layers scored
   *   - `kind='scaffold-only'`: meta + build scored (runtime not applicable)
   */
  complete: boolean
}

export async function scoreProject(
  store: TraceStore,
  projectId: string,
): Promise<ThreeLayerProjectReport> {
  const allRuns = await store.listRuns({ projectId })
  const builder = latestByLayer(allRuns, 'builder')
  const build = latestByLayer(allRuns, 'app-build')
  const runtime = allRuns.filter((r) => r.layer === 'app-runtime')

  const metaScore = builder ? await extractMetaScore(store, builder.runId) : null
  const buildScore = build?.outcome?.score ?? null
  const runtimeScores = runtime
    .map((r) => r.outcome?.score)
    .filter((s): s is number => typeof s === 'number')
  const runtimeScore =
    runtimeScores.length > 0
      ? runtimeScores.reduce((a, b) => a + b, 0) / runtimeScores.length
      : null
  const runtimePassed = runtime.filter((r) => r.outcome?.pass === true).length
  const runtimePassRate = runtime.length > 0 ? runtimePassed / runtime.length : null

  const kind: ProjectKind = runtime.length === 0 ? 'scaffold-only' : 'full'
  const complete =
    kind === 'scaffold-only'
      ? metaScore !== null && buildScore !== null
      : metaScore !== null && buildScore !== null && runtimeScore !== null

  return {
    projectId,
    kind,
    builderRunId: builder?.runId,
    metaScore,
    buildRunId: build?.runId,
    buildScore,
    appRuntimeRunIds: runtime.map((r) => r.runId),
    runtimeScore,
    runtimePassRate,
    complete,
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
  const meta = js.find(
    (s) => s.judgeId === 'builder-meta' && s.dimension === 'user_intent_satisfaction',
  )
  if (!meta) return null
  // Normalize score to 0..1. Accept 0-1 natively; 0-10 scale is also common.
  if (meta.score >= 0 && meta.score <= 1) return meta.score
  if (meta.score >= 0 && meta.score <= 10) return meta.score / 10
  return null
}
