import { z } from 'zod'
import { DECISION_POINT_MIN_KAPPA } from '../decision-point'
import { validDecisionIdentity } from '../decision-point-records'
import { nominalAgreement } from '../statistics/agreement-irr'
import {
  BEHAVIORAL_TRACE_QUESTIONS,
  type BehavioralQuestionCalibration,
  type BehavioralTraceAnswer,
  type BehavioralTraceLayer,
  type BehavioralTraceQuestionId,
  type BehavioralTraceSupport,
  type BehavioralWindowPolicy,
  behavioralTraceQuestionDigest,
} from './behavioral-trace-questions'
import { behavioralTraceSupportSchema } from './behavioral-trace-support'
import { validBehavioralCalibration } from './behavioral-trace-validation'
import type { ExactExecutionComponentIdentity } from './exact-types'
import type { AnalystFinding, EvidenceRef } from './types'

/** Independently acquired labels. Null and unsure are exclusions, never negative labels. */
export interface BehavioralTraceGold {
  questionId: BehavioralTraceQuestionId
  windowId: string
  label: BehavioralTraceAnswer | null
  source: 'human' | 'agentrx'
}
export interface BehavioralTraceCalibrationRow {
  questionId: BehavioralTraceQuestionId
  layer: BehavioralTraceLayer
  method: 'computed' | 'judged'
  gold_n: number
  missingLabels: number
  unsureLabels: number
  missingPredictions: number
  abstentions: number
  sourceCounts: { human: number; agentrx: number }
  agreement: number | null
  kappa: number | null
  confusion: Record<'yes' | 'no', Record<'yes' | 'no' | 'unsure' | 'missing', number>>
  /** Wrong/unsure/missing semantic answers retain the selected event and complete scoped map.
   * Cross-map nominal agreement is separate from exact-definition decision reliability. */
  disagreements: Array<{
    windowId: string
    expected: 'yes' | 'no'
    predicted: BehavioralTraceAnswer | null
    support: BehavioralTraceSupport | null
  }>
  eligible: boolean
  /** Finite measured evidence, even if it misses the activation bar. */
  calibration: BehavioralQuestionCalibration | null
}
const identity = z.string().refine(validDecisionIdentity)
const questionId = z.enum(
  Object.keys(BEHAVIORAL_TRACE_QUESTIONS) as [
    BehavioralTraceQuestionId,
    ...BehavioralTraceQuestionId[],
  ],
)
const answer = z.enum(['yes', 'no', 'unsure'])
const goldSchema = z
  .object({
    questionId,
    windowId: identity,
    label: answer.nullable(),
    source: z.enum(['human', 'agentrx']),
  })
  .strict()
const predictionSchema = z
  .object({
    questionId,
    windowId: identity,
    answer: answer.nullable(),
    questionDigest: z.string().nullable(),
    requestedModel: identity.nullable(),
    servedModel: identity.nullable(),
    support: behavioralTraceSupportSchema.optional(),
  })
  .passthrough()

