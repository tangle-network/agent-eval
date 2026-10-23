import { randomUUID } from 'node:crypto'
import type { FindingCalibration, FindingLayer, FindingScope } from './analyst/finding-scope'
import type { FindingsLedger, FindingsLedgerOutcome } from './analyst/findings-ledger'
import { type AnalystFinding, type EvidenceRef, makeFinding } from './analyst/types'
import {
  type DecisionRecord,
  type DecisionRoute,
  decisionCalibrationSchema,
  decisionObservationSchema,
  decisionPointReliability,
  decisionRouteSchema,
  readDecisionRecord,
  validDecisionIdentity,
} from './decision-point-records'
import type { EvaluationContext } from './evaluation'
import { hashCanonical, jsonDocument } from './ledger-core/canonical'
import { deepFreezeCanonicalJson } from './ledger-core/deep-freeze'
import { type SystemOneEvaluatorOptions, systemOneEvaluator } from './systemone'
import { systemOneChoiceMargin } from './systemone-domain-match'
import {
  parseSystemOneQuestions,
  type SystemOneAnswer,
  type SystemOneQuestion,
  type SystemOneResult,
  type SystemOneState,
} from './systemone-protocol'

export type DecisionQuestions = Record<string, Extract<SystemOneQuestion, { type: 'choice' }>>
export interface DecisionQuestionPolicy {
  /** Capture an ancillary choice without routing authority or a calibration certificate. */
  recordOnly?: boolean
  minimumProbability: number
  minimumMargin: number
  options: Record<string, DecisionRoute>
  /** Identity of an independently labeled calibration, bound to the exact question and model. */
  calibration?: FindingCalibration & {
    questionDigest: string
    servedModel: string
    evidenceRefs: EvidenceRef[]
  }
}
export interface DecisionPointOptions<Q extends DecisionQuestions> {
  id: string
  version: string
  layers: FindingLayer[]
  model: string
  questions: Q
  policy: { [K in keyof Q]: DecisionQuestionPolicy }
  ledger: FindingsLedger
  evaluator: SystemOneEvaluatorOptions
}
export interface DecisionInvocation {
  runId: string
  invocationId: string
  layer: FindingLayer
  consumer: string
  state: SystemOneState
  scope: FindingScope
  at: string
  evidenceRefs: EvidenceRef[]
}
export interface DecisionPointResult {
  record: DecisionRecord | null
  finding: AnalystFinding
  replayed: boolean
  /** A reserved call without a durable result must escalate, including after a process crash. */
  action: DecisionRoute['action']
}

/** Model identity and authored option order are part of what a calibration measured. */
export function decisionQuestionDigest(input: {
  id: string
  version: string
  model: string
  servedModel: string
  name: string
  question: DecisionQuestions[string]
}): string {
  return hashCanonical(
    jsonDocument({ ...input, optionOrder: Object.keys(input.question.criteria) }),
  )
}

const invalid = (message: string): FindingsLedgerOutcome<never> => ({
  succeeded: false,
  error: { kind: 'invalid', message },
})

const cancelled = (): FindingsLedgerOutcome<never> => ({
  succeeded: false,
  error: {
    kind: 'unavailable',
    message: 'Decision delivery cancelled; any durable observation is retained',
  },
})

/** Minimum independent nominal-label agreement required before routing can drive work. */
export const DECISION_POINT_MIN_KAPPA = 0.77

