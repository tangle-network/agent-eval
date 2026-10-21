import type { SpanIndexEntry } from './store-otlp-buffered'
import type { ErrorCluster } from './types'

// ─── Error-cluster extraction ────────────────────────────────────────
//
// Deterministic failure-coverage population. The error-span loop in
// getOverview already visits every ERROR span; bucketing them by a
// normalized status_message signature turns "N error spans" into "K
// distinct failure modes" — the checklist an analyst must close. No LLM.

const ERROR_CLUSTER_EXEMPLARS = 5

export interface ErrorClusterAccumulator {
  signature: string
  sample: string
  traceIds: Set<string>
  spanIds: string[]
  spanCount: number
  spanNames: Map<string, number>
  toolNames: Map<string, number>
}

/** Collapse volatile tokens so semantically identical failures share a key:
 *  hex/uuid ids → <id>, numbers → #, quoted/abs paths → <path>, durations →
 *  <dur>, whitespace collapsed. Empty/absent messages fall back to the span
 *  name so a no-message error still forms a real cluster. */
function normalizeErrorSignature(message: string | undefined, spanName: string): string {
  const raw = (message ?? '').trim()
  const base = raw.length > 0 ? raw : `(${spanName || 'error'} — no message)`
  const norm = base
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/(?:\/[\w.\-@]+){2,}/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?(ms|s|m|h|kb|mb|gb)?\b/gi, (_m, u) => (u ? `#${u}` : '#'))
    .replace(/\s+/g, ' ')
    .trim()
  return norm
}

function bump(map: Map<string, number>, key: string | null): void {
  if (!key) return
  map.set(key, (map.get(key) ?? 0) + 1)
}

function topKey(map: Map<string, number>): string | null {
  let best: string | null = null
  let bestN = 0
  for (const [k, n] of map)
    if (n > bestN) {
      best = k
      bestN = n
    }
  return best
}

export function accumulateErrorCluster(
  clusters: Map<string, ErrorClusterAccumulator>,
  traceId: string,
  span: SpanIndexEntry,
): void {
  const signature = normalizeErrorSignature(span.status_message, span.name)
  let acc = clusters.get(signature)
  if (!acc) {
    acc = {
      signature,
      sample: span.status_message ?? span.name ?? '',
      traceIds: new Set(),
      spanIds: [],
      spanCount: 0,
      spanNames: new Map(),
      toolNames: new Map(),
    }
    clusters.set(signature, acc)
  }
  acc.traceIds.add(traceId)
  acc.spanCount += 1
  if (acc.spanIds.length < ERROR_CLUSTER_EXEMPLARS && !acc.spanIds.includes(span.span_id)) {
    acc.spanIds.push(span.span_id)
  }
  bump(acc.spanNames, span.name)
  bump(acc.toolNames, span.tool_name)
}

export function finalizeErrorClusters(
  clusters: Map<string, ErrorClusterAccumulator>,
  errorTraceCount: number,
): ErrorCluster[] {
  const out = [...clusters.values()].map(
    (acc): ErrorCluster => ({
      signature: acc.signature,
      status_message_sample: acc.sample,
      span_name: topKey(acc.spanNames),
      tool_name: topKey(acc.toolNames),
      trace_count: acc.traceIds.size,
      span_count: acc.spanCount,
      prevalence: errorTraceCount > 0 ? acc.traceIds.size / errorTraceCount : 0,
      exemplar_trace_ids: [...acc.traceIds].slice(0, ERROR_CLUSTER_EXEMPLARS),
      exemplar_span_ids: acc.spanIds.slice(0, ERROR_CLUSTER_EXEMPLARS),
    }),
  )
  out.sort((a, b) => b.trace_count - a.trace_count || b.span_count - a.span_count)
  return out
}
