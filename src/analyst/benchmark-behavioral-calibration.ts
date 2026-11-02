import { z } from 'zod'
import { DECISION_POINT_AUC_BAR, DECISION_POINT_MIN_KAPPA } from '../decision-point'
import { validDecisionIdentity } from '../decision-point-records'
import { type NominalAgreementOptions, nominalAgreement } from '../statistics/agreement-irr'
import { rocAuc } from '../statistics/comparison-effects'
import { type BootstrapInterval, clusterBootstrap } from '../statistics/internal'
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
import type { CalibrationInterval } from './finding-scope'
import type { AnalystFinding, EvidenceRef } from './types'

/** Independently acquired labels. Null and unsure are exclusions, never negative labels. */
export interface BehavioralTraceGold {
  questionId: BehavioralTraceQuestionId
  windowId: string
  label: BehavioralTraceAnswer | null
  source: 'human' | 'agentrx'
}
/** One-vs-rest reading of a class: precision and recall from hard answers; the AUC of its probability
 * (null without a scored member of each class) with a seeded cluster bootstrap; the AUC bar line. */
export interface ClassCalibration {
  precision: number | null
  recall: number | null
  auc: number | null
  ci: CalibrationInterval | null
  eligibleAuc: boolean
}
export interface BehavioralTraceCalibrationRow extends ClassCalibration {
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
  kappaCi: BootstrapInterval | null
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
export interface ChoiceGold {
  id: string
  label: string | null
}
export interface ChoicePrediction {
  id: string
  cluster?: string
  choice: string | null
  probabilities: Record<string, number> | null
}
/** `gold_n` is the gold items labeled with this option, `predicted` the labeled items that chose it. */
export interface ChoiceOptionCalibration extends ClassCalibration {
  option: string
  gold_n: number
  predicted: number
}
export interface ChoiceCalibration {
  options: string[]
  gold_n: number
  missingLabels: number
  missingPredictions: number
  abstentions: number
  agreement: number | null
  /** Multi-class Cohen's κ over the hard choices, with its cluster bootstrap. */
  kappa: number | null
  kappaCi: BootstrapInterval | null
  rows: ChoiceOptionCalibration[]
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
    traceId: identity.optional(),
    answer: answer.nullable(),
    probabilities: z.record(z.string(), z.number().finite()).nullable().optional(),
    questionDigest: z.string().nullable(),
    requestedModel: identity.nullable(),
    servedModel: identity.nullable(),
    support: behavioralTraceSupportSchema.optional(),
  })
  .passthrough()
const finite = (value: number) => (Number.isFinite(value) ? value : null)
const { auc: minAuc, ciLow, gold_n: minGold } = DECISION_POINT_AUC_BAR

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
  resamples?: number
  seed?: number
}): BehavioralTraceCalibrationRow[] {
  const predictions = new Map<string, z.infer<typeof predictionSchema> & { cluster: string }>()
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
    // Windows of one agent are resampled together; a finding without a subject clusters by trace.
    predictions.set(key, { ...row, cluster: finding.subject ?? row.traceId ?? row.windowId })
  }
  const bootstrap = { resamples: input.resamples, seed: input.seed, options: ['yes', 'no'] }
  return (Object.keys(BEHAVIORAL_TRACE_QUESTIONS) as BehavioralTraceQuestionId[]).map((id) => {
    const computed = id === 'identical-tool-repeat'
    const digest = behavioralTraceQuestionDigest({
      questionId: id,
      ...input,
      servedModel: computed ? null : input.servedModel,
    })
    const counts = { missingLabels: 0, unsureLabels: 0, sourceCounts: { human: 0, agentrx: 0 } }
    const confusion = {
      yes: { yes: 0, no: 0, unsure: 0, missing: 0 },
      no: { yes: 0, no: 0, unsure: 0, missing: 0 },
    }
    const disagreements: BehavioralTraceCalibrationRow['disagreements'] = []
    const labels: ChoiceGold[] = []
    const answers: ChoicePrediction[] = []
    for (const item of gold.filter((item) => item.questionId === id)) {
      if (item.label === null) {
        counts.missingLabels++
        continue
      }
      if (item.label === 'unsure') {
        counts.unsureLabels++
        continue
      }
      counts.sourceCounts[item.source]++
      const prediction = predictions.get(JSON.stringify([id, item.windowId]))
      const matches =
        prediction?.questionDigest === digest &&
        prediction.requestedModel === (computed ? null : input.model) &&
        prediction.servedModel === (computed ? null : input.servedModel)
      const value = matches ? prediction.answer : null
      confusion[item.label][value ?? 'missing']++
      if (value !== item.label) {
        const support = matches ? (prediction.support ?? null) : null
        if (support && support.map.windowId !== item.windowId)
          throw new TypeError('Behavioral support map is outside the prediction window')
        disagreements.push({
          windowId: item.windowId,
          expected: item.label,
          predicted: value,
          support: support ? structuredClone(support) : null,
        })
      }
      // Missing predictions remain disagreements in the denominator.
      labels.push({ id: item.windowId, label: item.label })
      if (matches)
        answers.push({
          id: item.windowId,
          cluster: prediction.cluster,
          choice: prediction.answer,
          probabilities: prediction.probabilities ?? null,
        })
    }
    const result = calibrateChoiceQuestion(labels, answers, bootstrap)
    const { option: _option, gold_n: positives, predicted: _predicted, ...yes } = result.rows[0]!
    const bothClasses = positives > 0 && positives < result.gold_n
    // A one-class sample or a missing prediction must never supply a certificate that can authorize actions.
    const certified = bothClasses && result.missingPredictions === 0 && result.kappa !== null
    const row: BehavioralTraceCalibrationRow = {
      questionId: id,
      layer: input.layer,
      method: computed ? 'computed' : 'judged',
      ...counts,
      gold_n: result.gold_n,
      missingPredictions: result.missingPredictions,
      abstentions: result.abstentions,
      agreement: result.agreement,
      kappa: result.kappa,
      kappaCi: result.kappaCi,
      ...yes,
      ci: yes.ci && { ...yes.ci, cluster: 'subject' },
      confusion,
      disagreements,
      eligible: certified && result.kappa! >= DECISION_POINT_MIN_KAPPA,
      calibration: null,
    }
    if (certified) {
      row.calibration = {
        gold_n: row.gold_n,
        agreement: row.agreement!,
        kappa: row.kappa!,
        auc: row.auc,
        ci: row.ci,
        questionDigest: digest,
        servedModel: computed ? null : input.servedModel,
        evidenceRefs: structuredClone(input.evidenceRefs),
      }
      validBehavioralCalibration(row.calibration)
    }
    return row
  })
}

