/**
 * Pre-curated tool subsets for analyst kinds.
 *
 * The full trace-analyst tool set is seven functions. Most kinds only
 * need three or four. Picking from named groups instead of importing
 * the whole bundle keeps every kind's actor-context budget tight and
 * makes "what can this analyst see?" obvious at registration time.
 *
 * Each function in the group keeps its full `name`/`description` from
 * `buildTraceAnalystTools` — we filter, we don't re-implement.
 */

import type { AxFunction } from '@ax-llm/ax'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { buildTraceAnalystTools } from '../trace-analyst/tools'

/** Named tool sets. Kinds pass `tools: TRACE_TOOL_GROUPS.failureForensics` etc. */
export type TraceToolGroupName =
  /** All seven tools. Use for open-ended discovery kinds. */
  | 'all'
  /** Overview + paginated query + count. No deep reads. Cheap. */
  | 'discovery'
  /** Discovery + viewTrace + viewSpans. Deep-read but no regex search. */
  | 'discoveryAndRead'
  /** Discovery + search tools. For pattern-matching across many traces. */
  | 'discoveryAndSearch'
  /** Discovery + viewSpans + searchSpan. Targeted-span work after another kind narrows down. */
  | 'targeted'

const TOOL_NAMES_BY_GROUP: Record<TraceToolGroupName, ReadonlySet<string>> = {
  all: new Set(),
  discovery: new Set(['getDatasetOverview', 'queryTraces', 'countTraces']),
  discoveryAndRead: new Set([
    'getDatasetOverview',
    'queryTraces',
    'countTraces',
    'viewTrace',
    'viewSpans',
  ]),
  discoveryAndSearch: new Set([
    'getDatasetOverview',
    'queryTraces',
    'countTraces',
    'searchTrace',
    'searchSpan',
  ]),
  targeted: new Set(['getDatasetOverview', 'queryTraces', 'viewSpans', 'searchSpan']),
}

/**
 * Build the tool set for a named group bound to a specific trace store.
 *
 * `all` returns every tool. Other groups filter `buildTraceAnalystTools`
 * by name to the documented subset. An unrecognised group name throws —
 * silently returning all tools would defeat the cost-control point.
 */
export function buildTraceToolsForGroup(
  group: TraceToolGroupName,
  store: TraceAnalysisStore,
): AxFunction[] {
  const all = buildTraceAnalystTools({ store })
  if (group === 'all') return all
  const allow = TOOL_NAMES_BY_GROUP[group]
  if (!allow) throw new Error(`unknown trace tool group: ${group}`)
  return all.filter((tool) => allow.has((tool as { name: string }).name))
}
