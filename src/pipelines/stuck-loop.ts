/**
 * StuckLoopView — detects when an agent calls the same tool with the
 * same (or structurally similar) arguments ≥ N times in a short window.
 *
 * Rationale: agents that loop are the number-one production failure
 * mode on long-horizon flows. The view returns (runId, toolName,
 * argHash, occurrences, windowMs) for each detected loop plus a
 * fraction of runs affected.
 */

import { argHash, toolSpans } from '../trace/query'
import type { TraceStore } from '../trace/store'

const DEFAULT_MAX_WINDOW_MS = 60_000

export interface StuckLoopFinding {
  runId: string
  toolName: string
  argHash: string
  /** Calls in the densest qualifying interval, not the whole-run total. */
  occurrences: number
  spanIds: string[]
  /** Milliseconds between first and last call in the loop. */
  windowMs: number
}

export interface StuckLoopReport {
  findings: StuckLoopFinding[]
  affectedRunRatio: number
  totalRuns: number
}

export interface StuckLoopOptions {
  /** Minimum call count to flag a loop (default 3). */
  minOccurrences?: number
  /** Maximum time between the first and last repeated call (default 60 seconds). */
  maxWindowMs?: number
  /** Filter to a specific runId; omit to scan the entire corpus. */
  runId?: string
}

export async function stuckLoopView(
  store: TraceStore,
  options: StuckLoopOptions = {},
): Promise<StuckLoopReport> {
  const minOccurrences = options.minOccurrences ?? 3
  const maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS
  if (!Number.isFinite(maxWindowMs) || maxWindowMs < 0) {
    throw new RangeError('maxWindowMs must be a finite non-negative number')
  }
  const runs = options.runId
    ? [{ runId: options.runId }]
    : (await store.listRuns()).map((r) => ({ runId: r.runId }))

  const findings: StuckLoopFinding[] = []
  for (const { runId } of runs) {
    const tools = await toolSpans(store, runId)
    const byKey = new Map<string, { spans: typeof tools; argHash: string; toolName: string }>()
    for (const t of tools) {
      const h = argHash(t.args)
      // NUL delimiter never appears in a tool name or a JSON argHash, so the
      // key cannot collide; toolName is carried in the bucket rather than
      // re-derived by splitting the key (which mislabeled any tool whose name
      // contained the delimiter, e.g. "shell|grep").
      const key = `${t.toolName}\u0000${h}`
      const bucket = byKey.get(key) ?? { spans: [], argHash: h, toolName: t.toolName }
      bucket.spans.push(t)
      byKey.set(key, bucket)
    }
    for (const { spans, argHash: h, toolName } of byKey.values()) {
      if (spans.length < minOccurrences) continue
      const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt)
      let left = 0
      let bestStart = 0
      let bestEnd = -1
      for (let right = 0; right < sorted.length; right += 1) {
        while (sorted[right]!.startedAt - sorted[left]!.startedAt > maxWindowMs) left += 1
        if (right - left > bestEnd - bestStart) {
          bestStart = left
          bestEnd = right
        }
      }
      if (bestEnd - bestStart + 1 < minOccurrences) continue
      const loop = sorted.slice(bestStart, bestEnd + 1)
      const first = loop[0]!.startedAt
      const last = loop[loop.length - 1]!.startedAt
      findings.push({
        runId,
        toolName,
        argHash: h,
        occurrences: loop.length,
        spanIds: loop.map((s) => s.spanId),
        windowMs: last - first,
      })
    }
  }

  const affectedRuns = new Set(findings.map((f) => f.runId))
  return {
    findings,
    affectedRunRatio: runs.length > 0 ? affectedRuns.size / runs.length : 0,
    totalRuns: runs.length,
  }
}
