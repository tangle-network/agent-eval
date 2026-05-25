/**
 * Traced judge wrappers — instruments every LLM call inside the judge
 * ensemble with child spans so OTEL sinks see per-judge latency, model,
 * token counts, and score dimensions.
 *
 * The ensemble parent span groups all individual judge spans; each judge
 * gets its own child span with model + score as attributes.
 */

import type { TCloud } from '@tangle-network/tcloud'
import type { TraceEmitter } from './trace/emitter'
import type { JudgeFn, JudgeInput, JudgeScore } from './types'

export interface TracedJudgeOptions {
  /** TraceEmitter to emit spans into. */
  emitter: TraceEmitter
  /** Parent span id for the ensemble. If omitted, uses the emitter stack. */
  parentSpanId?: string
}

/**
 * Wrap a single JudgeFn so its LLM call emits a traced span.
 */
export function traceJudge(judge: JudgeFn, judgeName: string, opts: TracedJudgeOptions): JudgeFn {
  return async (tc: TCloud, input: JudgeInput): Promise<JudgeScore[]> => {
    const span = await opts.emitter.span({
      kind: 'llm',
      name: `judge:${judgeName}`,
      parentSpanId: opts.parentSpanId,
      attributes: {
        'judge.name': judgeName,
        'eval.phase': 'judge',
      },
    })
    try {
      const scores = await judge(tc, input)
      const composite =
        scores.length > 0 ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length : 0
      await span.end({
        attributes: {
          'judge.name': judgeName,
          'judge.composite_score': composite,
          'judge.dimension_count': scores.length,
          'eval.phase': 'judge',
        },
      } as Record<string, unknown>)
      return scores
    } catch (err) {
      await span.fail(err instanceof Error ? err : String(err))
      throw err
    }
  }
}

/**
 * Wrap an array of JudgeFns with tracing, running them inside an ensemble
 * parent span. Returns a single function that calls all judges and merges
 * their scores.
 */
export function traceJudgeEnsemble(
  judges: JudgeFn[],
  judgeNames: string[],
  opts: TracedJudgeOptions,
): JudgeFn {
  return async (tc: TCloud, input: JudgeInput) => {
    const ensembleSpan = await opts.emitter.span({
      kind: 'custom',
      name: 'judge:ensemble',
      parentSpanId: opts.parentSpanId,
      attributes: {
        'judge.ensemble_size': judges.length,
        'eval.phase': 'judge',
      },
    })
    try {
      const allScores: JudgeScore[] = []
      for (let i = 0; i < judges.length; i++) {
        const judge = judges[i]!
        const name = judgeNames[i] ?? `judge_${i}`
        const tracedFn = traceJudge(judge, name, {
          emitter: opts.emitter,
          parentSpanId: ensembleSpan.span.spanId,
        })
        const scores = await tracedFn(tc, input)
        allScores.push(...scores)
      }
      const composite =
        allScores.length > 0 ? allScores.reduce((sum, s) => sum + s.score, 0) / allScores.length : 0
      await ensembleSpan.end({
        attributes: {
          'judge.ensemble_size': judges.length,
          'judge.composite_score': composite,
          'judge.total_dimensions': allScores.length,
          'eval.phase': 'judge',
        },
      } as Record<string, unknown>)
      return allScores
    } catch (err) {
      await ensembleSpan.fail(err instanceof Error ? err : String(err))
      throw err
    }
  }
}
