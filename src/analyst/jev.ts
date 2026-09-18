import type { JudgeConfig, JudgeScore, Scenario } from '../campaign/types'
import { CostLedger, type CostLedgerHandle, type CostReceiptInput, type CustomTokenPricing, type MaximumCharge } from '../cost-ledger'
import { weightedComposite } from '../statistics'
import type { Analyst, AnalystContext, AnalystFinding, AnalystInputKind, EvidenceRef } from './types'
import { settleUsageReceiptFromCostLedger } from './usage-receipt'
import { jevUsage, parseJevResponse, validateJevRequest, type JevQuestion, type JevRequest, type JevResponse, type JevState } from './jev-protocol'

export * from './jev-protocol'

/** Bind client.systemOne here. One attempt; no implicit credential discovery or retry loop. */
export type JevEvaluate = (request: JevRequest, context: { signal: AbortSignal; callId: string }) => Promise<unknown>
export interface JevOptions {
  model: string
  evaluate: JevEvaluate
  /** Required by a capped ledger. This must be an enforced bound, not a target budget. */
  maximumCharge?: MaximumCharge
  /** Optional local price estimate; never represented as a provider receipt. */
  pricing?: CustomTokenPricing
  /** Supply authoritative Router/provider receipts when the transport exposes them. */
  receipt?: (value: unknown) => CostReceiptInput
  receiptFromError?: (error: Error) => CostReceiptInput | undefined
}

export async function runJevDecision(
  request: JevRequest,
  opts: Omit<JevOptions, 'model'> & {
    costLedger: CostLedgerHandle
    signal?: AbortSignal
    channel?: 'judge' | 'analyst' | 'agent'
    phase?: string
    actor: string
    tags?: Record<string, string>
  },
): Promise<JevResponse> {
  validateJevRequest(request)
  const expected = structuredClone(request)
  const paid = await opts.costLedger.runPaidCall({
    channel: opts.channel ?? 'agent',
    phase: opts.phase ?? 'decision',
    actor: opts.actor,
    model: expected.model,
    tags: opts.tags,
    signal: opts.signal,
    maximumCharge: opts.maximumCharge,
    execute: (signal, callId) => opts.evaluate(structuredClone(expected), { signal, callId }),
    receipt: opts.receipt ?? ((raw) => {
      const usage = jevUsage(raw)
      const model = raw !== null && typeof raw === 'object' && typeof Reflect.get(raw, 'model') === 'string'
        ? Reflect.get(raw, 'model') as string : expected.model
      return {
        model,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        ...(usage ? { customTokenPricing: opts.pricing } : { usageUnknown: true, costUnknown: true }),
      }
    }),
    receiptFromError: opts.receiptFromError,
  })
  if (!paid.succeeded) throw paid.error
  // Settle paid usage BEFORE parsing the answer: invalid output still consumed inference.
  return parseJevResponse(paid.value, expected)
}

export interface JevJudgeOptions<TArtifact, TScenario extends Scenario> extends JevOptions {
  judgeVersion: string
  questions: Record<string, Exclude<JevQuestion, { type: 'choice' }>>
  renderState: (input: { artifact: TArtifact; scenario: TScenario }) => JevState
  weights?: Record<string, number>
  costLedger?: CostLedgerHandle
}