function validateDecisionDefinition<Q extends DecisionQuestions>(
  config: Omit<DecisionPointOptions<Q>, 'ledger' | 'evaluator'>,
): void {
  parseSystemOneQuestions(config.questions)
  const names = [
    config.id,
    config.version,
    config.model,
    ...Object.keys(config.questions),
    ...Object.values(config.questions).flatMap((q) => Object.keys(q.criteria)),
  ]
  if (names.some((name) => !validDecisionIdentity(name)))
    throw new TypeError('Decision identities must be nonempty without surrounding space')
  if (!config.layers.length || new Set(config.layers).size !== config.layers.length)
    throw new TypeError('Decision layers must be a nonempty set')
  if (Object.keys(config.policy).length !== Object.keys(config.questions).length)
    throw new TypeError('Policy must cover every question')
  for (const [name, question] of Object.entries(config.questions)) {
    const policy = config.policy[name]
    if (question.type !== 'choice' || !policy)
      throw new TypeError('Decision points require choice questions with policies')
    if (
      !Number.isFinite(policy.minimumProbability) ||
      policy.minimumProbability < 0 ||
      policy.minimumProbability > 1 ||
      !Number.isFinite(policy.minimumMargin) ||
      policy.minimumMargin < 0 ||
      policy.minimumMargin > 1
    )
      throw new TypeError('Invalid decision threshold')
    if (
      policy.calibration !== undefined &&
      !decisionCalibrationSchema.safeParse(policy.calibration).success
    )
      throw new TypeError('Invalid decision calibration')
    if (policy.recordOnly !== undefined && typeof policy.recordOnly !== 'boolean')
      throw new TypeError('Invalid record-only policy')
    if (
      policy.recordOnly &&
      (policy.calibration !== undefined ||
        Object.values(policy.options).some((route) => route.action !== 'record'))
    )
      throw new TypeError('Record-only questions cannot route or carry calibration')
    const choices = Object.keys(question.criteria)
    if (choices.length < 2) throw new TypeError('A decision needs at least two options')
    if (
      Object.keys(policy.options).length !== choices.length ||
      choices.some((choice) => !Object.hasOwn(policy.options, choice))
    )
      throw new TypeError('Policy must cover every option')
    for (const route of Object.values(policy.options)) {
      if (!decisionRouteSchema.safeParse(route).success)
        throw new TypeError('Invalid decision route')
    }
  }
}

function recommendDecisionAnswer(
  config: Omit<DecisionPointOptions<DecisionQuestions>, 'ledger' | 'evaluator'>,
  name: string,
  servedModel: string,
  answer: Extract<SystemOneAnswer, { type: 'choice' }>,
): DecisionRecord['answers'][string] {
  const policy = config.policy[name]!
  const p = answer.probabilities[answer.choice]!
  const margin = systemOneChoiceMargin(answer.probabilities, answer.choice)
  const calibration = policy.calibration
  const calibrated =
    calibration &&
    calibration.kappa >= DECISION_POINT_MIN_KAPPA &&
    calibration.questionDigest ===
      decisionQuestionDigest({
        id: config.id,
        version: config.version,
        model: config.model,
        servedModel: calibration.servedModel,
        name,
        question: config.questions[name]!,
      })
  const reason = policy.recordOnly
    ? 'record-only'
    : !calibrated
      ? 'uncalibrated'
      : servedModel !== calibration.servedModel
        ? 'model-mismatch'
        : margin <= 0 || p < policy.minimumProbability || margin < policy.minimumMargin
          ? 'uncertain'
          : 'threshold'
  return {
    probabilities: { ...answer.probabilities },
    choice: answer.choice,
    recommendation:
      reason === 'record-only'
        ? { action: 'record' }
        : reason === 'threshold'
          ? policy.options[answer.choice]!
          : { action: 'escalate' },
    reason,
  }
}

