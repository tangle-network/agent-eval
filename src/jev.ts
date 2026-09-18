import type { Analyst, AnalystContext, AnalystFinding } from './analyst/types'
import type { JudgeConfig, JudgeScore, Scenario } from './campaign/types'
import type { CostReceiptInput, CustomTokenPricing } from './cost-ledger'
import type { EvaluationContext, EvaluationResult, EvaluatorOptions } from './evaluation'
import { asAnalyst, asJudge, createEvaluator } from './evaluation'
import type { JevQuestions, JevRequest, JevResult, JevState } from './jev-protocol'
import { jevUsage, parseJevRequest, parseJevResult } from './jev-protocol'
import { weightedComposite } from './statistics'
import { contentHash } from './verdict-cache'

export * from './evaluation'
export * from './jev-protocol'

export type JevEvaluate = EvaluatorOptions<JevRequest, unknown>['execute']
export interface JevEvaluatorOptions {
  evaluate: JevEvaluate
  costLedger?: EvaluatorOptions<JevRequest, unknown>['costLedger']
  maximumCharge?: EvaluatorOptions<JevRequest, unknown>['maximumCharge']
  pricing?: CustomTokenPricing
  receipt?: (response: unknown) => CostReceiptInput
  receiptFromError?: (error: Error) => CostReceiptInput | undefined
  /** Optional deployment policy; the protocol adapter does not hardcode model aliases. */
  acceptModel?: (requested: string, served: string) => boolean
}

/** Configure transport once; supply native state, questions, and model on every invocation. */
export function jevEvaluator(options: JevEvaluatorOptions) {
  const config = { ...options, pricing: options.pricing && { ...options.pricing } }
  const run = createEvaluator<JevRequest, unknown>({
    execute: (request, context) => config.evaluate(structuredClone(request), context),
    model: (request) => request.model,
    costLedger: config.costLedger,
    maximumCharge: config.maximumCharge,
    receiptFromError: config.receiptFromError,
    receipt: config.receipt ?? ((raw) => {
      const usage = jevUsage(raw)
      const { model } = raw as JevResult
      return {
        model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        customTokenPricing: config.pricing,
      }
    }),
    validate: (raw, request) => {
      const result = parseJevResult(raw, request)
      if (config.acceptModel && !config.acceptModel(request.model, result.model)) {
        throw new Error('Evaluation served a model rejected by the caller policy')
      }
    },
  })
  return async <const Q extends JevQuestions>(
    request: JevRequest<Q>,
    context?: EvaluationContext,
  ): Promise<EvaluationResult<JevResult<Q>>> => {
    context?.signal?.throwIfAborted()
    parseJevRequest(request)
    const snapshot = structuredClone(request)
    const result = await run(snapshot, context)
    // The validator checked these exact questions after recording the paid work.
    return { ...result, value: result.value as JevResult<Q> }
  }
}

type Input<A, S extends Scenario> = { artifact: A; scenario: S }
type QuestionSource<I, Q extends JevQuestions> = Q | ((input: I) => Q | Promise<Q>)
export interface JevOptions extends JevEvaluatorOptions {
  model: string
  version: string
  questions: JevQuestions
}
export interface JevJudgeOptions<A, S extends Scenario = Scenario, Q extends JevQuestions = JevQuestions>
  extends JevEvaluatorOptions {
  model: string
  version: string
  questions: QuestionSource<Input<A, S>, Q>
  renderState: (input: Input<A, S>) => JevState | Promise<JevState>
  dimensions?: JudgeConfig<A, S>['dimensions']
  weights?: Record<string, number>
  map?: (value: JevResult<Q>, input: Input<A, S>) => JudgeScore | Promise<JudgeScore>
  record?: (result: EvaluationResult<JevResult<Q>>, input: Input<A, S>) => void | Promise<void>
  appliesTo?: (scenario: S) => boolean
}