/** Same nominalAgreement owner as the existing AgentRx/failure-mode calibration path. */
export function calibrateBehavioralTraceQuestions(input: {
  layer: BehavioralTraceLayer
  windowPolicy: BehavioralWindowPolicy
  model: string
  servedModel: string
  evaluatorIdentity: ExactExecutionComponentIdentity
  gold: readonly BehavioralTraceGold[]
  findings: readonly AnalystFinding[]
  evidenceRefs: EvidenceRef[]
}): BehavioralTraceCalibrationRow[] {
  const predictions = new Map<string, z.infer<typeof predictionSchema>>()
  const gold = input.gold.map((row) => goldSchema.parse(row))
  const seen = new Set<string>()
  for (const row of gold) {
    const key = JSON.stringify([row.questionId, row.windowId])
    if (seen.has(key)) throw new TypeError('Duplicate behavioral gold label')
    seen.add(key)
  }
  for (const finding of input.findings) {
    if (finding.area !== 'behavioral-trace-question' || finding.layer !== input.layer) continue
    const row = predictionSchema.parse(finding.metadata?.behavioral_trace_question)
    if (
      row.support &&
      (row.support.map.windowId !== row.windowId ||
        row.support.method !== (row.questionId === 'identical-tool-repeat' ? 'computed' : 'judged'))
    )
      throw new TypeError('Behavioral support does not match its prediction')
    const key = JSON.stringify([row.questionId, row.windowId])
    if (predictions.has(key)) throw new TypeError('Duplicate behavioral prediction')
    predictions.set(key, row)
  }
  return (Object.keys(BEHAVIORAL_TRACE_QUESTIONS) as BehavioralTraceQuestionId[]).map((id) => {
    const computed = id === 'identical-tool-repeat'
    const digest = behavioralTraceQuestionDigest({
      questionId: id,
      ...input,
      servedModel: computed ? null : input.servedModel,
    })
    const row: BehavioralTraceCalibrationRow = {
      questionId: id,
      layer: input.layer,
      method: computed ? 'computed' : 'judged',
      gold_n: 0,
      missingLabels: 0,
      unsureLabels: 0,
      missingPredictions: 0,
      abstentions: 0,
      sourceCounts: { human: 0, agentrx: 0 },
      agreement: null,
      kappa: null,
      confusion: {
        yes: { yes: 0, no: 0, unsure: 0, missing: 0 },
        no: { yes: 0, no: 0, unsure: 0, missing: 0 },
      },
      disagreements: [],
      eligible: false,
      calibration: null,
    }
    const pairs: Array<readonly [string, string]> = []
    for (const item of gold.filter((item) => item.questionId === id)) {
      if (item.label === null) {
        row.missingLabels++
        continue
      }
      if (item.label === 'unsure') {
        row.unsureLabels++
        continue
      }
      row.sourceCounts[item.source]++
      const prediction = predictions.get(JSON.stringify([id, item.windowId]))
      const matches =
        prediction?.questionDigest === digest &&
        prediction.requestedModel === (computed ? null : input.model) &&
        prediction.servedModel === (computed ? null : input.servedModel)
      const value = matches ? prediction.answer : null
      if (value === null) row.missingPredictions++
      if (value === 'unsure') row.abstentions++
      row.confusion[item.label][value ?? 'missing']++
      if (value !== item.label) {
        const support = matches ? (prediction.support ?? null) : null
        if (support && support.map.windowId !== item.windowId)
          throw new TypeError('Behavioral support map is outside the prediction window')
        row.disagreements.push({
          windowId: item.windowId,
          expected: item.label,
          predicted: value,
          support: support ? structuredClone(support) : null,
        })
      }
      // Missing predictions remain disagreements in the denominator.
      pairs.push([item.label, value ?? '(missing prediction)'])
    }
    const agreement = nominalAgreement(pairs)
    row.gold_n = agreement.n
    row.agreement = Number.isFinite(agreement.agreement) ? agreement.agreement : null
    row.kappa = Number.isFinite(agreement.kappa) ? agreement.kappa : null
    if (row.gold_n > 0 && row.agreement !== null && row.kappa !== null) {
      row.calibration = {
        gold_n: row.gold_n,
        agreement: row.agreement,
        kappa: row.kappa,
        questionDigest: digest,
        servedModel: computed ? null : input.servedModel,
        evidenceRefs: structuredClone(input.evidenceRefs),
      }
      validBehavioralCalibration(row.calibration)
    }
    const bothClasses =
      row.confusion.yes.yes +
        row.confusion.yes.no +
        row.confusion.yes.unsure +
        row.confusion.yes.missing >
        0 &&
      row.confusion.no.yes +
        row.confusion.no.no +
        row.confusion.no.unsure +
        row.confusion.no.missing >
        0
    row.eligible =
      bothClasses &&
      row.missingPredictions === 0 &&
      row.kappa !== null &&
      row.kappa >= DECISION_POINT_MIN_KAPPA
    // A one-class sample must never supply a certificate that can authorize actions.
    if (!bothClasses || row.missingPredictions > 0) row.calibration = null
    return row
  })
}
