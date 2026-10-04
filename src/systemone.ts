import type { Analyst, AnalystContext, AnalystFinding } from './analyst/types'
import type { JudgeConfig, JudgeScore, Scenario } from './campaign/types'
import type { CostReceiptInput, CustomTokenPricing } from './cost-ledger'
import type { EvaluationContext, EvaluationResult, EvaluatorOptions } from './evaluation'
import { asAnalyst, asJudge, createEvaluator } from './evaluation'
import { jsonDocument } from './ledger-core/canonical'
import { weightedComposite } from './statistics'
import type {
  SystemOneQuestions,
  SystemOneRequest,
  SystemOneResult,
  SystemOneState,
} from './systemone-protocol'
import {
  parseSystemOneQuestions,
  parseSystemOneRequest,
  parseSystemOneResult,
  systemOneUsage,
} from './systemone-protocol'
import { contentHash } from './verdict-cache'

export * from './evaluation'
export * from './systemone-protocol'
export * from './systemone-review'

export type SystemOneEvaluate = EvaluatorOptions<SystemOneRequest, unknown>['execute']
export interface SystemOneEvaluatorOptions {
  evaluate: SystemOneEvaluate
  costLedger?: EvaluatorOptions<SystemOneRequest, unknown>['costLedger']
  maximumCharge?: EvaluatorOptions<SystemOneRequest, unknown>['maximumCharge']
  pricing?: CustomTokenPricing
  receipt?: (response: unknown) => CostReceiptInput
  receiptFromError?: (error: Error) => CostReceiptInput | undefined
  /** Optional deployment policy; the protocol adapter does not hardcode model aliases. */
  acceptModel?: (requested: string, served: string) => boolean
}

/** Configure transport once; supply native state, questions, and model on every invocation. */
export function systemOneEvaluator(options: SystemOneEvaluatorOptions) {
  const config = { ...options, pricing: options.pricing && { ...options.pricing } }
  const run = createEvaluator<SystemOneRequest, unknown>({
    execute: (request, context) => config.evaluate(structuredClone(request), context),
    model: (request) => request.model,
    costLedger: config.costLedger,
    maximumCharge: config.maximumCharge,
    receiptFromError: config.receiptFromError,
    receipt:
      config.receipt ??
      ((raw) => {
        const usage = systemOneUsage(raw)
        const { model } = raw as SystemOneResult
        return {
          model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          customTokenPricing: config.pricing,
        }
      }),
    validate: (raw, request) => {
      const result = parseSystemOneResult(raw, request)
      if (config.acceptModel && !config.acceptModel(request.model, result.model)) {
        throw new Error('Evaluation served a model rejected by the caller policy')
      }
    },
  })
  return async <const Q extends SystemOneQuestions>(
    request: SystemOneRequest<Q>,
    context?: EvaluationContext,
  ): Promise<EvaluationResult<SystemOneResult<Q>>> => {
    context?.signal?.throwIfAborted()
    parseSystemOneRequest(request)
    const snapshot = structuredClone(request)
    const result = await run(snapshot, context)
    // The validator checked these exact questions after recording the paid work.
    return { ...result, value: result.value as SystemOneResult<Q> }
  }
}

type Input<A, S extends Scenario> = { artifact: A; scenario: S }
type QuestionSource<I, Q extends SystemOneQuestions> = Q | ((input: I) => Q | Promise<Q>)
export interface SystemOneOptions extends SystemOneEvaluatorOptions {
  model: string
  version: string
  questions: SystemOneQuestions
}
export interface SystemOneJudgeOptions<
  A,
  S extends Scenario = Scenario,
  Q extends SystemOneQuestions = SystemOneQuestions,
> extends SystemOneEvaluatorOptions {
  model: string
  version: string
  questions: QuestionSource<Input<A, S>, Q>
  renderState: (
    input: Input<A, S>,
    context: EvaluationContext,
  ) => SystemOneState | Promise<SystemOneState>
  dimensions?: JudgeConfig<A, S>['dimensions']
  weights?: Record<string, number>
  map?: (value: SystemOneResult<Q>, input: Input<A, S>) => JudgeScore | Promise<JudgeScore>
  record?: (
    result: EvaluationResult<SystemOneResult<Q>>,
    input: Input<A, S>,
  ) => void | Promise<void>
  appliesTo?: (scenario: S) => boolean
}

/** Canonical identity also retains native question/alternative order; dispatch stays untouched. */
function questionIdentity(questions: SystemOneQuestions) {
  return {
    document: jsonDocument(questions),
    order: Object.entries(questions).map(([name, question]) => [
      name,
      question.type === 'choice' ? Object.keys(question.criteria) : null,
    ]),
  }
}

function validateWeights(weights: Record<string, number>, keys: string[]): void {
  if (
    Object.entries(weights).some(
      ([key, weight]) => !keys.includes(key) || !Number.isFinite(weight) || weight < 0,
    ) ||
    Object.values(weights).reduce((sum, weight) => sum + weight, 0) <= 0
  ) {
    throw new TypeError('Invalid judge weights')
  }
}

