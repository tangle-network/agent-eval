import type { TraceEmitter } from './trace/emitter'
import {
  type AnalyzeTracesInput,
  type AnalyzeTracesOptions,
  type AnalyzeTracesResult,
  analyzeTraces,
} from './trace-analyst/analyst'

export interface TracedAnalystOptions {
  emitter: TraceEmitter
  parentSpanId?: string
}

/** Run a recursive trace investigation and record its engine steps. */
export async function tracedAnalyzeTraces(
  input: AnalyzeTracesInput,
  options: AnalyzeTracesOptions,
  traceOptions: TracedAnalystOptions,
): Promise<AnalyzeTracesResult> {
  const parentSpan = await traceOptions.emitter.span({
    kind: 'custom',
    name: 'analyst:analyze-traces',
    parentSpanId: traceOptions.parentSpanId,
    attributes: {
      'analyst.engine': options.engine.id,
      'analyst.question_length': input.question.length,
      'analyst.max_iterations': options.limits?.maxIterations ?? 12,
      'analyst.max_llm_calls': options.limits?.maxLlmCalls ?? 8,
      'eval.phase': 'analyst',
    },
  })

  try {
    const result = await analyzeTraces(input, options)
    for (const [index, step] of result.trajectory.entries()) {
      const encoded = JSON.stringify(step)
      const stepSpan = await traceOptions.emitter.span({
        kind: 'custom',
        name: `analyst:step-${index + 1}`,
        parentSpanId: parentSpan.span.spanId,
        attributes: {
          'analyst.step': index + 1,
          'analyst.step_bytes': Buffer.byteLength(encoded),
          'eval.phase': 'analyst',
        },
      })
      await stepSpan.end()
    }
    await parentSpan.end({
      attributes: {
        'analyst.engine': options.engine.id,
        'analyst.model_calls': result.modelCalls,
        'analyst.tool_calls': result.toolCalls,
        'analyst.step_count': result.trajectory.length,
        'analyst.finding_count': result.findings.length,
        'analyst.answer_length': result.answer.length,
        'eval.phase': 'analyst',
      },
    } as Record<string, unknown>)
    return result
  } catch (error) {
    await parentSpan.fail(error instanceof Error ? error : String(error))
    throw error
  }
}
