import type { Analyst, AnalystContext, AnalystFinding, AnalystInputKind } from './analyst/types'
import type { JudgeConfig, JudgeScore, Scenario } from './campaign/types'
import { CostLedger } from './cost-ledger'
import type { CostLedgerHandle, CostReceipt, CostReceiptInput, CustomTokenPricing, MaximumCharge } from './cost-ledger'
import { weightedComposite } from './statistics'
import { contentHash } from './verdict-cache'

/** Native TypeSafe wire shapes. Inject the official SDK; no chat emulation or SDK dependency. */
export type JevState = string | Record<string, unknown> | unknown[]
export type JevQuestion =
  | { type: 'noul'; instructions: JevState; criteria?: { true?: string; false?: string } }
  | { type: 'score'; instructions: JevState; criteria: string[] }
  | { type: 'choice'; instructions: JevState; criteria: Record<string, string | null> }
export interface JevRequest {
  model: string
  state: JevState
  questions: Record<string, JevQuestion>
}
export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; legend: Record<string, string>; probabilities: Record<string, number> }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevResult {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}
export type JevEvaluate = (
  request: JevRequest,
  context: { signal: AbortSignal; idempotencyKey: string },
) => Promise<unknown>

export class JevResponseError extends Error {
  constructor(message: string) {
    super(`Jev: ${message}`)
    this.name = 'JevResponseError'
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JevResponseError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}
function probability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevResponseError(`${label} must be a probability`)
  }
  return value
}
function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new JevResponseError(`${label} does not match the request`)
  }
}
function usageOf(raw: unknown): JevResult['usage'] {
  const usage = object(object(raw, 'response').usage, 'usage')
  for (const key of ['input_tokens', 'output_tokens']) {
    if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) {
      throw new JevResponseError(`missing or invalid ${key}`)
    }
  }
  return usage as unknown as JevResult['usage']
}

/** Runtime validation is intentional: the SDK's inferred return type is not a wire validator. */
export function parseJevResult(raw: unknown, request: JevRequest): JevResult {
  const value = object(raw, 'response')
  if (typeof value.model !== 'string' || !value.model.trim()) throw new JevResponseError('missing served model')
  const alias = request.model === 'jev-latest' || request.model === 'jev-preview'
  if (!alias && value.model !== request.model) throw new JevResponseError('served model differs from pinned model')
  const answers = object(value.answers, 'answers')
  exactKeys(answers, Object.keys(request.questions), 'answers')
  for (const [key, question] of Object.entries(request.questions)) {
    const answer = object(answers[key], `answer ${key}`)
    if (answer.type !== question.type) throw new JevResponseError(`answer ${key} has the wrong type`)
    if (question.type === 'noul') {
      probability(answer.noul, key)
      continue
    }
    probability(answer.confidence, `${key}.confidence`)
    const levels = question.type === 'score'
      ? question.criteria.map((_, index) => String(index))
      : Object.keys(question.criteria)
    const probabilities = object(answer.probabilities, `${key}.probabilities`)
    exactKeys(probabilities, levels, `${key}.probabilities`)
    const sum = levels.reduce((total, level) => total + probability(probabilities[level], `${key}.${level}`), 0)
    if (Math.abs(sum - 1) > 0.0001) throw new JevResponseError(`${key} probabilities do not sum to one`)
    if (question.type === 'score') {
      const legend = object(answer.legend, `${key}.legend`)
      exactKeys(legend, levels, `${key}.legend`)
      if (levels.some((level) => legend[level] !== question.criteria[Number(level)])) {
        throw new JevResponseError(`${key} legend differs from rubric`)
      }
      const expected = levels.reduce((total, level) => total + Number(level) * (probabilities[level] as number), 0)
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || Math.abs(answer.score - expected) > 0.0001) {
        throw new JevResponseError(`${key} score differs from its distribution`)
      }
    } else if (typeof answer.choice !== 'string' || !Object.hasOwn(probabilities, answer.choice)
      || levels.some((level) => (probabilities[level] as number) > (probabilities[answer.choice as string] as number) + 0.0001)) {
      throw new JevResponseError(`${key} choice is not a highest-probability option`)
    }
  }
  usageOf(raw)
  return raw as JevResult
}

