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
    receipt:
      config.receipt ??
      ((raw) => {
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
export interface JevJudgeOptions<
  A,
  S extends Scenario = Scenario,
  Q extends JevQuestions = JevQuestions,
> extends JevEvaluatorOptions {
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
export function normalizedJevScore(
  result: JevResult,
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
export function jevJudge<A, S extends Scenario = Scenario, Q extends JevQuestions = JevQuestions>(
  name: string,
  options: JevJudgeOptions<A, S, Q>,
): JudgeConfig<A, S> {
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
    parseJevRequest({ model: config.model, state: null, questions: source })
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
  const evaluate = jevEvaluator(config)
  return asJudge<A, S, JevResult<Q>>({
    name,
    version: contentHash({
      model: config.model,
      version: config.version,
      questions: typeof source === 'function' ? 'dynamic' : source,
      dimensions,
      // Omitted rather than undefined: contentHash canonicalizes to RFC 8785, which has no
      // encoding for an absent value, so `weights: undefined` threw
      // `LedgerCanonicalizationError: $.weights is undefined` and every judge that did not
      // pass weights — the documented default — failed to construct.
      ...(weights ? { weights } : {}),
    }),
    dimensions,
    appliesTo: config.appliesTo,
    evaluate: async (input, context) =>
      evaluate(
        {
          model: config.model,
          state: await config.renderState(input),
          questions: typeof source === 'function' ? await source(input) : source,
        },
        context,
      ),
    map: config.map ?? ((value) => normalizedJevScore(value, weights)),
    record: config.record,
  })
}

export interface JevAnalystOptions<I, Q extends JevQuestions = JevQuestions>
  extends JevEvaluatorOptions {
  id: string
  description: string
  inputKind: Analyst<I>['inputKind']
  model: string
  version: string
  questions: Q | ((input: I, context: AnalystContext) => Q | Promise<Q>)
  renderState: (input: I, context: AnalystContext) => JevState | Promise<JevState>
  findings: (
    value: JevResult<Q>,
    input: I,
    context: AnalystContext,
  ) => AnalystFinding[] | Promise<AnalystFinding[]>
  record?: (
    result: EvaluationResult<JevResult<Q>>,
    input: I,
    context: AnalystContext,
  ) => void | Promise<void>
}

export function jevAnalyst<I, Q extends JevQuestions = JevQuestions>(
  options: JevAnalystOptions<I, Q>,
): Analyst<I> {
  const config = { ...options }
  const source =
    typeof options.questions === 'function' ? options.questions : structuredClone(options.questions)
  if (!config.id.trim() || !config.version.trim() || !config.description.trim()) {
    throw new TypeError('Analyst id, version, and description are required')
  }
  const evaluate = jevEvaluator(config)
  return asAnalyst<I, JevResult<Q>>({
    id: config.id,
    description: config.description,
    inputKind: config.inputKind,
    version: contentHash({
      model: config.model,
      version: config.version,
      questions: typeof source === 'function' ? 'dynamic' : source,
    }),
    cost: { kind: 'llm', models: [config.model] },
    evaluate: async (input, context, analystContext) =>
      evaluate(
        {
          model: config.model,
          state: await config.renderState(input, analystContext),
          questions: typeof source === 'function' ? await source(input, analystContext) : source,
        },
        {
          ...context,
          costLedger:
            analystContext.costLedger ??
            (analystContext.budgetUsd === undefined ? config.costLedger : undefined) ??
            context.costLedger,
        },
      ),
    map: config.findings,
    record: config.record,
  })
}