/** Native rubric scores -> existing campaign JudgeConfig. No generated explanation or chat shim. */
export function jevJudge<TArtifact = unknown, TScenario extends Scenario = Scenario>(
  name: string,
  options: JevJudgeOptions<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario> {
  if (!name.trim() || !options.judgeVersion.trim()) throw new TypeError('Jev judge requires name and judgeVersion')
  if (['jev-latest', 'jev-preview'].includes(options.model.replace(/^typesafe\//, ''))) throw new TypeError('Pin a Jev version for repeatable judging')
  const questions = structuredClone(options.questions)
  validateJevRequest({ model: options.model, state: '', questions })
  const weights = options.weights ? { ...options.weights } : undefined
  if (weights && (Object.keys(weights).length === 0 || Object.entries(weights).some(([key, weight]) => !Object.hasOwn(questions, key) || !Number.isFinite(weight) || weight < 0) || !Object.values(weights).some(w => w > 0))) throw new TypeError('Invalid Jev judge weights')
  const ledger = options.costLedger ?? new CostLedger()
  return {
    name,
    judgeVersion: options.judgeVersion,
    dimensions: Object.entries(questions).map(([key, question]) => ({ key, description: typeof question.instructions === 'string' ? question.instructions : JSON.stringify(question.instructions) })),
    async score({ artifact, scenario, signal, costLedger, costPhase, costTags }): Promise<JudgeScore> {
      const response = await runJevDecision({ model: options.model, state: options.renderState({ artifact, scenario }), questions }, {
        ...options, costLedger: costLedger ?? ledger, signal, channel: 'judge',
        phase: costPhase ?? 'judge', actor: name, tags: { ...costTags, scenarioId: scenario.id },
      })
      const dimensions: Record<string, number> = Object.create(null)
      const distribution: NonNullable<JudgeScore['distribution']> = Object.create(null)
      for (const [key, answer] of Object.entries(response.answers)) {
        if (answer.type === 'noul') {
          dimensions[key] = answer.noul
          distribution[key] = [{ score: 0, probability: 1 - answer.noul }, { score: 1, probability: answer.noul }]
        } else if (answer.type === 'score') {
          const question = questions[key]
          if (question.type !== 'score') throw new Error('Jev rubric type changed')
          const maximum = question.criteria.length - 1
          dimensions[key] = answer.score / maximum
          distribution[key] = Object.entries(answer.probabilities).map(([level, probability]) => ({ score: Number(level) / maximum, probability }))
        } else throw new TypeError('A choice has no implicit numeric grade')
      }
      return {
        dimensions, composite: weightedComposite(dimensions, weights),
        notes: `Native Jev rubric evaluation (${response.model}); no generated rationale.`,
        scoringMethod: 'expectation', distribution,
      }
    },
  }
}

export interface JevAnalystOptions<TInput> extends JevOptions {
  id: string
  version: string
  description: string
  inputKind: AnalystInputKind
  questions: Record<string, JevQuestion>
  /** Project only relevant, authorized evidence; no hidden whole-trace upload. */
  project: (input: TInput, context: AnalystContext) => { state: JevState; evidence: EvidenceRef[] } | Promise<{ state: JevState; evidence: EvidenceRef[] }>
  interpret: (response: JevResponse, evidence: readonly EvidenceRef[]) => AnalystFinding[]
}

/** Lightweight semantic analyst in the existing registry; deep investigation remains separate. */
export function jevAnalyst<TInput>(options: JevAnalystOptions<TInput>): Analyst<TInput> {
  if (!options.id.trim() || !options.version.trim()) throw new TypeError('Jev analyst requires id and version')
  const questions = structuredClone(options.questions)
  validateJevRequest({ model: options.model, state: '', questions })
  return {
    id: options.id, version: options.version, description: options.description,
    inputKind: options.inputKind, cost: { kind: 'llm', models: [options.model] },
    async analyze(input, context) {
      context.signal?.throwIfAborted()
      if (context.deadlineMs !== undefined && context.deadlineMs <= Date.now()) throw new DOMException('Analyst deadline exceeded', 'TimeoutError')
      const signal = context.deadlineMs === undefined ? context.signal : AbortSignal.any([
        ...(context.signal ? [context.signal] : []), AbortSignal.timeout(Math.max(1, context.deadlineMs - Date.now())),
      ])
      const projected = await options.project(input, { ...context, signal })
      if (projected.evidence.length === 0) throw new TypeError('Jev analyst requires explicit evidence references')
      const evidence = structuredClone(projected.evidence)
      const ledger = context.costLedger ?? new CostLedger({ costCeilingUsd: context.budgetUsd })
      const tags = { ...context.tags, jevAnalysisId: crypto.randomUUID(), runId: context.runId }
      const phase = context.costPhase ?? 'analyst'
      try {
        const response = await runJevDecision({ model: options.model, state: projected.state, questions }, {
          ...options, costLedger: ledger, signal, channel: 'analyst', phase, actor: options.id, tags,
        })
        const findings = options.interpret(response, structuredClone(evidence))
        const known = new Set(evidence.map(ref => `${ref.kind}:${ref.uri}`))
        for (const finding of findings) {
          if (finding.analyst_id !== options.id || finding.evidence_refs.length === 0 || finding.evidence_refs.some(ref => !known.has(`${ref.kind}:${ref.uri}`))) throw new TypeError('Jev finding must cite supplied evidence under the registered analyst identity')
        }
        return findings
      } finally {
        const settled = await settleUsageReceiptFromCostLedger(ledger, { channel: 'analyst', phase, tags })
        context.recordUsage?.(settled.receipt)
      }
    },
  }
}
