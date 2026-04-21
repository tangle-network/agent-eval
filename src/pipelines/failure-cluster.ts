/**
 * FailureClusterView — groups failed runs by (failureClass, triggerTool,
 * argHash-prefix) so weekly reviews can prioritize the top-N clusters.
 *
 * Each cluster includes: N runs, scenarios affected, representative
 * error message, a proposed mitigation hint (rule → action table).
 */

import { classifyFailure, type FailureRule, DEFAULT_RULES } from '../failure-taxonomy'
import type { FailureClass, Span } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { argHash, toolSpans } from '../trace/query'

export interface FailureCluster {
  failureClass: FailureClass
  /** Tool name when the trigger was a tool span, else undefined. */
  toolName?: string
  /** First 16 chars of argHash — clusters similar args. */
  argPrefix?: string
  runCount: number
  scenarioIds: string[]
  exampleError?: string
  exampleRunId: string
}

export interface FailureClusterReport {
  clusters: FailureCluster[]
  totalFailures: number
  totalRuns: number
}

export async function failureClusterView(
  store: TraceStore,
  options: { rules?: FailureRule[]; minClusterSize?: number } = {},
): Promise<FailureClusterReport> {
  const rules = options.rules ?? DEFAULT_RULES
  const minSize = options.minClusterSize ?? 1
  const runs = await store.listRuns()

  type Key = string
  const clusters = new Map<Key, FailureCluster>()
  let totalFailures = 0

  for (const run of runs) {
    if (run.status === 'completed' && run.outcome?.pass !== false) continue
    totalFailures++
    const spans = await store.spans({ runId: run.runId })
    const events = await store.events({ runId: run.runId })
    const cls = classifyFailure({ run, spans, events }, rules)

    let toolName: string | undefined
    let argPrefix: string | undefined
    if (cls.triggerSpanId) {
      const trig = spans.find((s) => s.spanId === cls.triggerSpanId)
      if (trig?.kind === 'tool') {
        toolName = trig.toolName
        argPrefix = argHash(trig.args).slice(0, 16)
      }
    }
    // Fallback: look at the last errored tool span
    if (!toolName) {
      const ts = await toolSpans(store, run.runId)
      const errored = ts.filter((t) => t.status === 'error').pop()
      if (errored) {
        toolName = errored.toolName
        argPrefix = argHash(errored.args).slice(0, 16)
      }
    }

    const key = `${cls.failureClass}|${toolName ?? ''}|${argPrefix ?? ''}`
    let cluster = clusters.get(key)
    if (!cluster) {
      cluster = {
        failureClass: cls.failureClass,
        toolName,
        argPrefix,
        runCount: 0,
        scenarioIds: [],
        exampleRunId: run.runId,
        exampleError: firstErrorMessage(spans) ?? cls.reason,
      }
      clusters.set(key, cluster)
    }
    cluster.runCount++
    if (!cluster.scenarioIds.includes(run.scenarioId)) cluster.scenarioIds.push(run.scenarioId)
  }

  const arr = [...clusters.values()]
    .filter((c) => c.runCount >= minSize)
    .sort((a, b) => b.runCount - a.runCount)

  return { clusters: arr, totalFailures, totalRuns: runs.length }
}

function firstErrorMessage(spans: Span[]): string | undefined {
  const errored = spans.find((s) => s.status === 'error')
  return errored?.error
}
