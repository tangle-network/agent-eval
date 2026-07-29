import {
  SpanNotFoundError,
  TraceAnalysisStoreContractError,
  TraceAnalysisValidationError,
  TraceNotFoundError,
} from './errors'
import {
  boundOverview,
  boundSpanSearch,
  boundSpansView,
  boundTracePage,
  boundTraceSearch,
  boundTraceView,
  compileSearchRegex,
  resolveTraceBudgets,
} from './store-bounds'
import type {
  BoundedTraceAnalysisStoreOptions,
  TraceAnalysisStore,
  TraceAnalysisStoreContext,
} from './store-contract'
import {
  parseStoreOutput,
  parseTraceInput,
  traceStoreInputSchemas,
  traceStoreOutputSchemas,
} from './store-schemas'

/** Apply the public validation, cancellation, not-found, and size rules to any adapter. */
export function createBoundedTraceAnalysisStore(
  source: TraceAnalysisStore,
  options: BoundedTraceAnalysisStoreOptions = {},
): TraceAnalysisStore {
  const budgets = resolveTraceBudgets(options.budgets)

  return {
    async hasTrace(traceId, context) {
      throwIfAborted(context)
      const { trace_id } = parseTraceInput('hasTrace', traceStoreInputSchemas.hasTrace, {
        trace_id: traceId,
      })
      const result = await source.hasTrace(trace_id, context)
      throwIfAborted(context)
      return parseStoreOutput('hasTrace', traceStoreOutputSchemas.hasTrace, result)
    },

    async hasSpans(input, context) {
      throwIfAborted(context)
      const parsed = parseTraceInput('hasSpans', traceStoreInputSchemas.hasSpans, input)
      assertUniqueIds(parsed.span_ids, 'hasSpans.span_ids')
      const result = await source.hasSpans(parsed, context)
      throwIfAborted(context)
      return validateExistingSpanIds(
        parseStoreOutput('hasSpans', traceStoreOutputSchemas.hasSpans, result),
        parsed.span_ids,
      )
    },

    async getOverview(filters, context) {
      throwIfAborted(context)
      const input = parseTraceInput('getOverview', traceStoreInputSchemas.getOverview, { filters })
      const result = await source.getOverview(input.filters, context)
      throwIfAborted(context)
      return boundOverview(
        parseStoreOutput('getOverview', traceStoreOutputSchemas.getOverview, result),
        budgets.perCallByteCeiling,
      )
    },

    async queryTraces(input, context) {
      throwIfAborted(context)
      const parsed = parseTraceInput('queryTraces', traceStoreInputSchemas.queryTraces, input)
      const offset = parsed.offset ?? 0
      const result = await source.queryTraces({ ...parsed, offset }, context)
      throwIfAborted(context)
      return boundTracePage(
        parseStoreOutput('queryTraces', traceStoreOutputSchemas.queryTraces, result),
        { limit: parsed.limit, offset },
        budgets.perCallByteCeiling,
      )
    },

    async countTraces(filters, context) {
      throwIfAborted(context)
      const input = parseTraceInput('countTraces', traceStoreInputSchemas.countTraces, { filters })
      const result = await source.countTraces(input.filters, context)
      throwIfAborted(context)
      return parseStoreOutput('countTraces', traceStoreOutputSchemas.countTraces, result)
    },

    async viewTrace(input, context) {
      throwIfAborted(context)
      const parsed = parseTraceInput('viewTrace', traceStoreInputSchemas.viewTrace, input)
      await requireTrace(source, parsed.trace_id, context)
      const perAttributeCap = parsed.per_attribute_byte_cap ?? budgets.perAttributeViewBudget
      const result = await source.viewTrace(
        { ...parsed, per_attribute_byte_cap: perAttributeCap },
        context,
      )
      throwIfAborted(context)
      return boundTraceView(
        parseStoreOutput('viewTrace', traceStoreOutputSchemas.viewTrace, result),
        parsed.trace_id,
        perAttributeCap,
        budgets.perCallByteCeiling,
      )
    },

    async viewSpans(input, context) {
      throwIfAborted(context)
      const parsed = parseTraceInput('viewSpans', traceStoreInputSchemas.viewSpans, input)
      assertUniqueIds(parsed.span_ids, 'viewSpans.span_ids')
      await requireTrace(source, parsed.trace_id, context)
      const existingSpanIds = new Set(
        validateExistingSpanIds(
          parseStoreOutput(
            'hasSpans',
            traceStoreOutputSchemas.hasSpans,
            await source.hasSpans(
              { trace_id: parsed.trace_id, span_ids: parsed.span_ids },
              context,
            ),
          ),
          parsed.span_ids,
        ),
      )
      throwIfAborted(context)
      const perAttributeCap = parsed.per_attribute_byte_cap ?? budgets.perAttributeSpanBudget
      const result = await source.viewSpans(
        { ...parsed, per_attribute_byte_cap: perAttributeCap },
        context,
      )
      throwIfAborted(context)
      return boundSpansView(
        parseStoreOutput('viewSpans', traceStoreOutputSchemas.viewSpans, result),
        parsed.trace_id,
        parsed.span_ids,
        existingSpanIds,
        perAttributeCap,
        budgets.perCallByteCeiling,
      )
    },

    async searchTrace(input, context) {
      throwIfAborted(context)
      const parsed = parseTraceInput('searchTrace', traceStoreInputSchemas.searchTrace, input)
      compileSearchRegex(parsed.regex_pattern)
      await requireTrace(source, parsed.trace_id, context)
      const result = await source.searchTrace(parsed, context)
      throwIfAborted(context)
      return boundTraceSearch(
        parseStoreOutput('searchTrace', traceStoreOutputSchemas.searchTrace, result),
        parsed.trace_id,
        parsed.max_matches,
        budgets,
      )
    },

    async searchSpan(input, context) {
      throwIfAborted(context)
      const parsed = parseTraceInput('searchSpan', traceStoreInputSchemas.searchSpan, input)
      compileSearchRegex(parsed.regex_pattern)
      await requireTrace(source, parsed.trace_id, context)
      await requireSpan(source, parsed.trace_id, parsed.span_id, context)
      const result = await source.searchSpan(parsed, context)
      throwIfAborted(context)
      return boundSpanSearch(
        parseStoreOutput('searchSpan', traceStoreOutputSchemas.searchSpan, result),
        parsed.trace_id,
        parsed.span_id,
        parsed.max_matches,
        budgets,
      )
    },
  }
}

