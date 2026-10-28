import { analystEvaluationContext } from './analyst/evaluation-context'
import type { ExactCapableAnalyst } from './analyst/exact-types'
import type { Analyst, AnalystContext, AnalystFinding } from './analyst/types'
import type { JudgeConfig, JudgeScore, Scenario } from './campaign/types'
import type {
  CostChannel,
  CostLedgerHandle,
  CostReceipt,
  CostReceiptInput,
  MaximumCharge,
} from './cost-ledger'
import { CostLedger } from './cost-ledger'

export interface EvaluationResult<T> {
  value: T
  receipt: CostReceipt
  durationMs: number
}

export interface EvaluationContext {
  /** Physical paid-call identity, forwarded through the existing ledger and transport.
   * Reusing it in one ledger conflicts; it is not an automatic result-replay policy. */
  callId?: string
  signal?: AbortSignal
  costLedger?: CostLedgerHandle
  actor?: string
  channel?: CostChannel
  costPhase?: string
  costTags?: Record<string, string>
  maximumCharge?: MaximumCharge
  /** Awaited after accounting and before validation or result delivery. */
  onReceipt?: (receipt: CostReceipt) => void | Promise<void>
}

export type CostedEvaluator<I, O> = (
  input: I,
  context?: EvaluationContext,
) => Promise<EvaluationResult<O>>

export interface EvaluatorOptions<I, O> {
  execute: (input: I, context: { signal: AbortSignal; idempotencyKey: string }) => Promise<O>
  receipt: (value: O) => CostReceiptInput
  receiptFromError?: (error: Error) => CostReceiptInput | undefined
  model?: string | ((input: I) => string)
  costLedger?: CostLedgerHandle
  maximumCharge?: MaximumCharge
  /** Awaited after accounting, so invalid output never erases paid work. */
  validate?: (value: O, input: I) => void | Promise<void>
}

/** A metered function, independent of providers, question formats, and application policy. */
export function createEvaluator<I, O>(options: EvaluatorOptions<I, O>): CostedEvaluator<I, O> {
  const defaults = { ...options }
  const ledger = defaults.costLedger ?? new CostLedger()
  return async (input, context = {}) => {
    context.signal?.throwIfAborted()
    const started = performance.now()
    const paid = await (context.costLedger ?? ledger).runPaidCall({
      callId: context.callId,
      actor: context.actor ?? 'evaluation',
      channel: context.channel ?? 'evaluation',
      phase: context.costPhase ?? 'evaluation',
      tags: context.costTags,
      model: typeof defaults.model === 'function' ? defaults.model(input) : defaults.model,
      signal: context.signal,
      maximumCharge: context.maximumCharge ?? defaults.maximumCharge,
      execute: (signal, idempotencyKey) => defaults.execute(input, { signal, idempotencyKey }),
      receipt: defaults.receipt,
      receiptFromError: defaults.receiptFromError,
    })
    if (paid.receipt) await context.onReceipt?.(paid.receipt)
    if (!paid.succeeded) throw paid.error
    // A transport can complete after cancellation. Keep its paid receipt, not a live decision.
    context.signal?.throwIfAborted()
    await defaults.validate?.(paid.value, input)
    context.signal?.throwIfAborted()
    return { value: paid.value, receipt: paid.receipt, durationMs: performance.now() - started }
  }
}

export interface EvaluationJudgeOptions<A, S extends Scenario, O> {
  name: string
  version: string
  dimensions: JudgeConfig<A, S>['dimensions']
  evaluate: CostedEvaluator<{ artifact: A; scenario: S }, O>
  map: (value: O, input: { artifact: A; scenario: S }) => JudgeScore | Promise<JudgeScore>
  /** Persist the complete observation before reducing it to a verdict. */
  record?: (
    result: EvaluationResult<O>,
    input: { artifact: A; scenario: S },
  ) => void | Promise<void>
  appliesTo?: (scenario: S) => boolean
}

/** Return the existing contract. Mapping never performs another inference call. */
export function asJudge<A, S extends Scenario, O>(
  options: EvaluationJudgeOptions<A, S, O>,
): JudgeConfig<A, S> {
  // The version describes these callbacks, not later mutations of the caller's options.
  const config = { ...options, dimensions: structuredClone(options.dimensions) }
  return {
    name: config.name,
    judgeVersion: config.version,
    dimensions: config.dimensions,
    appliesTo: config.appliesTo,
    async score({ artifact, scenario, signal, costLedger, costPhase, costTags }) {
      signal.throwIfAborted()
      const input = { artifact, scenario }
      const result = await config.evaluate(input, {
        signal,
        costLedger,
        actor: config.name,
        channel: 'judge',
        costPhase,
        costTags: { ...costTags, scenarioId: scenario.id },
      })
      await config.record?.(result, input)
      signal.throwIfAborted()
      const score = await config.map(result.value, input)
      signal.throwIfAborted()
      return score
    },
  }
}

export interface EvaluationAnalystOptions<I, O> {
  id: string
  version: string
  description: string
  inputKind: Analyst<I>['inputKind']
  cost: Analyst<I>['cost']
  executionConfig?: ExactCapableAnalyst<I>['executionConfig']
  evaluate: (
    input: I,
    context: EvaluationContext,
    analystContext: AnalystContext,
  ) => Promise<EvaluationResult<O>>
  map: (value: O, input: I, context: AnalystContext) => AnalystFinding[] | Promise<AnalystFinding[]>
  record?: (result: EvaluationResult<O>, input: I, context: AnalystContext) => void | Promise<void>
}

/** Registry, graph, and trace consumers keep the same Analyst interface. */
export function asAnalyst<I, O>(options: EvaluationAnalystOptions<I, O>): Analyst<I> {
  const config = { ...options, cost: structuredClone(options.cost) }
  return {
    id: config.id,
    version: config.version,
    description: config.description,
    inputKind: config.inputKind,
    cost: config.cost,
    ...(config.executionConfig !== undefined && {
      executionConfig: structuredClone(config.executionConfig),
    }),
    async analyze(input, context) {
      const { evaluation, analystContext } = analystEvaluationContext(context, config.id)
      const signal = analystContext.signal
      const result = await config.evaluate(input, evaluation, analystContext)
      await config.record?.(result, input, analystContext)
      signal.throwIfAborted()
      const findings = await config.map(result.value, input, analystContext)
      signal.throwIfAborted()
      return findings
    },
  }
}
