/**
 * Traced analyst wrapper — instruments `analyzeTraces` with spans so the
 * analyst's internal model turns appear in the trace tree. Also wraps each
 * actor turn callback with a span.
 *
 * The wrapper records the Ax turn loop at its public boundaries:
 *   1. A parent span for the entire analyst run.
 *   2. Per-turn child spans from the `onTurn` callback (captures code,
 *      output size, error status).
 *   3. Summary attributes on the parent (total turns, usage, findings).
 */

import type { TraceEmitter } from './trace/emitter'
import type {
  AnalyzeTracesInput,
  AnalyzeTracesOptions,
  AnalyzeTracesResult,
  AnalyzeTracesTurnSnapshot,
} from './trace-analyst/analyst'
import { analyzeTraces } from './trace-analyst/analyst'

export interface TracedAnalystOptions {
  /** TraceEmitter for span emission. */
  emitter: TraceEmitter
  /** Parent span id. If omitted, uses emitter stack. */
  parentSpanId?: string
}

/**
 * Run `analyzeTraces` wrapped in a parent span with per-turn child spans.
 */
export async function tracedAnalyzeTraces(
  input: AnalyzeTracesInput,
  options: AnalyzeTracesOptions,
  traceOpts: TracedAnalystOptions,
): Promise<AnalyzeTracesResult> {
  const parentSpan = await traceOpts.emitter.span({
    kind: 'custom',
    name: 'analyst:analyze-traces',
    parentSpanId: traceOpts.parentSpanId,
    attributes: {
      'analyst.question_length': input.question.length,
      'analyst.max_turns': options.maxTurns ?? 12,
      'analyst.max_subqueries': options.maxSubqueries ?? 4,
      'eval.phase': 'analyst',
    },
  })

  // Intercept onTurn to emit per-turn spans.
  const originalOnTurn = options.onTurn
  const wrappedOptions: AnalyzeTracesOptions = {
    ...options,
    onTurn: async (turn: AnalyzeTracesTurnSnapshot) => {
      const turnSpan = await traceOpts.emitter.span({
        kind: 'custom',
        name: `analyst:turn-${turn.turn}`,
        parentSpanId: parentSpan.span.spanId,
        attributes: {
          'analyst.stage': turn.stage,
          'analyst.turn': turn.turn,
          'analyst.is_error': turn.isError,
          'analyst.code_length': turn.code.length,
          'analyst.output_length': turn.output.length,
          'eval.phase': 'analyst',
        },
      })
      if (turn.isError) {
        await turnSpan.fail('Turn produced an error')
      } else {
        await turnSpan.end()
      }
      if (originalOnTurn) await originalOnTurn(turn)
    },
  }

  try {
    const result = await analyzeTraces(input, wrappedOptions)
    await parentSpan.end({
      attributes: {
        'analyst.question_length': input.question.length,
        'analyst.turn_count': result.turnCount,
        'analyst.finding_count': result.findings.length,
        'analyst.answer_length': result.answer.length,
        'eval.phase': 'analyst',
      },
    } as Record<string, unknown>)
    return result
  } catch (err) {
    await parentSpan.fail(err instanceof Error ? err : String(err))
    throw err
  }
}