/** Optional convention. Choice utilities and non-uniform scales belong in an explicit map. */
export function normalizedSystemOneScore(
  result: SystemOneResult,
  weights?: Record<string, number>,
): JudgeScore {
  const dimensions: Record<string, number> = Object.create(null)
  const distribution: NonNullable<JudgeScore['distribution']> = Object.create(null)
  for (const [key, answer] of Object.entries(result.answers)) {
    if (answer.type === 'choice') throw new TypeError('Choice scoring requires an explicit map')
    if (answer.type === 'noul') {
      dimensions[key] = answer.noul
      distribution[key] = [
        { score: 0, probability: 1 - answer.noul },
        { score: 1, probability: answer.noul },
      ]
    } else {
      const scale = Object.keys(answer.legend).length - 1
      dimensions[key] = answer.score / scale
      distribution[key] = Object.entries(answer.probabilities).map(([level, probability]) => ({
        score: Number(level) / scale,
        probability,
      }))
    }
  }
  const effective = weights ?? Object.fromEntries(Object.keys(dimensions).map((key) => [key, 1]))
  validateWeights(effective, Object.keys(dimensions))
  return {
    dimensions,
    composite: weightedComposite({ dims: dimensions, weights: effective }).composite,
    notes: '',
    scoringMethod: 'expectation',
    distribution,
  }
}

/** Convenience around the public evaluator. No domain questions, thresholds, or prose. */
export function systemOneJudge<
  A,
  S extends Scenario = Scenario,
  Q extends SystemOneQuestions = SystemOneQuestions,
>(name: string, options: SystemOneJudgeOptions<A, S, Q>): JudgeConfig<A, S> {
  const config = { ...options }
  const source =
    typeof options.questions === 'function' ? options.questions : structuredClone(options.questions)
  const weights = options.weights && { ...options.weights }
  if (!name.trim() || !options.version.trim()) {
    throw new TypeError('Judge name and version are required')
  }
  if ((typeof source === 'function' || config.map) && !config.dimensions) {
    throw new TypeError('Dynamic questions and custom mappings require stable judge dimensions')
  }
  if (!config.map && typeof source !== 'function') {
    parseSystemOneQuestions(source)
    if (Object.values(source).some((question) => question.type === 'choice')) {
      throw new TypeError(
        'Choice scoring requires an explicit map; labels have no numeric ordering',
      )
    }
    if (weights) validateWeights(weights, Object.keys(source))
  }
  const dimensions =
    config.dimensions ??
    Object.entries(source).map(([key, question]) => ({
      key,
      description: typeof question.instructions === 'string' ? question.instructions : key,
    }))
  const evaluate = systemOneEvaluator(config)
  return asJudge<A, S, SystemOneResult<Q>>({
    name,
    version: contentHash({
      model: config.model,
      version: config.version,
      questions: typeof source === 'function' ? 'dynamic' : questionIdentity(source),
      dimensions,
      // Hash the JSON document: optional undefined fields are absent on the wire.
      ...(weights ? { weights } : {}),
    }),
    dimensions,
    appliesTo: config.appliesTo,
    evaluate: async (input, context = {}) =>
      evaluate(
        {
          model: config.model,
          state: await config.renderState(input, context),
          questions: typeof source === 'function' ? await source(input) : source,
        },
        context,
      ),
    map: config.map ?? ((value) => normalizedSystemOneScore(value, weights)),
    record: config.record,
  })
}

export interface SystemOneAnalystOptions<I, Q extends SystemOneQuestions = SystemOneQuestions>
  extends SystemOneEvaluatorOptions {
  id: string
  description: string
  inputKind: Analyst<I>['inputKind']
  model: string
  version: string
  questions: Q | ((input: I, context: AnalystContext) => Q | Promise<Q>)
  renderState: (input: I, context: AnalystContext) => SystemOneState | Promise<SystemOneState>
  findings: (
    value: SystemOneResult<Q>,
    input: I,
    context: AnalystContext,
  ) => AnalystFinding[] | Promise<AnalystFinding[]>
  record?: (
    result: EvaluationResult<SystemOneResult<Q>>,
    input: I,
    context: AnalystContext,
  ) => void | Promise<void>
}

export function systemOneAnalyst<I, Q extends SystemOneQuestions = SystemOneQuestions>(
  options: SystemOneAnalystOptions<I, Q>,
): Analyst<I> {
  const config = { ...options }
  const source =
    typeof options.questions === 'function' ? options.questions : structuredClone(options.questions)
  if (!config.id.trim() || !config.version.trim() || !config.description.trim()) {
    throw new TypeError('Analyst id, version, and description are required')
  }
  const evaluate = systemOneEvaluator(config)
  return asAnalyst<I, SystemOneResult<Q>>({
    id: config.id,
    description: config.description,
    inputKind: config.inputKind,
    version: contentHash({
      model: config.model,
      version: config.version,
      questions: typeof source === 'function' ? 'dynamic' : questionIdentity(source),
    }),
    cost: { kind: 'llm', models: [config.model] },
    evaluate: async (input, context, analystContext) =>
      evaluate(
        {
          model: config.model,
          state: await config.renderState(input, analystContext),
          questions: typeof source === 'function' ? await source(input, analystContext) : source,
        },
        context,
      ),
    map: config.findings,
    record: config.record,
  })
}