async function requireTrace(
  source: TraceAnalysisStore,
  traceId: string,
  context: TraceAnalysisStoreContext | undefined,
): Promise<void> {
  throwIfAborted(context)
  const exists = await source.hasTrace(traceId, context)
  throwIfAborted(context)
  if (!parseStoreOutput('hasTrace', traceStoreOutputSchemas.hasTrace, exists)) {
    throw new TraceNotFoundError(traceId)
  }
}

async function requireSpan(
  source: TraceAnalysisStore,
  traceId: string,
  spanId: string,
  context: TraceAnalysisStoreContext | undefined,
): Promise<void> {
  throwIfAborted(context)
  const existing = await source.hasSpans({ trace_id: traceId, span_ids: [spanId] }, context)
  throwIfAborted(context)
  const found = validateExistingSpanIds(
    parseStoreOutput('hasSpans', traceStoreOutputSchemas.hasSpans, existing),
    [spanId],
  )
  if (found.length === 0) {
    throw new SpanNotFoundError(traceId, spanId)
  }
}

function validateExistingSpanIds(found: readonly string[], requested: readonly string[]): string[] {
  const requestedSet = new Set(requested)
  const seen = new Set<string>()
  for (const id of found) {
    if (!requestedSet.has(id)) {
      throw new TraceAnalysisStoreContractError(
        'hasSpans',
        `hasSpans returned unrequested span id ${JSON.stringify(id)}`,
      )
    }
    if (seen.has(id)) {
      throw new TraceAnalysisStoreContractError(
        'hasSpans',
        `hasSpans returned duplicate span id ${JSON.stringify(id)}`,
      )
    }
    seen.add(id)
  }
  return [...found]
}

function assertUniqueIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new TraceAnalysisValidationError(`${label} must not contain duplicates`)
  }
}

function throwIfAborted(context: TraceAnalysisStoreContext | undefined): void {
  context?.signal?.throwIfAborted()
}