/** Cheap, reversible judgments only. This returns recommendations and never performs actions. */
export function decisionPoint<const Q extends DecisionQuestions>(options: DecisionPointOptions<Q>) {
  const { ledger, evaluator, ...definition } = options
  const config = deepFreezeCanonicalJson(structuredClone(definition))
  validateDecisionDefinition(config)
  const definitionDigest = hashCanonical(
    jsonDocument({
      ...config,
      questionOrder: Object.keys(config.questions),
      optionOrder: Object.values(config.questions).map((q) => Object.keys(q.criteria)),
    }),
  )
  const evaluate = systemOneEvaluator(evaluator)
  const analystId = 'decision-point'
  const decisionId = (runId: string, invocationId: string) =>
    `decision:${hashCanonical({ point: config.id, runId, invocationId })}`
  const find = async (runId: string, id: string) => {
    const read = await ledger.read()
    if (!read.succeeded) return read
    return {
      succeeded: true as const,
      value: read.value.findings.find((row) => row.run_id === runId && row.finding_id === id),
    }
  }
  const readReplay = async (
    input: DecisionInvocation,
    inputDigest: string,
  ): Promise<FindingsLedgerOutcome<DecisionPointResult> | null> => {
    const id = decisionId(input.runId, input.invocationId)
    const result = await find(input.runId, id)
    if (!result.succeeded) return result
    if (result.value) {
      const record = readDecisionRecord(result.value)
      if (
        !record ||
        record.inputDigest !== inputDigest ||
        record.definitionDigest !== definitionDigest
      )
        return invalid('Invocation identity conflicts with a different decision')
      return {
        succeeded: true,
        value: { record, finding: result.value, replayed: true, action: record.action },
      }
    }
    const intent = await find(input.runId, `${id}:intent`)
    if (!intent.succeeded) return intent
    if (!intent.value) return null
    const metadata = intent.value.metadata?.decision_point as Record<string, unknown> | undefined
    if (metadata?.inputDigest !== inputDigest || metadata.definitionDigest !== definitionDigest)
      return invalid('Invocation identity conflicts with a different intent')
    return {
      succeeded: true,
      value: { record: null, finding: intent.value, replayed: true, action: 'escalate' },
    }
  }
  const baseFinding = (input: DecisionInvocation, area: string, claim: string) =>
    makeFinding({
      analyst_id: analystId,
      area,
      claim,
      confidence: 1,
      severity: 'info',
      subject: config.id,
      layer: input.layer,
      scope: input.scope,
      method: { kind: 'computed', name: 'decision-routing', version: config.version },
      evidence_refs: input.evidenceRefs,
      produced_at: input.at,
    })
  return {
    id: config.id,
    definitionDigest,
    async decide(
      invocation: DecisionInvocation,
      context: EvaluationContext = {},
    ): Promise<FindingsLedgerOutcome<DecisionPointResult>> {
      if (context.signal?.aborted) return cancelled()
      let input: DecisionInvocation
      let inputDigest: string
      try {
        input = structuredClone(invocation)
        if (!config.layers.includes(input.layer))
          return invalid('Invocation must name a supported layer')
        if (
          [input.runId, input.invocationId, input.consumer].some(
            (value) => typeof value !== 'string' || !value.trim() || value.trim() !== value,
          ) ||
          !input.evidenceRefs.length
        )
          return invalid(
            'Run, invocation, consumer and evidence are required without surrounding space',
          )
        inputDigest = hashCanonical(input)
      } catch {
        return invalid('Invocation must contain canonical JSON state and valid identity fields')
      }
      const replay = await readReplay(input, inputDigest)
      if (context.signal?.aborted) return cancelled()
      if (replay) return replay
      const id = decisionId(input.runId, input.invocationId)
      // Competing owners append different tokens at the same ledger event id. Exactly one can infer.
      const intent: AnalystFinding = {
        ...baseFinding(
          input,
          'decision-intent',
          'Decision invocation reserved; unresolved intent requires escalation',
        ),
        finding_id: `${id}:intent`,
        metadata: {
          decision_point: {
            kind: 'decision-intent',
            definitionDigest,
            inputDigest,
            owner: randomUUID(),
          },
        },
      }
      const reserved = await ledger.append(input.runId, [intent])
      if (!reserved.succeeded) {
        if (reserved.error.kind === 'conflict') {
          const replay = await readReplay(input, inputDigest)
          if (context.signal?.aborted) return cancelled()
          return replay ?? reserved
        }
        return reserved
      }
      let servedModel: string | null = null
      let receipt: unknown
      let error: DecisionRecord['error'] = null
      const answers: DecisionRecord['answers'] = Object.create(null)
      try {
        const result = await evaluate(
          { model: config.model, state: input.state, questions: config.questions },
          {
            ...context,
            onReceipt: async (value) => {
              receipt = value
              await context.onReceipt?.(value)
            },
          },
        )
        if (!validDecisionIdentity(result.value.model))
          throw new TypeError('Invalid served model identity')
        servedModel = result.value.model
        receipt = result.receipt
        for (const [name, answer] of Object.entries((result.value as SystemOneResult).answers)) {
          if (answer.type !== 'choice') throw new TypeError('Expected choice answer')
          answers[name] = recommendDecisionAnswer(config, name, servedModel, answer)
        }
        context.signal?.throwIfAborted()
      } catch {
        error = context.signal?.aborted ? 'cancelled' : 'evaluation-failed'
      }
      const routes = Object.values(answers).map((answer) => answer.recommendation.action)
      const action =
        error || routes.includes('escalate')
          ? 'escalate'
          : routes.includes('act')
            ? 'act'
            : 'record'
      const record: DecisionRecord = {
        kind: 'decision',
        pointId: config.id,
        definitionDigest,
        invocationId: input.invocationId,
        inputDigest,
        stateDigest: hashCanonical(input.state),
        requestedModel: config.model,
        servedModel,
        action,
        answers,
        error,
        definition: jsonDocument(config),
        consumer: input.consumer,
        ...(receipt === undefined ? {} : { receipt: jsonDocument(receipt) }),
      }
      const finding: AnalystFinding = {
        ...baseFinding(input, 'decision-point', `Decision routing recommendation: ${action}`),
        finding_id: id,
        metadata: { decision_point: record },
        evidence_refs: [
          ...input.evidenceRefs,
          { kind: 'finding', uri: `finding://${intent.finding_id}` },
        ],
      }
      const saved = await ledger.append(input.runId, [finding])
      if (!saved.succeeded) return saved
      if (context.signal?.aborted) return cancelled()
      return { succeeded: true, value: { record, finding, replayed: false, action } }
    },
    async observe(input: {
      runId: string
      invocationId: string
      labels: Record<string, string>
      at: string
      evidenceRefs: EvidenceRef[]
    }): Promise<FindingsLedgerOutcome<{ appended: number; replayed: number }>> {
      let snapshot: typeof input
      try {
        const cloned = structuredClone(input)
        hashCanonical(cloned)
        snapshot = decisionObservationSchema.parse(cloned)
      } catch {
        return invalid(
          'Outcome requires canonical JSON labels and valid identity and evidence fields',
        )
      }
      const found = await find(snapshot.runId, decisionId(snapshot.runId, snapshot.invocationId))
      if (!found.succeeded) return found
      const decision = found.value && readDecisionRecord(found.value)
      if (!decision || decision.definitionDigest !== definitionDigest || decision.error)
        return invalid('Outcome requires a successful decision from this definition')
      for (const [question, label] of Object.entries(snapshot.labels)) {
        if (
          !decision.answers[question] ||
          !Object.hasOwn(decision.answers[question]!.probabilities, label)
        )
          return invalid('Outcome label does not name a stored option')
      }
      // Each question can be labeled later, independently, without rewriting another label.
      const findings: AnalystFinding[] = Object.entries(snapshot.labels).map(
        ([question, label]) => ({
          ...makeFinding({
            analyst_id: analystId,
            area: 'decision-outcome',
            claim: 'Observed label joined to decision probabilities',
            confidence: 1,
            severity: 'info',
            subject: config.id,
            produced_at: snapshot.at,
            layer: found.value!.layer,
            scope: found.value!.scope,
            method: { kind: 'computed', name: 'decision-outcome-join', version: config.version },
            evidence_refs: [
              ...snapshot.evidenceRefs,
              { kind: 'finding', uri: `finding://${found.value!.finding_id}` },
            ],
          }),
          finding_id: `${found.value!.finding_id}:outcome:${encodeURIComponent(question)}`,
          metadata: {
            decision_point: {
              kind: 'decision-outcome',
              definitionDigest,
              decisionFindingId: found.value!.finding_id,
              labels: { [question]: label },
            },
          },
        }),
      )
      return ledger.append(snapshot.runId, findings)
    },
    reliability: () =>
      decisionPointReliability(
        ledger,
        definitionDigest,
        Object.keys(config.questions).filter((name) => !config.policy[name]!.recordOnly),
        Object.keys(config.questions).filter((name) => config.policy[name]!.recordOnly),
      ),
  }
}
