import {
  DECISION_POINT_MIN_KAPPA,
  type DecisionQuestionPolicy,
  decisionPoint,
} from '../decision-point'
import { canonicalString, hashCanonical } from '../ledger-core/canonical'
import type { SystemOneState } from '../systemone-protocol'
import {
  BEHAVIORAL_TRACE_QUESTIONS,
  BEHAVIORAL_TRACE_QUESTIONS_VERSION,
  type BehavioralTraceAnswer,
  type BehavioralTraceQuestionId,
  type BehavioralTraceQuestionsOptions,
  type BehavioralTraceWindow,
  behavioralTracePointId,
  behavioralTraceQuestionDigest,
} from './behavioral-trace-questions'
import {
  behavioralComputedRepeat,
  behavioralJudgedSupport,
  behavioralSupportQuestions,
} from './behavioral-trace-support'
import { prepareBehavioralTraceQuestions } from './behavioral-trace-validation'
import { analystEvaluationContext } from './evaluation-context'
import { snapshotExactExecutionComponentIdentity } from './exact-types'
import { type AnalystContext, type AnalystFinding, makeFinding } from './types'

/** An optional execution path inside behavioralAnalyst, never a second analyst or journal. */
export function prepareBehavioralTraceRuntime(options: BehavioralTraceQuestionsOptions) {
  const data = prepareBehavioralTraceQuestions(options)
  const ledger = options.ledger
  const evaluator = { ...options.evaluator }
  const semanticQuestions = Object.fromEntries(
    Object.entries(BEHAVIORAL_TRACE_QUESTIONS).filter(([id]) => id !== 'identical-tool-repeat'),
  )
  const states = new Map(data.windows.map((window) => [window.id, behavioralWindowState(window)]))
  const points = new Map(
    data.windows.map((window) => {
      const layer = window.layer
      const supportQuestions = behavioralSupportQuestions(window)
      const questions = { ...semanticQuestions, ...supportQuestions }
      if (
        Buffer.byteLength(
          canonicalString({ model: data.model, state: states.get(window.id), questions }),
        ) > data.maxRequestBytes
      )
        throw new RangeError(`Trace window '${window.id}' exceeds maxRequestBytes`)
      const policy = Object.fromEntries(
        Object.keys(semanticQuestions).map((name) => {
          const calibration = data.calibrations[layer]?.[name as BehavioralTraceQuestionId]
          const entry: DecisionQuestionPolicy = {
            minimumProbability: data.minimumProbability,
            minimumMargin: data.minimumMargin,
            options: {
              yes: { action: 'act', route: 'coordinator-alarm' },
              no: { action: 'record' },
              unsure: { action: 'escalate' },
            },
          }
          if (calibration && calibration.servedModel !== null)
            entry.calibration = { ...calibration, servedModel: calibration.servedModel }
          return [name, entry]
        }),
      )
      for (const [name, question] of Object.entries(supportQuestions)) {
        policy[name] = {
          recordOnly: true,
          minimumProbability: data.minimumProbability,
          minimumMargin: data.minimumMargin,
          options: Object.fromEntries(
            Object.keys(question.criteria).map((id) => [id, { action: 'record' }]),
          ),
        }
      }
      return [
        window.id,
        decisionPoint({
          id: behavioralTracePointId(layer, data.windowPolicy, data.evaluatorIdentity),
          version: BEHAVIORAL_TRACE_QUESTIONS_VERSION,
          layers: [layer],
          model: data.model,
          questions,
          policy,
          ledger,
          evaluator,
        }),
      ] as const
    }),
  )
  const config = {
    kind: 'behavioral-trace-questions',
    analysis_id: data.analysisId,
    version: BEHAVIORAL_TRACE_QUESTIONS_VERSION,
    model: data.model,
    evaluator: snapshotExactExecutionComponentIdentity(
      data.evaluatorIdentity,
      'behavioral evaluator',
    ),
    window_policy: data.windowPolicy,
    windows_digest: hashCanonical(data.windows),
    calibrations: data.calibrations,
    max_windows: data.maxWindows,
    max_window_bytes: data.maxWindowBytes,
    max_request_bytes: data.maxRequestBytes,
    minimum_probability: data.minimumProbability,
    minimum_margin: data.minimumMargin,
  }
  return {
    executionConfig: config,
    async analyze(traceIds: string[], context: AnalystContext): Promise<AnalystFinding[]> {
      const { evaluation, analystContext } = analystEvaluationContext(
        context,
        'efficiency-behavioral',
      )
      const traceSet = new Set(traceIds)
      if (data.windows.some((w) => !traceSet.has(w.traceId)))
        throw new TypeError('A selected question window is outside the analyzed trace store')
      if (!context.runId.trim() || !context.correlationId.trim())
        throw new TypeError('Question execution requires run and correlation identities')
      const findings: AnalystFinding[] = []
      let receipts = 0
      const onReceipt = evaluation.onReceipt
      evaluation.onReceipt = async (receipt) => {
        receipts++
        await onReceipt?.(receipt)
      }
      for (const window of data.windows) {
        analystContext.signal.throwIfAborted()
        const result = await points.get(window.id)!.decide(
          {
            runId: context.runId,
            invocationId: `behavioral:${hashCanonical([data.analysisId, window.id])}`,
            layer: window.layer,
            consumer: 'behavioralAnalyst',
            state: states.get(window.id)!,
            scope: { population: [window.id], n: 1, window: { from: window.from, to: window.to } },
            at: window.to,
            evidenceRefs: window.evidenceRefs,
          },
          evaluation,
        )
        analystContext.signal.throwIfAborted()
        if (!result.succeeded)
          throw new Error(`Trace question decision ${result.error.kind}: ${result.error.message}`)
        if (!result.value.record)
          throw new Error(
            'Trace question analysis unresolved: an existing intent has no terminal result',
          )
        const retainedMap = behavioralJudgedSupport(
          result.value.record,
          'unverified-completion',
          window,
        ).map
        const repeat = behavioralComputedRepeat(window, retainedMap)
        for (const questionId of Object.keys(
          BEHAVIORAL_TRACE_QUESTIONS,
        ) as BehavioralTraceQuestionId[]) {
          const computed = questionId === 'identical-tool-repeat'
          const record = result.value.record
          const answer = record?.answers[questionId]
          const value: BehavioralTraceAnswer | null = computed
            ? repeat.answer
            : record?.error
              ? null
              : ((answer?.choice as BehavioralTraceAnswer | undefined) ?? null)
          const servedModel = computed ? null : (record?.servedModel ?? null)
          const calibration = data.calibrations[window.layer]?.[questionId]
          const digest =
            servedModel === null && !computed
              ? null
              : behavioralTraceQuestionDigest({
                  questionId,
                  layer: window.layer,
                  windowPolicy: data.windowPolicy,
                  evaluatorIdentity: data.evaluatorIdentity,
                  model: data.model,
                  servedModel,
                })
          const calibrated = Boolean(
            calibration &&
              calibration.kappa >= DECISION_POINT_MIN_KAPPA &&
              calibration.questionDigest === digest &&
              calibration.servedModel === servedModel,
          )
          const alarm =
            value === 'yes' && calibrated && (computed || answer?.reason === 'threshold')
          findings.push(
            observation(
              window,
              context,
              questionId,
              {
                answer: value,
                method: computed ? 'computed' : 'judged',
                support: computed
                  ? repeat.support
                  : behavioralJudgedSupport(record, questionId, window),
                questionDigest: digest,
                requestedModel: computed ? null : data.model,
                servedModel,
                probabilities: computed ? null : (answer?.probabilities ?? null),
                calibration: calibrated ? 'calibrated' : 'uncalibrated',
                gold_n: calibration?.gold_n ?? 0,
                kappa: calibration?.kappa ?? null,
                calibrationEvidence: calibration ?? null,
                eligibleAlarm: alarm,
                route: alarm ? 'coordinator-alarm' : null,
                decisionFindingId: computed ? null : result.value.finding.finding_id,
                error: computed ? null : (record?.error ?? (record ? null : 'unresolved-intent')),
              },
              calibrated && calibration ? calibration : undefined,
              hashCanonical(config),
              data.analysisId,
            ),
          )
        }
      }
      analystContext.signal.throwIfAborted()
      const saved = await ledger.append(context.runId, findings)
      if (!saved.succeeded)
        throw new Error(`Trace observations ${saved.error.kind}: ${saved.error.message}`)
      analystContext.signal.throwIfAborted()
      if (receipts === 0)
        context.recordUsage?.({
          calls: 0,
          tokens: { input: 0, output: 0 },
          cost: { kind: 'observed', usd: 0 },
        })
      return findings
    },
  }
}

