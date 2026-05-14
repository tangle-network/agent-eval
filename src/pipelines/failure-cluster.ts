/**
 * FailureClusterView — groups failed runs by (failureClass, triggerTool,
 * argHash-prefix) so weekly reviews can prioritize the top-N clusters.
 *
 * Each cluster includes: N runs, scenarios affected, representative
 * error message, a proposed mitigation hint (rule → action table).
 */

import { classifyFailure, DEFAULT_RULES, type FailureRule } from '../failure-taxonomy'
import { argHash, toolSpans } from '../trace/query'
import type { FailureClass, Span } from '../trace/schema'
import type { TraceStore } from '../trace/store'

export interface FailureCluster {
  failureClass: FailureClass
  /** Tool name when the trigger was a tool span, else undefined. */
  toolName?: string
  /** First 16 chars of argHash — clusters similar args. */
  argPrefix?: string
  /**
   * Source dimension when the trigger was a judge span (e.g. `'format'`,
   * `'safety'`, `'correctness'`). Lets cross-template aggregators
   * group failures by the dimension that fired without overloading
   * `argPrefix`. Optional — legacy clusters without this field
   * deserialize cleanly.
   */
  dimension?: string
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
    let dimension: string | undefined
    if (cls.triggerSpanId) {
      const trig = spans.find((s) => s.spanId === cls.triggerSpanId)
      if (trig?.kind === 'tool') {
        toolName = trig.toolName
        argPrefix = argHash(trig.args).slice(0, 16)
      } else if (trig?.kind === 'judge') {
        dimension = trig.dimension
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
    // Secondary signal: any judge span on the failed run carries a
    // dimension. Useful when the rule classified by judge score but
    // didn't surface the trigger span (or surfaced a non-judge span).
    if (!dimension) {
      const judge = spans.find((s) => s.kind === 'judge' && typeof s.dimension === 'string')
      if (judge?.kind === 'judge') dimension = judge.dimension
    }

    const key = `${cls.failureClass}|${toolName ?? ''}|${argPrefix ?? ''}|${dimension ?? ''}`
    let cluster = clusters.get(key)
    if (!cluster) {
      cluster = {
        failureClass: cls.failureClass,
        toolName,
        argPrefix,
        dimension,
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
