import { z } from 'zod'
import { decisionCalibrationSchema, validDecisionIdentity } from '../decision-point-records'
import { canonicalString, hashCanonical } from '../ledger-core/canonical'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import {
  BEHAVIORAL_TRACE_QUESTIONS,
  type BehavioralQuestionCalibration,
  type BehavioralTraceQuestionsOptions,
  type BehavioralTraceWindow,
} from './behavioral-trace-questions'
import { snapshotExactExecutionComponentIdentity } from './exact-types'
import { findingCalibrationSchema, findingEvidenceRefSchema } from './finding-primitives'

const identity = z.string().refine(validDecisionIdentity)
const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)))
const calibrationSchema = findingCalibrationSchema
  .extend({
    questionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    servedModel: identity.nullable(),
    evidenceRefs: z.array(findingEvidenceRefSchema).min(1),
  })
  .strict()
const windowSchema = z
  .object({
    id: identity,
    traceId: identity,
    subject: identity,
    layer: z.enum(['event', 'turn', 'agent']),
    from: timestamp,
    to: timestamp,
    state: z
      .unknown()
      .refine((x) => typeof x === 'string' || (x !== null && typeof x === 'object')),
    capture: z.object({ complete: z.boolean(), limitations: z.array(identity) }).strict(),
    evidenceRefs: z.array(findingEvidenceRefSchema).min(1),
    toolCalls: z
      .object({
        complete: z.boolean(),
        attempts: z.array(z.object({ id: identity, name: identity, args: z.unknown() }).strict()),
      })
      .strict()
      .optional(),
  })
  .strict()

export function validBehavioralCalibration(value: BehavioralQuestionCalibration): void {
  calibrationSchema.parse(value)
}

/** Validate and freeze all caller data before the first paid request. */
export function prepareBehavioralTraceQuestions(options: BehavioralTraceQuestionsOptions) {
  const limits = {
    maxWindows: options.maxWindows ?? 12,
    maxWindowBytes: options.maxWindowBytes ?? 64_000,
    minimumProbability: options.minimumProbability ?? 0.9,
    minimumMargin: options.minimumMargin ?? 0.2,
  }
  for (const limit of [limits.maxWindows, limits.maxWindowBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('Invalid trace question limit')
  }
  for (const limit of [limits.minimumProbability, limits.minimumMargin]) {
    if (!Number.isFinite(limit) || limit < 0 || limit > 1)
      throw new RangeError('Invalid question threshold')
  }
  snapshotExactExecutionComponentIdentity(options.evaluatorIdentity, 'behavioral evaluator')
  identity.parse(options.analysisId)
  identity.parse(options.model)
  z.object({
    id: identity,
    version: identity,
    config: z.record(z.string(), z.unknown()).optional(),
  })
    .strict()
    .parse(options.windowPolicy)
  const data = structuredClone({
    ...limits,
    analysisId: options.analysisId,
    model: options.model,
    windowPolicy: options.windowPolicy,
    evaluatorIdentity: options.evaluatorIdentity,
    windows: options.windows,
    calibrations: options.calibrations ?? {},
  })
  hashCanonical(data)
  if (data.windows.length > limits.maxWindows)
    throw new RangeError('Too many trace question windows')
  const ids = new Set<string>()
  for (const window of data.windows) {
    windowSchema.parse(window)
    if (ids.has(window.id)) throw new TypeError(`Duplicate trace window '${window.id}'`)
    ids.add(window.id)
    if (Date.parse(window.from) > Date.parse(window.to))
      throw new TypeError('Inverted trace window')
    if (!window.capture.complete && !window.capture.limitations.length)
      throw new TypeError('An incomplete trace window must name its limitations')
    if (Buffer.byteLength(canonicalString(window)) > limits.maxWindowBytes)
      throw new RangeError(`Trace window '${window.id}' exceeds maxWindowBytes`)
    repeatedToolAnswer(window) // Also refuses conflicting physical attempt identities up front.
  }
  for (const [layer, calibrations] of Object.entries(data.calibrations)) {
    if (!['event', 'turn', 'agent'].includes(layer))
      throw new TypeError('Unknown calibration layer')
    for (const [question, calibration] of Object.entries(calibrations)) {
      if (!Object.hasOwn(BEHAVIORAL_TRACE_QUESTIONS, question))
        throw new TypeError('Unknown calibration question')
      validBehavioralCalibration(calibration)
      if (question === 'identical-tool-repeat') {
        if (calibration.servedModel !== null)
          throw new TypeError('Computed calibration has no served model')
      } else decisionCalibrationSchema.parse(calibration)
    }
  }
  return deepFreezeCanonicalJson(data)
}

/** Replayed capture rows are not new physical attempts. Incomplete absence remains unsure. */
export function repeatedToolAnswer(window: BehavioralTraceWindow): 'yes' | 'no' | 'unsure' {
  if (!window.toolCalls) return 'unsure'
  const attempts = new Map<string, string>()
  const payloads = new Set<string>()
  let repeated = false
  for (const attempt of window.toolCalls.attempts) {
    const payload = canonicalString({ name: attempt.name, args: attempt.args })
    const previous = attempts.get(attempt.id)
    if (previous !== undefined) {
      if (previous !== payload) throw new TypeError('Conflicting physical tool attempt identity')
      continue
    }
    attempts.set(attempt.id, payload)
    if (payloads.has(payload)) repeated = true
    payloads.add(payload)
  }
  return repeated ? 'yes' : window.toolCalls.complete ? 'no' : 'unsure'
}
