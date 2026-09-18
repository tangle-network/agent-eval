import type { Analyst, AnalystContext, AnalystFinding, AnalystInputKind } from './analyst/types'
import type { JudgeConfig, JudgeScore, Scenario } from './campaign/types'
import type {
  CostLedgerHandle,
  CostReceipt,
  CostReceiptInput,
  CustomTokenPricing,
  MaximumCharge,
} from './cost-ledger'
import { CostLedger } from './cost-ledger'
import { weightedComposite } from './statistics'
import { contentHash } from './verdict-cache'

/** Native TypeSafe shapes. Inject the official SDK; no chat emulation or SDK dependency. */
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
  | {
      type: 'score'
      score: number
      confidence: number
      legend: Record<string, string>
      probabilities: Record<string, number>
    }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevResult {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}
/** One physical attempt. Disable SDK retries; admit retries through the owning paid-call path. */
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

/** SDK-inferred types do not validate the wire. Preserve distributions instead of sampling them. */
export function parseJevResult(raw: unknown, request: JevRequest): JevResult {
  const value = object(raw, 'response')
  if (typeof value.model !== 'string' || !value.model.trim()) {
    throw new JevResponseError('missing served model')
  }
  const alias = request.model === 'jev-latest' || request.model === 'jev-preview'
  if (
    (!alias && value.model !== request.model) ||
    (alias && !/^jev-\d+\.\d+\.\d+$/.test(value.model))
  ) {
    throw new JevResponseError('served model differs from requested model')
  }
  const answers = object(value.answers, 'answers')
  exactKeys(answers, Object.keys(request.questions), 'answers')
  for (const [key, question] of Object.entries(request.questions)) {
    const answer = object(answers[key], `answer ${key}`)
    if (answer.type !== question.type) {
      throw new JevResponseError(`answer ${key} has the wrong type`)
    }
    if (question.type === 'noul') {
      probability(answer.noul, key)
      continue
    }
    probability(answer.confidence, `${key}.confidence`)
    const levels =
      question.type === 'score'
        ? question.criteria.map((_, index) => String(index))
        : Object.keys(question.criteria)
    const probabilities = object(answer.probabilities, `${key}.probabilities`)
    exactKeys(probabilities, levels, `${key}.probabilities`)
    const sum = levels.reduce(
      (total, level) => total + probability(probabilities[level], `${key}.${level}`),
      0,
    )
    if (Math.abs(sum - 1) > 0.0001) {
      throw new JevResponseError(`${key} probabilities do not sum to one`)
    }
    if (question.type === 'score') {
      const legend = object(answer.legend, `${key}.legend`)
      exactKeys(legend, levels, `${key}.legend`)
      if (levels.some((level) => legend[level] !== question.criteria[Number(level)])) {
        throw new JevResponseError(`${key} legend differs from rubric`)
      }
      const expected = levels.reduce(
        (total, level) => total + Number(level) * (probabilities[level] as number),
        0,
      )
      if (
        typeof answer.score !== 'number' ||
        !Number.isFinite(answer.score) ||
        Math.abs(answer.score - expected) > 0.0001
      ) {
        throw new JevResponseError(`${key} score differs from its distribution`)
      }
    } else if (
      typeof answer.choice !== 'string' ||
      !Object.hasOwn(probabilities, answer.choice) ||
      levels.some(
        (level) =>
          (probabilities[level] as number) >
          (probabilities[answer.choice as string] as number) + 0.0001,
      )
    ) {
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
  /** Caller-reviewed local rates are estimates, never provider receipts. */
  pricing?: CustomTokenPricing
  receipt?: (response: unknown) => CostReceiptInput
  receiptFromError?: (error: Error) => CostReceiptInput | undefined
}

function snapshot(options: JevOptions): JevOptions {
  if (!options.model.trim() || !options.version.trim()) {
    throw new TypeError('Jev requires a model and version')
  }
  const questions = structuredClone(options.questions)
  if (Object.keys(questions).length === 0) {
    throw new TypeError('Jev requires at least one question')
  }
  for (const [key, question] of Object.entries(questions)) {
    if (!key.trim() || question.instructions == null) {
      throw new TypeError('Jev requires named questions with instructions')
    }
    if (
      question.type === 'score' &&
      (question.criteria.length < 2 || question.criteria.some((level) => typeof level !== 'string'))
    ) {
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
  context: {
    ledger: CostLedgerHandle
    signal?: AbortSignal
    actor: string
    channel: 'judge' | 'analyst'
    phase: string
    tags?: Record<string, string>
    onReceipt?: (receipt: CostReceipt) => void
  },
): Promise<{ result: JevResult; receipt: CostReceipt; durationMs: number }> {
  const request = { model: options.model, state, questions: structuredClone(options.questions) }
  const started = performance.now()
  const paid = await context.ledger.runPaidCall({
    actor: context.actor,
    channel: context.channel,
    phase: context.phase,
    tags: context.tags,
    model: options.model,
    signal: context.signal,
    maximumCharge: options.maximumCharge,
    execute: (signal, idempotencyKey) =>
      options.evaluate(structuredClone(request), { signal, idempotencyKey }),
    receipt:
      options.receipt ??
      ((raw) => {
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
  // Report empty-result and failed calls too; paid work is settled before validating answers.
  if (paid.receipt) context.onReceipt?.(paid.receipt)
  if (!paid.succeeded) throw paid.error
  return {
    result: parseJevResult(paid.value, request),
    receipt: paid.receipt,
    durationMs: performance.now() - started,
  }
}

export interface JevJudgeOptions<TArtifact, TScenario extends Scenario = Scenario>
  extends JevOptions {
  renderState: (input: { artifact: TArtifact; scenario: TScenario }) => JevState
  weights?: Record<string, number>
  appliesTo?: (scenario: TScenario) => boolean
}

/** A canonical campaign judge: existing campaigns and optimizers need no Jev-specific path. */
export function jevJudge<TArtifact, TScenario extends Scenario = Scenario>(
  name: string,
  options: JevJudgeOptions<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario> {
  if (!name.trim()) throw new TypeError('Jev judge requires a name')
  const config = snapshot(options)
  const keys = Object.keys(config.questions)
  const weights = options.weights ? { ...options.weights } : Object.fromEntries(keys.map((key) => [key, 1]))
  if (Object.values(config.questions).some((question) => question.type === 'choice')) {
    throw new TypeError(
      'Jev judges accept score or noul questions; choices have no numeric ordering',
    )
  }
  if (
    Object.entries(weights).some(
      ([key, weight]) => !keys.includes(key) || !Number.isFinite(weight) || weight < 0,
    ) ||
    Object.values(weights).reduce((sum, weight) => sum + weight, 0) <= 0
  ) {
    throw new TypeError('Invalid Jev judge weights')
  }
  const ledger = config.costLedger ?? new CostLedger()
  const render = options.renderState
  return {
    name,
    dimensions: Object.entries(config.questions).map(([key, question]) => ({
      key,
      description: JSON.stringify(question.instructions),
    })),
    judgeVersion: contentHash({
      kind: 'jev',
      model: config.model,
      questions: config.questions,
      version: config.version,
      weights,
    }),
    appliesTo: options.appliesTo,
    async score({
      artifact,
      scenario,
      signal,
      costLedger,
      costPhase,
      costTags,
    }): Promise<JudgeScore> {
      const { result, receipt, durationMs } = await paidEvaluation(
        config,
        render({ artifact, scenario }),
        {
          ledger: costLedger ?? ledger,
          signal,
          actor: name,
          channel: 'judge',
          phase: costPhase ?? 'judge',
          tags: { ...costTags, scenarioId: scenario.id },
        },
      )
      const entries = keys.map((key) => {
        const answer = result.answers[key]
        if (!answer) throw new JevResponseError(`missing answer ${key}`)
        if (answer.type === 'choice') throw new JevResponseError('choice cannot be scored')
        const scale = answer.type === 'score' ? Object.keys(answer.legend).length - 1 : 1
        const distribution =
          answer.type === 'noul'
            ? [
                { score: 0, probability: 1 - answer.noul },
                { score: 1, probability: answer.noul },
              ]
            : Object.entries(answer.probabilities).map(([level, probability]) => ({
                score: Number(level) / scale,
                probability,
              }))
        return {
          key,
          value: answer.type === 'noul' ? answer.noul : answer.score / scale,
          distribution,
        }
      })
      const dimensions = Object.fromEntries(entries.map(({ key, value }) => [key, value]))
      return {
        dimensions,
        composite: weightedComposite({ dims: dimensions, weights }).composite,
        notes: `Jev ${result.model}; rubric expectation, not an independent explanation or calibrated correctness probability.`,
        scoringMethod: 'expectation',
        distribution: Object.fromEntries(
          entries.map(({ key, distribution }) => [key, distribution]),
        ),
        llmCall: {
          model: result.model,
          durationMs,
          costUsd: receipt.costUnknown ? null : receipt.costUsd,
          usage: {
            promptTokens: result.usage.input_tokens,
            completionTokens: result.usage.output_tokens,
            totalTokens: result.usage.input_tokens + result.usage.output_tokens,
          },
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
  /** Map judgments to evidence-backed findings, not invented model rationales. */
  findings: (result: JevResult, input: TInput, context: AnalystContext) => AnalystFinding[]
}

/** An ordinary AnalystRegistry member; graph composition uses the existing analyst adapter. */
export function jevAnalyst<TInput>(options: JevAnalystOptions<TInput>): Analyst<TInput> {
  const config = snapshot(options)
  const { id, description, inputKind, renderState, findings } = options
  if (!id.trim() || !description.trim()) {
    throw new TypeError('Jev analyst requires id and description')
  }
  return {
    id,
    description,
    inputKind,
    version: contentHash({
      version: config.version,
      model: config.model,
      questions: config.questions,
    }),
    cost: { kind: 'llm', models: [config.model] },
    async analyze(input, context) {
      const ledger =
        context.costLedger ??
        config.costLedger ??
        new CostLedger({ costCeilingUsd: context.budgetUsd })
      const signals = context.signal ? [context.signal] : []
      if (context.deadlineMs !== undefined) {
        const remaining = context.deadlineMs - Date.now()
        if (!Number.isFinite(remaining)) throw new TypeError('Analyst deadline must be finite')
        if (remaining <= 0) {
          throw new DOMException('Analyst deadline exceeded', 'TimeoutError')
        }
        signals.push(AbortSignal.timeout(Math.ceil(remaining)))
      }
      const signal = AbortSignal.any(signals)
      signal.throwIfAborted()
      const { result } = await paidEvaluation(config, await renderState(input, context), {
        ledger,
        signal,
        actor: id,
        channel: 'analyst',
        phase: context.costPhase ?? 'analyst',
        tags: { ...context.tags, runId: context.runId, correlationId: context.correlationId },
        onReceipt: (receipt) =>
          context.recordUsage?.({
            calls: 1,
            tokens: receipt.usageUnknown
              ? null
              : { input: receipt.inputTokens, output: receipt.outputTokens },
            cost: receipt.costUnknown
              ? { kind: 'uncaptured', usd: null }
              : {
                  kind: receipt.actualCostUsd === undefined ? 'estimated' : 'observed',
                  usd: receipt.costUsd,
                },
          }),
      })
      return findings(result, input, context)
    },
  }
}