export interface JevOptions {
  evaluate: JevEvaluate
  model: string
  questions: Record<string, JevQuestion>
  /** Revision of opaque renderer, transport, and policy configuration. */
  version: string
  costLedger?: CostLedgerHandle
  maximumCharge?: MaximumCharge
  /** Optional local rates are estimates, never reported as a provider receipt. */
  pricing?: CustomTokenPricing
  receipt?: (response: unknown) => CostReceiptInput
  receiptFromError?: (error: Error) => CostReceiptInput | undefined
}

function snapshot(options: JevOptions): JevOptions {
  if (!options.model.trim() || !options.version.trim()) throw new TypeError('Jev requires a model and version')
  const questions = structuredClone(options.questions)
  if (Object.keys(questions).length === 0) throw new TypeError('Jev requires at least one question')
  for (const [key, question] of Object.entries(questions)) {
    if (!key.trim() || question.instructions == null) throw new TypeError('Jev requires named questions with instructions')
    if (question.type === 'score' && (question.criteria.length < 2 || question.criteria.some((level) => typeof level !== 'string'))) {
      throw new TypeError(`Jev score ${key} requires at least two rubric levels`)
    }
    if (question.type === 'choice' && Object.keys(question.criteria).length < 2) {
      throw new TypeError(`Jev choice ${key} requires at least two options`)
    }
  }
  return { ...options, questions, pricing: options.pricing && { ...options.pricing } }
}

async function paidEvaluation(
  options: JevOptions,
  state: JevState,
  context: { ledger: CostLedgerHandle; signal?: AbortSignal; actor: string; channel: 'judge' | 'analyst'; phase: string; tags?: Record<string, string> },
): Promise<{ result: JevResult; receipt: CostReceipt }> {
  const request = { model: options.model, state, questions: structuredClone(options.questions) }
  const paid = await context.ledger.runPaidCall({
    actor: context.actor,
    channel: context.channel,
    phase: context.phase,
    tags: context.tags,
    model: options.model,
    signal: context.signal,
    maximumCharge: options.maximumCharge,
    execute: (signal, idempotencyKey) => options.evaluate(request, { signal, idempotencyKey }),
    receipt: options.receipt ?? ((raw) => {
      const usage = usageOf(raw)
      const response = object(raw, 'response')
      return {
        model: typeof response.model === 'string' ? response.model : options.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        customTokenPricing: options.pricing,
      }
    }),
    receiptFromError: options.receiptFromError,
  })
  if (!paid.succeeded) throw paid.error
  // Settle the paid work even when its answers fail validation.
  return { result: parseJevResult(paid.value, request), receipt: paid.receipt }
}

export interface JevJudgeOptions<TArtifact, TScenario extends Scenario = Scenario> extends JevOptions {
  renderState: (input: { artifact: TArtifact; scenario: TScenario }) => JevState
  weights?: Record<string, number>
  appliesTo?: (scenario: TScenario) => boolean
}

