import {
  CostAccountingIncompleteError,
  type CostLedgerHandle,
  type RunPaidCallInput,
} from '../cost-ledger'
import type { JudgeConfig, JudgeScore, Scenario } from './types'

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

export interface UpstreamEvaluationContext {
  readonly signal: AbortSignal
  readonly callId?: string
}

type PaidEvaluationOptions<TResult> = Pick<
  RunPaidCallInput<TResult>,
  'maximumCharge' | 'receipt' | 'receiptFromError'
> & {
  model: string
}

interface UpstreamJudgeOptions<TScenario extends Scenario> {
  name?: string
  dimension?: string
  judgeVersion?: string
  appliesTo?: (scenario: TScenario) => boolean
  /** Convert the upstream score when its native scale is not higher-is-better. */
  toComposite?: (score: number) => number
}

export function phoenixEvaluatorJudge<
  TRecord extends Record<string, unknown>,
  TArtifact,
  TScenario extends Scenario = Scenario,
>(
  evaluator: PhoenixEvaluatorLike<TRecord>,
  options: UpstreamJudgeOptions<TScenario> & {
    mapInput(input: { artifact: TArtifact; scenario: TScenario }): TRecord
    paidCall?: PaidEvaluationOptions<PhoenixEvaluationResultLike>
  },
): JudgeConfig<TArtifact, TScenario> {
  if (
    (evaluator.optimizationDirection === 'MINIMIZE' ||
      evaluator.optimizationDirection === 'NEUTRAL') &&
    !options.toComposite
  ) {
    throw new TypeError(
      `phoenixEvaluatorJudge requires toComposite for a ${evaluator.optimizationDirection} evaluator`,
    )
  }
  const paidCall = validatePaidEvaluation(evaluator.name, evaluator.kind, options.paidCall)
  return upstreamJudge(
    {
      name: options.name ?? evaluator.name,
      dimension: options.dimension,
      judgeVersion: options.judgeVersion,
      appliesTo: options.appliesTo,
      toComposite: options.toComposite,
    },
    async (input) => {
      const result = await runUpstreamEvaluation({
        name: evaluator.name,
        kind: evaluator.kind,
        signal: input.signal,
        costLedger: input.costLedger,
        costPhase: input.costPhase,
        costTags: input.costTags,
        scenarioId: input.scenario.id,
        paidCall,
        execute: (context) =>
          evaluator.evaluate(
            options.mapInput({ artifact: input.artifact, scenario: input.scenario }),
            context,
          ),
      })
      if (result.score === undefined || !Number.isFinite(result.score)) {
        throw new Error(`${evaluator.name}: Phoenix evaluator returned no finite score`)
      }
      return {
        score: result.score,
        notes: [result.label, result.explanation].filter(Boolean).join(': ') || evaluator.name,
      }
    },
  )
}

export function autoevalsScorerJudge<
  TInput extends Record<string, unknown>,
  TArtifact,
  TScenario extends Scenario = Scenario,
>(
  scorer: AutoevalsScorerLike<TInput>,
  options: UpstreamJudgeOptions<TScenario> & {
    name: string
    mapInput(input: { artifact: TArtifact; scenario: TScenario }): TInput
  } & (
      | { kind: 'CODE'; paidCall?: never }
      | { kind: 'LLM'; paidCall: PaidEvaluationOptions<AutoevalsScoreLike> }
    ),
): JudgeConfig<TArtifact, TScenario> {
  const paidCall = validatePaidEvaluation(options.name, options.kind, options.paidCall)
  return upstreamJudge(options, async (input) => {
    const result = await runUpstreamEvaluation({
      name: options.name,
      kind: options.kind,
      signal: input.signal,
      costLedger: input.costLedger,
      costPhase: input.costPhase,
      costTags: input.costTags,
      scenarioId: input.scenario.id,
      paidCall,
      execute: (context) =>
        scorer(options.mapInput({ artifact: input.artifact, scenario: input.scenario }), context),
    })
    if (result.score === null || !Number.isFinite(result.score)) {
      throw new Error(`${options.name}: Autoevals scorer returned no finite score`)
    }
    return {
      score: result.score,
      notes: result.metadata ? JSON.stringify(result.metadata) : result.name,
    }
  })
}

