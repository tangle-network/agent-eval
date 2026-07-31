/**
 * Canonical transport-neutral trace tools. Schemas and handlers originate
 * here; recursive engines only translate calls across their process boundary.
 */

import type { EvalToolDef } from '../eval-tools'
import {
  type BoundedTraceAnalysisStoreOptions,
  createBoundedTraceAnalysisStore,
  TRACE_ANALYSIS_LIMITS,
  type TraceAnalysisStore,
} from './store'
import { parseTraceInput, toTraceJsonSchema, traceStoreInputSchemas } from './store-schemas'

export const TRACE_ANALYST_TOOL_NAMESPACE = 'traces' as const

export interface BuildTraceAnalysisToolsOptions extends BoundedTraceAnalysisStoreOptions {
  store: TraceAnalysisStore
}

export interface TraceAnalysisToolDescriptor extends EvalToolDef {
  namespace: typeof TRACE_ANALYST_TOOL_NAMESPACE
}

/** Bind all seven trace reads without exposing an agent framework type. */
export function buildTraceAnalysisToolDescriptors(
  options: BuildTraceAnalysisToolsOptions,
): TraceAnalysisToolDescriptor[] {
  const store = createBoundedTraceAnalysisStore(options.store, { budgets: options.budgets })

  return [
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'getDatasetOverview',
      description:
        'Dataset rollup: total traces, raw_jsonl_bytes, services, agents, models, tools, ' +
        'and sample_trace_ids. Always call this first without a regex_pattern.',
      parameters: toTraceJsonSchema(traceStoreInputSchemas.getOverview),
      handler: async (args, context) => {
        const { filters } = parseTraceInput(
          'getDatasetOverview',
          traceStoreInputSchemas.getOverview,
          args ?? {},
        )
        return store.getOverview(filters, context)
      },
    },
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'queryTraces',
      description:
        `Paginated trace summaries, at most ${TRACE_ANALYSIS_LIMITS.queryTraces} per call. ` +
        'Each summary carries raw_jsonl_bytes; narrow with indexed filters before regex_pattern.',
      parameters: toTraceJsonSchema(traceStoreInputSchemas.queryTraces),
      handler: async (args, context) => {
        const input = parseTraceInput('queryTraces', traceStoreInputSchemas.queryTraces, args)
        return store.queryTraces(input, context)
      },
    },
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'countTraces',
      description:
        'Count traces matching filters. Use as a cheap pre-flight before a regex_pattern scan.',
      parameters: toTraceJsonSchema(traceStoreInputSchemas.countTraces),
      handler: async (args, context) => {
        const { filters } = parseTraceInput(
          'countTraces',
          traceStoreInputSchemas.countTraces,
          args ?? {},
        )
        return store.countTraces(filters, context)
      },
    },
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'viewTrace',
      description:
        'Return all spans for one trace with bounded attributes. Oversized responses carry ' +
        'an oversized summary instead of spans; continue with searchTrace or viewSpans.',
      parameters: toTraceJsonSchema(
        traceStoreInputSchemas.viewTrace.omit({
          per_attribute_byte_cap: true,
        }),
      ),
      handler: async (args, context) => {
        const input = parseTraceInput(
          'viewTrace',
          traceStoreInputSchemas.viewTrace.omit({ per_attribute_byte_cap: true }),
          args,
        )
        return store.viewTrace(input, context)
      },
    },
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'viewSpans',
      description:
        `Read 1..${TRACE_ANALYSIS_LIMITS.viewSpans} specific spans. Every requested id is ` +
        'accounted for in spans, missing_span_ids, or omitted_span_ids; retry omitted ids.',
      parameters: toTraceJsonSchema(
        traceStoreInputSchemas.viewSpans.omit({
          per_attribute_byte_cap: true,
        }),
      ),
      handler: async (args, context) => {
        const input = parseTraceInput(
          'viewSpans',
          traceStoreInputSchemas.viewSpans.omit({ per_attribute_byte_cap: true }),
          args,
        )
        return store.viewSpans(input, context)
      },
    },
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'searchTrace',
      description:
        `Regex search across one trace, bounded to ${TRACE_ANALYSIS_LIMITS.searchMatches} hits. ` +
        'When has_more is true, refine the regex instead of treating the result as complete.',
      parameters: toTraceJsonSchema(traceStoreInputSchemas.searchTrace),
      handler: async (args, context) => {
        const input = parseTraceInput('searchTrace', traceStoreInputSchemas.searchTrace, args)
        return store.searchTrace(input, context)
      },
    },
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'searchSpan',
      description:
        `Regex search inside one span, bounded to ${TRACE_ANALYSIS_LIMITS.searchMatches} hits. ` +
        'Use after viewSpans omits or truncates a large span payload.',
      parameters: toTraceJsonSchema(traceStoreInputSchemas.searchSpan),
      handler: async (args, context) => {
        const input = parseTraceInput('searchSpan', traceStoreInputSchemas.searchSpan, args)
        return store.searchSpan(input, context)
      },
    },
  ]
}

export function traceAnalystFunctionGroup(options: BuildTraceAnalysisToolsOptions): {
  namespace: string
  title: string
  selectionCriteria: string
  description: string
  functions: TraceAnalysisToolDescriptor[]
} {
  return {
    namespace: TRACE_ANALYST_TOOL_NAMESPACE,
    title: 'Trace Analysis',
    selectionCriteria: 'Use for any inspection of OTLP-shaped trace data.',
    description:
      'Discovery, narrowing, and bounded deep reads over a JSONL trace dataset. ' +
      'Always call getDatasetOverview first.',
    functions: buildTraceAnalysisToolDescriptors(options),
  }
}
