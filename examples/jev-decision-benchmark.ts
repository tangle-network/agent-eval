/** Compare executable decision policies using the existing matrix runner, not another evaluator. */
import type { CostReceipt } from '../src/cost-ledger'
import type { EvaluationContext, Evaluator } from '../src/evaluation'
import type { JevQuestions, JevRequest, JevResult, JevState } from '../src/jev-protocol'
import { runAgentMatrix, withCellSpend } from '../src/matrix'

export interface DecisionCase {
  id: string
  /** Shared cases from one incident must keep the same sourceUnit when splitting datasets. */
  sourceUnit: string
  input: JevState
  /** Held-out label. Never sent to the classifier. Null means a reviewed unresolved outcome. */
  expected: string | null
}

export interface DecisionConfiguration {
  id: string
  version: string
  model: string
  questions: JevQuestions | ((input: JevState) => JevQuestions)
  state?: (input: JevState) => JevState
  /** An ordinary policy: exact labels, utility, abstention, or constraints belong to the caller. */
  decide: (result: JevResult) => string | null
}

/** Application recipe. It intentionally keeps the final label separate from preparation/inference. */
export async function compareDecisions(options: {
  cases: DecisionCase[]
  configurations: DecisionConfiguration[]
  evaluate: Evaluator<JevRequest, JevResult>
  context?: Omit<EvaluationContext, 'callId'>
  maxConcurrency?: number
  repetitions?: number
  onObservation?: (observation: {
    caseId: string
    sourceUnit: string
    configuration: { id: string; version: string }
    request: JevRequest
    result: Awaited<ReturnType<Evaluator<JevRequest, JevResult>>>
    decision: string | null
  }) => void | Promise<void>
}) {
  const configurations = options.configurations.map((value) => ({
    id: `${encodeURIComponent(value.id)}@${encodeURIComponent(value.version)}`,
    value,
  }))
  if (new Set(configurations.map(({ id }) => id)).size !== configurations.length) {
    throw new Error('configuration id and version pairs must be unique')
  }

  return runAgentMatrix({
    axes: [
      {
        name: 'configuration',
        values: configurations,
      },
      { name: 'case', values: options.cases.map((value) => ({ id: value.id, value })) },
    ],
    aggregateBy: ['configuration'],
    reps: options.repetitions ?? 1,
    maxConcurrency: options.maxConcurrency ?? 1,
    signal: options.context?.signal,
    runCell: async (cell) => {
      const config = cell.axes.configuration!.value as DecisionConfiguration
      const test = cell.axes.case!.value as DecisionCase
      const input = structuredClone(test.input)
      const request: JevRequest = {
        model: config.model,
        state: config.state ? config.state(input) : input,
        questions:
          typeof config.questions === 'function' ? config.questions(input) : config.questions,
      }
      const started = performance.now()
      let receipt: CostReceipt | undefined
      try {
        const result = await options.evaluate(request, {
          ...options.context,
          onReceipt: async (value) => {
            receipt = value
            await options.context?.onReceipt?.(value)
          },
        })
        receipt = result.receipt
        const costProvenance = receipt.costUnknown
          ? { kind: 'uncaptured' as const, usd: null }
          : {
              kind:
                receipt.actualCostUsd === undefined
                  ? ('estimated' as const)
                  : ('observed' as const),
              usd: receipt.costUsd,
            }
        options.context?.signal?.throwIfAborted()
        const decision = config.decide(result.value)
        await options.onObservation?.({
          caseId: test.id,
          sourceUnit: test.sourceUnit,
          configuration: { id: config.id, version: config.version },
          request,
          result,
          decision,
        })
        options.context?.signal?.throwIfAborted()
        const pass = decision === test.expected
        return {
          output: {
            caseId: test.id,
            sourceUnit: test.sourceUnit,
            decision,
            expected: test.expected,
            configurationVersion: config.version,
            unresolved: decision === null,
          },
          verdict: { valid: pass, score: pass ? 1 : 0 },
          costUsd: receipt.costUsd,
          costProvenance,
          durationMs: result.durationMs,
        }
      } catch (error) {
        throw withCellSpend(error, {
          costUsd: receipt?.costUsd ?? 0,
          durationMs: performance.now() - started,
          kind:
            !receipt || receipt.costUnknown
              ? 'uncaptured'
              : receipt.actualCostUsd === undefined
                ? 'estimated'
                : 'observed',
        })
      }
    },
  })
}
