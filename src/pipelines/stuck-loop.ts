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
import type { ToolSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'

const DEFAULT_MAX_WINDOW_MS = 60_000
const DEFAULT_MAX_INTERVENING_TOOL_CALLS = 0

interface IndexedToolCall {
  span: ToolSpan
  toolCallIndex: number
}

export interface StuckLoopFinding {
  runId: string
  toolName: string
  argHash: string
  /** Calls in this episode's densest qualifying interval, not the whole-run total. */
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
  /**
   * Maximum other tool calls allowed between adjacent repeats (default 0).
   * Set to 1 to detect alternating patterns such as A,B,A,B,A.
   */
  maxInterveningToolCalls?: number
  /** Filter to a specific runId; omit to scan the entire corpus. */
  runId?: string
}

export async function stuckLoopView(
  store: TraceStore,
  options: StuckLoopOptions = {},
): Promise<StuckLoopReport> {
  const minOccurrences = options.minOccurrences ?? 3
  const maxWindowMs = options.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS
  const maxInterveningToolCalls =
    options.maxInterveningToolCalls ?? DEFAULT_MAX_INTERVENING_TOOL_CALLS
  if (!Number.isInteger(minOccurrences) || minOccurrences < 1) {
    throw new RangeError('minOccurrences must be a positive integer')
  }
  if (!Number.isFinite(maxWindowMs) || maxWindowMs < 0) {
    throw new RangeError('maxWindowMs must be a finite non-negative number')
  }
  if (!Number.isInteger(maxInterveningToolCalls) || maxInterveningToolCalls < 0) {
    throw new RangeError('maxInterveningToolCalls must be a non-negative integer')
  }
  const runs = options.runId
    ? [{ runId: options.runId }]
    : (await store.listRuns()).map((r) => ({ runId: r.runId }))

  const findings: StuckLoopFinding[] = []
  for (const { runId } of runs) {
    const tools = await toolSpans(store, runId)
    const orderedTools = tools
      .map((span, sourceIndex) => ({ span, sourceIndex }))
      .sort((a, b) => a.span.startedAt - b.span.startedAt || a.sourceIndex - b.sourceIndex)
      .map(({ span }, toolCallIndex): IndexedToolCall => ({ span, toolCallIndex }))
    const byKey = new Map<string, { calls: IndexedToolCall[]; argHash: string; toolName: string }>()
    for (const call of orderedTools) {
      const h = argHash(call.span.args)
      // NUL delimiter never appears in a tool name or a JSON argHash, so the
      // key cannot collide; toolName is carried in the bucket rather than
      // re-derived by splitting the key (which mislabeled any tool whose name
      // contained the delimiter, e.g. "shell|grep").
      const key = `${call.span.toolName}\u0000${h}`
      const bucket = byKey.get(key) ?? {
        calls: [],
        argHash: h,
        toolName: call.span.toolName,
      }
      bucket.calls.push(call)
      byKey.set(key, bucket)
    }
    for (const { calls, argHash: h, toolName } of byKey.values()) {
      if (calls.length < minOccurrences) continue
      let episodeStart = 0
      for (let episodeEnd = 1; episodeEnd <= calls.length; episodeEnd += 1) {
        const previous = calls[episodeEnd - 1]!
        const next = calls[episodeEnd]
        const episodeEnded =
          next === undefined ||
          next.span.startedAt - previous.span.startedAt > maxWindowMs ||
          next.toolCallIndex - previous.toolCallIndex - 1 > maxInterveningToolCalls
        if (!episodeEnded) continue

        const episode = calls.slice(episodeStart, episodeEnd)
        let left = 0
        let bestStart = 0
        let bestEnd = -1
        for (let right = 0; right < episode.length; right += 1) {
          while (episode[right]!.span.startedAt - episode[left]!.span.startedAt > maxWindowMs) {
            left += 1
          }
          if (right - left > bestEnd - bestStart) {
            bestStart = left
            bestEnd = right
          }
        }
        if (bestEnd - bestStart + 1 >= minOccurrences) {
          const loop = episode.slice(bestStart, bestEnd + 1)
          const first = loop[0]!.span.startedAt
          const last = loop[loop.length - 1]!.span.startedAt
          findings.push({
            runId,
            toolName,
            argHash: h,
            occurrences: loop.length,
            spanIds: loop.map((call) => call.span.spanId),
            windowMs: last - first,
          })
        }
        episodeStart = episodeEnd
      }
    }
  }

  const affectedRuns = new Set(findings.map((f) => f.runId))
  return {
    findings,
    affectedRunRatio: runs.length > 0 ? affectedRuns.size / runs.length : 0,
    totalRuns: runs.length,
  }
}