/** Optional convention. Choice utilities and non-uniform scales belong in an explicit map. */
export function normalizedJevScore(result: JevResult, weights?: Record<string, number>): JudgeScore {
  const dimensions: Record<string, number> = {}
  const distribution: NonNullable<JudgeScore['distribution']> = {}
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.type === 'choice') throw new TypeError('Choice scoring requires an explicit map')
    if (answer.type === 'noul') {
      dimensions[key] = answer.noul
      distribution[key] = [{ score: 0, probability: 1 - answer.noul }, { score: 1, probability: answer.noul }]
    } else {
      const scale = Object.keys(answer.legend).length - 1
      dimensions[key] = answer.score / scale
      distribution[key] = Object.entries(answer.probabilities).map(([level, probability]) => ({
        score: Number(level) / scale, probability,
      }))
    }
  }
  const effective = weights ?? Object.fromEntries(Object.keys(dimensions).map((key) => [key, 1]))
  if (Object.entries(effective).some(([key, weight]) => !Object.hasOwn(dimensions, key) || !Number.isFinite(weight) || weight < 0)
    || Object.values(effective).reduce((sum, weight) => sum + weight, 0) <= 0) {
    throw new TypeError('Invalid judge weights')
  }
  return {
    dimensions,
    composite: weightedComposite({ dims: dimensions, weights: effective }).composite,
    notes: '',
    scoringMethod: 'expectation',
    distribution,
  }
}

/** Convenience around the public evaluator. No domain questions, thresholds, or prose. */
export function jevJudge<A, S extends Scenario = Scenario, Q extends JevQuestions = JevQuestions>(
  name: string,
  options: JevJudgeOptions<A, S, Q>,
): JudgeConfig<A, S> {
  const source = typeof options.questions === 'function' ? options.questions : structuredClone(options.questions)
  const weights = options.weights && { ...options.weights }
  if (!name.trim() || !options.version.trim()) throw new TypeError('Judge name and version are required')
  if (typeof source === 'function' && !options.dimensions) {
    throw new TypeError('Dynamic questions require stable judge dimensions')
  }
  if (!options.map && typeof source !== 'function' && Object.values(source).some((q) => q.type === 'choice')) {
    throw new TypeError('Choice scoring requires an explicit map; labels have no numeric ordering')
  }
  const evaluate = jevEvaluator(options)
  return asJudge({
    name,
    version: contentHash({ model: options.model, version: options.version, questions: typeof source === 'function' ? 'dynamic' : source, weights }),
    dimensions: options.dimensions ?? Object.entries(source).map(([key, q]) => ({
      key, description: typeof q.instructions === 'string' ? q.instructions : key,
    })),
    appliesTo: options.appliesTo,
    evaluate: async (input, context) => evaluate({
      model: options.model,
      state: await options.renderState(input),
      questions: typeof source === 'function' ? await source(input) : source,
    }, context),
    map: options.map ?? ((value) => normalizedJevScore(value, weights)),
    record: options.record,
  })
}

export interface JevAnalystOptions<I, Q extends JevQuestions = JevQuestions> extends JevEvaluatorOptions {
  id: string
  description: string
  inputKind: Analyst<I>['inputKind']
  model: string
  version: string
  questions: Q | ((input: I, context: AnalystContext) => Q | Promise<Q>)
  renderState: (input: I, context: AnalystContext) => JevState | Promise<JevState>
  findings: (value: JevResult<Q>, input: I, context: AnalystContext) => AnalystFinding[] | Promise<AnalystFinding[]>
  record?: (result: EvaluationResult<JevResult<Q>>, input: I, context: AnalystContext) => void | Promise<void>
}

export function jevAnalyst<I, Q extends JevQuestions = JevQuestions>(options: JevAnalystOptions<I, Q>): Analyst<I> {
  const source = typeof options.questions === 'function' ? options.questions : structuredClone(options.questions)
  if (!options.id.trim() || !options.version.trim() || !options.description.trim()) {
    throw new TypeError('Analyst id, version, and description are required')
  }
  const evaluate = jevEvaluator(options)
  return asAnalyst({
    id: options.id,
    description: options.description,
    inputKind: options.inputKind,
    version: contentHash({ model: options.model, version: options.version, questions: typeof source === 'function' ? 'dynamic' : source }),
    cost: { kind: 'llm', models: [options.model] },
    evaluate: async (input, context, analystContext) => evaluate({
      model: options.model,
      state: await options.renderState(input, analystContext),
      questions: typeof source === 'function' ? await source(input, analystContext) : source,
    }, { ...context, costLedger: analystContext.costLedger ?? options.costLedger ?? context?.costLedger }),
    map: options.findings,
    record: options.record,
  })
}