/** One native evaluation becomes one canonical campaign judge, usable by existing optimizers. */
export function jevJudge<TArtifact, TScenario extends Scenario = Scenario>(
  name: string,
  options: JevJudgeOptions<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario> {
  if (!name.trim()) throw new TypeError('Jev judge requires a name')
  const config = snapshot(options)
  const weights = options.weights && { ...options.weights }
  const keys = Object.keys(config.questions)
  if (keys.some((key) => config.questions[key].type === 'choice')) throw new TypeError('Jev judges accept score or noul questions; choices have no numeric ordering')
  if (weights && (Object.keys(weights).some((key) => !keys.includes(key) || !Number.isFinite(weights[key]) || weights[key] < 0)
    || Object.values(weights).reduce((sum, weight) => sum + weight, 0) <= 0)) throw new TypeError('Invalid Jev judge weights')
  const ledger = config.costLedger ?? new CostLedger()
  const render = options.renderState
  return {
    name,
    dimensions: keys.map((key) => ({ key, description: JSON.stringify(config.questions[key].instructions) })),
    judgeVersion: contentHash({ kind: 'jev', model: config.model, questions: config.questions, version: config.version, weights }),
    appliesTo: options.appliesTo,
    async score({ artifact, scenario, signal, costLedger, costPhase, costTags }): Promise<JudgeScore> {
      const { result, receipt } = await paidEvaluation(config, render({ artifact, scenario }), {
        ledger: costLedger ?? ledger, signal, actor: name, channel: 'judge', phase: costPhase ?? 'judge',
        tags: { ...costTags, scenarioId: scenario.id },
      })
      const entries = keys.map((key) => {
        const answer = result.answers[key]
        if (answer.type === 'choice') throw new JevResponseError('choice cannot be scored')
        const scale = answer.type === 'score' ? Object.keys(answer.legend).length - 1 : 1
        const distribution = answer.type === 'noul'
          ? [{ score: 0, probability: 1 - answer.noul }, { score: 1, probability: answer.noul }]
          : Object.entries(answer.probabilities).map(([level, probability]) => ({ score: Number(level) / scale, probability }))
        return { key, value: answer.type === 'noul' ? answer.noul : answer.score / scale, distribution }
      })
      const dimensions = Object.fromEntries(entries.map(({ key, value }) => [key, value]))
      return {
        dimensions,
        composite: weightedComposite(dimensions, weights),
        notes: `Jev ${result.model}; rubric expectation, not an independent explanation or calibrated correctness probability.`,
        scoringMethod: 'expectation',
        distribution: Object.fromEntries(entries.map(({ key, distribution }) => [key, distribution])),
        llmCall: {
          model: result.model,
          usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
          ...(receipt.actualCostUsd === undefined ? {} : { costUsd: receipt.actualCostUsd }),
        },
      }
    },
  }
}

export interface JevAnalystOptions<TInput> extends JevOptions {
  id: string
  description: string
  inputKind: AnalystInputKind
  /** Caller owns trace selection, redaction, and context bounds; no silent truncation. */
  renderState: (input: TInput, context: AnalystContext) => JevState | Promise<JevState>
  /** Map evaluated questions to existing evidence-backed findings, not generated rationales. */
  findings: (result: JevResult, input: TInput, context: AnalystContext) => AnalystFinding[]
}

/** Works with the existing AnalystRegistry and graph analyst adapters; no second scheduler. */
export function jevAnalyst<TInput>(options: JevAnalystOptions<TInput>): Analyst<TInput> {
  const config = snapshot(options)
  if (!options.id.trim() || !options.description.trim()) throw new TypeError('Jev analyst requires id and description')
  const render = options.renderState
  const findings = options.findings
  return {
    id: options.id,
    description: options.description,
    inputKind: options.inputKind,
    version: contentHash({ version: config.version, model: config.model, questions: config.questions }),
    cost: { kind: 'llm', models: [config.model] },
    async analyze(input, context) {
      const ledger = context.costLedger ?? config.costLedger ?? new CostLedger({ costCeilingUsd: context.budgetUsd })
      const signals = [context.signal]
      if (context.deadlineMs !== undefined) signals.push(AbortSignal.timeout(Math.max(0, Math.ceil(context.deadlineMs - Date.now()))))
      const signal = AbortSignal.any(signals.filter((value): value is AbortSignal => value !== undefined))
      signal.throwIfAborted()
      const { result, receipt } = await paidEvaluation(config, await render(input, context), {
        ledger, signal, actor: options.id, channel: 'analyst', phase: context.costPhase ?? 'analyst',
        tags: { ...context.tags, runId: context.runId, correlationId: context.correlationId },
      })
      context.recordUsage?.({
        calls: 1,
        tokens: { input: receipt.inputTokens, output: receipt.outputTokens },
        cost: receipt.costUnknown ? { kind: 'uncaptured', usd: null }
          : { kind: receipt.actualCostUsd === undefined ? 'estimated' : 'observed', usd: receipt.costUsd },
      })
      return findings(result, input, context)
    },
  }
}
