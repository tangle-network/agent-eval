/** Task failure classes, analyst clusters, and canary contamination evidence. */

import type { AnalystRegistry } from '../analyst/registry'
import type { AnalystFinding } from '../analyst/types'
import { checkCanaries } from '../contamination-guard'
import type { DatasetScenario } from '../dataset'
import type { RunRecord } from '../run-record'
import type { FailureClass } from '../trace/schema'
import type { FailureClassTally, FailureClusterInsight, InsightReport } from './insight-report'
import { compositeOf } from './quality-insight'

/**
 * Model-free task-failure tally.
 *
 * Explicit non-success classes are task-failure evidence.
 * A low task score without a class is counted as `unknown`.
 */
export function computeFailureClasses(
  runs: RunRecord[],
  split: 'search' | 'holdout',
): FailureClassTally[] | undefined {
  const counts = new Map<FailureClass, number>()
  for (const r of runs) {
    if (!isTaskFailure(r, split)) continue
    const key =
      r.failureClass !== undefined && r.failureClass !== 'success' ? r.failureClass : 'unknown'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  const n = runs.length
  return [...counts.entries()]
    .map(([failureClass, count]) => ({
      failureClass,
      count,
      share: n > 0 ? count / n : 0,
    }))
    .sort((a, b) => b.count - a.count || a.failureClass.localeCompare(b.failureClass))
}

export async function computeFailureClusters(
  runs: RunRecord[],
  analyst: AnalystRegistry,
  split: 'search' | 'holdout',
): Promise<FailureClusterInsight | undefined> {
  const failed = runs.filter((run) => isTaskFailure(run, split))
  if (failed.length === 0) return { clusters: [], totalFailures: 0 }

  const clusters = new Map<string, { exemplars: string[]; runs: number }>()
  const recordCluster = (key: string, runId: string) => {
    const cluster = clusters.get(key) ?? { exemplars: [], runs: 0 }
    cluster.runs += 1
    if (cluster.exemplars.length < 5 && !cluster.exemplars.includes(runId)) {
      cluster.exemplars.push(runId)
    }
    clusters.set(key, cluster)
  }
  for (const run of failed) {
    try {
      // AnalystRunInputs routes by field name: run-record analysts read
      // `runRecord`. Any other shape makes every analyst skip with
      // "missing input" and the clusters come back silently empty.
      const result = await analyst.run(run.runId, { runRecord: run })
      // One run can produce several findings in one cluster; count it once.
      const keys = new Set(
        result.findings.map(
          (finding: AnalystFinding) => finding.area || finding.analyst_id || 'unclassified',
        ),
      )
      for (const key of keys) recordCluster(key, run.runId)
    } catch {
      recordCluster('analyst-error', run.runId)
    }
  }
  const clusterList = [...clusters.entries()].map(([id, c]) => ({
    id,
    name: id,
    share: c.runs / failed.length,
    exemplars: c.exemplars,
  }))
  clusterList.sort((a, b) => b.share - a.share)
  return { clusters: clusterList, totalFailures: failed.length }
}

function isTaskFailure(run: RunRecord, split: 'search' | 'holdout'): boolean {
  if (run.failureClass !== undefined && run.failureClass !== 'success') return true
  const score = compositeOf(run, split)
  return Number.isFinite(score) && score < 0.5
}

export function computeContamination(
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
