/**
 * StuckLoopView — detects when an agent calls the same tool with the
 * same (or structurally similar) arguments ≥ N times in a short window.
 *
 * Rationale: agents that loop are the number-one production failure
 * mode on long-horizon flows. The view returns (runId, toolName,
 * argHash, occurrences, windowMs) for each detected loop plus a
 * fraction of runs affected.
 */

import { executionTrackByLane } from '../trace/execution-tracks'
import { argHash } from '../trace/query'
import { isToolSpan, type Span, type ToolSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'

const DEFAULT_MAX_WINDOW_MS = 60_000
const DEFAULT_MAX_INTERVENING_TOOL_CALLS = 0

interface ScopedToolCall {
  span: ToolSpan
  scopeSpanId: string | null
  laneSpanId: string | null
}

interface IndexedToolCall extends ScopedToolCall {
  toolCallIndex: number
  trackId: string
}

export interface StuckLoopFinding {
  runId: string
  toolName: string
  argHash: string
  /** Calls in this episode's densest qualifying interval, not the whole-run total. */
  occurrences: number
  spanIds: string[]
  /** Nearest agent ancestor, or the direct parent when ancestry is incomplete. */
  scopeSpanId?: string
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
    const spans = await store.spans({ runId })
    const spansById = new Map(spans.map((span) => [span.spanId, span]))
    const scopedTools: ScopedToolCall[] = spans
      .filter(isToolSpan)
      .map((span, sourceIndex) => ({ span, sourceIndex }))
      .sort((a, b) => a.span.startedAt - b.span.startedAt || a.sourceIndex - b.sourceIndex)
      .map(({ span }) => ({ span, ...executionScope(span, spansById) }))
    const trackByLane = executionTrackByLane(
      scopedTools.map((call) => {
        const direct = call.laneSpanId === null || call.laneSpanId === call.scopeSpanId
        const timed = direct
          ? call.span
          : call.laneSpanId
            ? spansById.get(call.laneSpanId)
            : undefined
        return {
          key: executionKey(call),
          scopeKey: JSON.stringify(call.scopeSpanId),
          start: timed?.startedAt ?? null,
          end: timed?.endedAt ?? null,
        }
      }),
    )
    const nextToolIndexByTrack = new Map<string, number>()
    const orderedTools: IndexedToolCall[] = scopedTools.map((call) => {
      const trackId = trackByLane.get(executionKey(call))!
      const toolCallIndex = nextToolIndexByTrack.get(trackId) ?? 0
      nextToolIndexByTrack.set(trackId, toolCallIndex + 1)
      return { ...call, toolCallIndex, trackId }
    })
    const byKey = new Map<
      string,
      {
        calls: IndexedToolCall[]
        argHash: string
        toolName: string
        scopeSpanId: string | null
      }
    >()
    for (const call of orderedTools) {
      const h = argHash(call.span.args)
      const key = JSON.stringify([call.trackId, call.span.toolName, h])
      const bucket = byKey.get(key) ?? {
        calls: [],
        argHash: h,
        toolName: call.span.toolName,
        scopeSpanId: call.scopeSpanId,
      }
      bucket.calls.push(call)
      byKey.set(key, bucket)
    }
    for (const { calls, argHash: h, toolName, scopeSpanId } of byKey.values()) {
      if (calls.length < minOccurrences) continue
      let episodeStart = 0
      for (let episodeEnd = 1; episodeEnd <= calls.length; episodeEnd += 1) {
        const previous = calls[episodeEnd - 1]!
        const next = calls[episodeEnd]
        const episodeEnded =
          next === undefined ||
          next.span.startedAt - previous.span.startedAt > maxWindowMs ||
          next.toolCallIndex - previous.toolCallIndex - 1 > maxInterveningToolCalls ||
          !callsAreSerial(previous, next)
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
            ...(scopeSpanId ? { scopeSpanId } : {}),
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

function laneKey(call: Pick<ScopedToolCall, 'scopeSpanId' | 'laneSpanId'>): string {
  return JSON.stringify([call.scopeSpanId, call.laneSpanId])
}

function executionKey(call: ScopedToolCall): string {
  return call.laneSpanId === null || call.laneSpanId === call.scopeSpanId
    ? JSON.stringify([call.scopeSpanId, call.span.spanId])
    : laneKey(call)
}

function executionScope(
  span: ToolSpan,
  spansById: ReadonlyMap<string, Span>,
): { scopeSpanId: string | null; laneSpanId: string | null } {
  const directParent = span.parentSpanId
  if (!directParent) return { scopeSpanId: null, laneSpanId: null }

  let currentId: string | undefined = directParent
  let laneSpanId: string | null = null
  const seen = new Set<string>()
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const current = spansById.get(currentId)
    if (!current) return { scopeSpanId: directParent, laneSpanId: directParent }
    if (current.kind === 'agent') {
      return { scopeSpanId: current.spanId, laneSpanId: laneSpanId ?? current.spanId }
    }
    laneSpanId = current.spanId
    currentId = current.parentSpanId
  }
  return { scopeSpanId: directParent, laneSpanId: directParent }
}

function callsAreSerial(previous: IndexedToolCall, next: IndexedToolCall): boolean {
  return previous.span.endedAt !== undefined && previous.span.endedAt <= next.span.startedAt
}