/** A Choice question over any option set: a one-vs-rest row per option plus the multi-class κ. A null
 * or out-of-set gold label is an exclusion; an out-of-set choice an abstention, a null choice missing. */
export function calibrateChoiceQuestion(
  gold: readonly ChoiceGold[],
  findings: readonly ChoicePrediction[],
  options: NominalAgreementOptions & { options?: readonly string[] } = {},
): ChoiceCalibration {
  const predictions = new Map(findings.map((finding) => [finding.id, finding]))
  if (predictions.size !== findings.length) throw new TypeError('Duplicate choice prediction')
  const names = [
    ...(options.options ?? new Set(findings.flatMap((f) => Object.keys(f.probabilities ?? {})))),
  ]
  const labeled = gold.filter((item) => item.label !== null && names.includes(item.label))
  if (new Set(labeled.map((item) => item.id)).size !== labeled.length)
    throw new TypeError('Duplicate choice gold label')
  const joined = labeled.map((item) => ({ ...item, prediction: predictions.get(item.id) }))
  const cluster = (item: (typeof joined)[number]) => item.prediction?.cluster ?? item.id
  const agreement = nominalAgreement(
    joined.map((item) => [item.label!, item.prediction?.choice ?? '(missing prediction)'] as const),
    { ...options, clusters: joined.map(cluster) },
  )
  return {
    options: names,
    gold_n: agreement.n,
    missingLabels: gold.length - labeled.length,
    missingPredictions: joined.filter((item) => item.prediction?.choice == null).length,
    abstentions: joined.filter(
      (item) => item.prediction?.choice != null && !names.includes(item.prediction.choice),
    ).length,
    agreement: finite(agreement.agreement),
    kappa: finite(agreement.kappa),
    kappaCi: Number.isFinite(agreement.kappaCi.low) ? agreement.kappaCi : null,
    rows: names.map((option) => {
      const items = joined.map((item) => ({
        cluster: cluster(item),
        gold: item.label === option,
        chosen: item.prediction?.choice === option,
        score: item.prediction?.probabilities?.[option] ?? null,
      }))
      const chosen = items.filter((item) => item.chosen)
      const hits = chosen.filter((item) => item.gold).length
      const gold_n = items.filter((item) => item.gold).length
      // Precision and recall read every labeled item; the AUC and its interval read scored items only.
      const scored = items.filter((item) => item.score !== null)
      const area = (sample: typeof items) =>
        rocAuc(
          sample.map((i) => i.score!),
          sample.map((i) => Number(i.gold)),
        ) ?? Number.NaN
      const auc = finite(scored.length ? area(scored) : Number.NaN)
      const boot = auc !== null && clusterBootstrap(scored, (i) => i.cluster, area, options)
      const ci = boot && Number.isFinite(boot.low) ? { ...boot, cluster: 'cluster' } : null
      return {
        option,
        gold_n,
        predicted: chosen.length,
        precision: chosen.length ? hits / chosen.length : null,
        recall: gold_n ? hits / gold_n : null,
        auc,
        ci,
        eligibleAuc: ci !== null && auc! >= minAuc && ci.low >= ciLow && gold_n >= minGold,
      }
    }),
  }
}
