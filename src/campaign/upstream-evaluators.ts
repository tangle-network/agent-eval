


export interface PhoenixEvaluationResultLike {
  score?: number
  label?: string
  explanation?: string
}

export interface PhoenixEvaluatorLike<TRecord extends Record<string, unknown>> {
  name: string
  kind: 'LLM' | 'CODE'
  optimizationDirection?: 'MAXIMIZE' | 'MINIMIZE' | 'NEUTRAL'
  evaluate(
    record: TRecord,
    context: UpstreamEvaluationContext,
  ): Promise<PhoenixEvaluationResultLike>
}

export interface AutoevalsScoreLike {
  name: string
  score: number | null
  metadata?: Record<string, unknown>
}

export type AutoevalsScorerLike<TInput extends Record<string, unknown>> = (
  input: TInput,
  context: UpstreamEvaluationContext,
) => AutoevalsScoreLike | Promise<AutoevalsScoreLike>

interface UpstreamEvaluationContext {
  readonly signal: AbortSignal
  readonly callId?: string
}
