function upstreamJudge<TArtifact, TScenario extends Scenario>(
  options: UpstreamJudgeOptions<TScenario> & { name: string },
  evaluate: (
    input: Parameters<JudgeConfig<TArtifact, TScenario>['score']>[0],
  ) => Promise<{ score: number; notes: string }>,
): JudgeConfig<TArtifact, TScenario> {
  const dimension = options.dimension ?? options.name
  return {
    name: options.name,
    judgeVersion: options.judgeVersion,
    dimensions: [{ key: dimension, description: `Score from ${options.name}` }],
    appliesTo: options.appliesTo,
    async score(input): Promise<JudgeScore> {
      const result = await evaluate(input)
      const composite = options.toComposite ? options.toComposite(result.score) : result.score
      if (!Number.isFinite(composite)) {
        throw new Error(`${options.name}: toComposite returned a non-finite score`)
      }
      return {
        dimensions: { [dimension]: result.score },
        composite,
        notes: result.notes,
      }
    },
  }
}

function validatePaidEvaluation<TResult>(
  name: string,
  kind: 'LLM' | 'CODE',
  paidCall: PaidEvaluationOptions<TResult> | undefined,
): PaidEvaluationOptions<TResult> | undefined {
  if (kind === 'CODE') {
    if (paidCall) {
      throw new TypeError(`${name}: CODE evaluator cannot declare paidCall`)
    }
    return undefined
  }
  if (!paidCall) {
    throw new TypeError(`${name}: LLM evaluator requires paidCall cost and token capture`)
  }
  if (!paidCall.model.trim()) {
    throw new TypeError(`${name}: paidCall.model must be non-empty`)
  }
  return paidCall
}

async function runUpstreamEvaluation<TResult>(input: {
  name: string
  kind: 'LLM' | 'CODE'
  signal: AbortSignal
  costLedger?: CostLedgerHandle
  costPhase?: string
  costTags?: Record<string, string>
  scenarioId: string
  paidCall?: PaidEvaluationOptions<TResult>
  execute(context: UpstreamEvaluationContext): Promise<TResult> | TResult
}): Promise<TResult> {
  if (input.kind === 'CODE') {
    return abortableEvaluation(input.signal, () => input.execute({ signal: input.signal }))
  }
  if (!input.paidCall) {
    throw new CostAccountingIncompleteError(`${input.name}: missing paid-call configuration`)
  }
  if (!input.costLedger) {
    throw new CostAccountingIncompleteError(
      `${input.name}: LLM evaluator requires the campaign cost ledger`,
    )
  }

  const paid = await input.costLedger.runPaidCall({
    channel: 'judge',
    phase: input.costPhase ?? 'judge',
    actor: input.name,
    model: input.paidCall.model,
    ...(input.paidCall.maximumCharge ? { maximumCharge: input.paidCall.maximumCharge } : {}),
    tags: { ...input.costTags, scenarioId: input.scenarioId },
    signal: input.signal,
    execute: (signal, callId) => Promise.resolve(input.execute({ signal, callId })),
    receipt: input.paidCall.receipt,
    ...(input.paidCall.receiptFromError
      ? { receiptFromError: input.paidCall.receiptFromError }
      : {}),
  })
  if (!paid.succeeded) throw paid.error

  const recorded = input.costLedger.list().find((receipt) => receipt.callId === paid.callId)
  if (!recorded) {
    throw new CostAccountingIncompleteError(
      `${input.name}: paid evaluator returned without a recorded cost receipt`,
    )
  }
  if (recorded.costUnknown || recorded.usageUnknown) {
    throw new CostAccountingIncompleteError(
      `${input.name}: paid evaluator returned without complete cost and token usage`,
    )
  }
  return paid.value
}

async function abortableEvaluation<TResult>(
  signal: AbortSignal,
  execute: () => Promise<TResult> | TResult,
): Promise<TResult> {
  if (signal.aborted) throw signal.reason

  let rejectAborted!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject
  })
  const onAbort = (): void => rejectAborted(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([Promise.resolve().then(execute), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