function behavioralWindowState(window: BehavioralTraceWindow): SystemOneState {
  return {
    source: window.state,
    events: window.events.map(({ id, content }) => ({ id, content })),
    capture: window.capture,
    windowId: window.id,
    traceId: window.traceId,
    subject: window.subject,
    from: window.from,
    to: window.to,
  }
}

function observation(
  window: BehavioralTraceWindow,
  context: AnalystContext,
  questionId: BehavioralTraceQuestionId,
  metadata: Record<string, unknown>,
  calibration: { gold_n: number; agreement: number; kappa: number } | undefined,
  configDigest: string,
  analysisId: string,
): AnalystFinding {
  const computed = questionId === 'identical-tool-repeat'
  return makeFinding({
    analyst_id: 'efficiency-behavioral',
    area: 'behavioral-trace-question',
    subject: window.subject,
    produced_at: window.to,
    claim: `${BEHAVIORAL_TRACE_QUESTIONS[questionId].instructions.split('.')[0]}: ${metadata.answer ?? 'unavailable'}`,
    severity: metadata.eligibleAlarm ? 'medium' : 'info',
    confidence: computed && metadata.answer !== 'unsure' ? 1 : 0,
    layer: window.layer,
    scope: { population: [window.id], n: 1, window: { from: window.from, to: window.to } },
    method: {
      kind: computed ? 'computed' : 'judged',
      name: computed ? 'physical-tool-repeat' : 'behavioral-trace-questions',
      version: BEHAVIORAL_TRACE_QUESTIONS_VERSION,
      ...(!computed && calibration
        ? {
            calibration: {
              gold_n: calibration.gold_n,
              agreement: calibration.agreement,
              kappa: calibration.kappa,
            },
          }
        : {}),
    },
    derived_from_judge: !computed,
    evidence_refs: [
      ...window.evidenceRefs,
      ...(metadata.decisionFindingId
        ? [{ kind: 'finding' as const, uri: `finding://${metadata.decisionFindingId}` }]
        : []),
    ],
    ...(metadata.eligibleAlarm
      ? { recommended_action: 'Notify the coordinator for reversible investigation.' }
      : {}),
    metadata: {
      behavioral_trace_question: {
        ...metadata,
        questionId,
        windowId: window.id,
        traceId: window.traceId,
        configurationDigest: configDigest,
        capture: window.capture,
      },
    },
    id_basis: hashCanonical([
      context.runId,
      analysisId,
      window.id,
      window.layer,
      questionId,
      configDigest,
    ]),
  })
}
