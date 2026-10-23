import { z } from 'zod'
import { findingCalibrationSchema, findingEvidenceRefSchema } from './analyst/finding-primitives'
import type { FindingsLedger, FindingsLedgerOutcome } from './analyst/findings-ledger'
import type { AnalystFinding } from './analyst/types'
import { calibrationFromPairs } from './meta-eval/calibration'
import { SYSTEM_ONE_PROBABILITY_TOLERANCE } from './systemone-protocol'

const identity = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value)
export function validDecisionIdentity(value: unknown): value is string {
  return identity.safeParse(value).success
}

export const decisionCalibrationSchema = findingCalibrationSchema
  .extend({
    questionDigest: identity,
    servedModel: identity,
    evidenceRefs: z.array(findingEvidenceRefSchema).min(1),
  })
  .strict()

export const decisionObservationSchema = z
  .object({
    runId: identity,
    invocationId: identity,
    labels: z.record(identity, identity).refine((labels) => Object.keys(labels).length > 0),
    at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    evidenceRefs: z.array(findingEvidenceRefSchema).min(1),
  })
  .strict()

const probability = z.number().finite().min(0).max(1)
export const decisionRouteSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('act'), route: identity }).strict(),
  z.object({ action: z.literal('escalate') }).strict(),
  z.object({ action: z.literal('record') }).strict(),
])

/** A routing recommendation; the consumer retains execution authority. */
export type DecisionRoute = z.infer<typeof decisionRouteSchema>

const answerSchema = z
  .object({
    probabilities: z.record(identity, probability),
    choice: identity,
    recommendation: decisionRouteSchema,
    reason: z.enum(['threshold', 'uncalibrated', 'uncertain', 'model-mismatch']),
  })
  .strict()
  .refine(
    (answer) => {
      const entries = Object.entries(answer.probabilities)
      return (
        entries.length >= 2 &&
        Object.hasOwn(answer.probabilities, answer.choice) &&
        Math.abs(entries.reduce((sum, [, value]) => sum + value, 0) - 1) <=
          SYSTEM_ONE_PROBABILITY_TOLERANCE &&
        entries.every(
          ([, value]) =>
            value - answer.probabilities[answer.choice]! <= SYSTEM_ONE_PROBABILITY_TOLERANCE,
        )
      )
    },
    { message: 'Invalid answer distribution or selected option' },
  )

const decisionRecordSchema = z
  .object({
    kind: z.literal('decision'),
    pointId: identity,
    definition: z.unknown(),
    consumer: identity,
    definitionDigest: identity,
    invocationId: identity,
    inputDigest: identity,
    stateDigest: identity,
    requestedModel: identity,
    servedModel: identity.nullable(),
    action: z.enum(['act', 'escalate', 'record']),
    answers: z.record(identity, answerSchema),
    error: z.enum(['evaluation-failed', 'cancelled']).nullable(),
    receipt: z.unknown().optional(),
  })
  .strict()

export type DecisionRecord = z.infer<typeof decisionRecordSchema>

const outcomeSchema = z
  .object({
    kind: z.literal('decision-outcome'),
    definitionDigest: identity,
    decisionFindingId: identity,
    labels: z.record(identity, identity),
  })
  .strict()

/** Decode only records this owner wrote; foreign metadata never counts as a label. */
export function readDecisionRecord(finding: AnalystFinding): DecisionRecord | null {
  if (finding.analyst_id !== 'decision-point' || finding.area !== 'decision-point') return null
  const parsed = decisionRecordSchema.safeParse(finding.metadata?.decision_point)
  return parsed.success ? parsed.data : null
}

/** Joins labeled answers, never workflow success, to the stored distributions. */
export async function decisionPointReliability(
  ledger: FindingsLedger,
  definitionDigest: string,
  questionNames: readonly string[],
): Promise<
  FindingsLedgerOutcome<{
    ledgerRoot: string
    attempts: number
    unresolved: number
    decisions: number
    failed: number
    labeled: number
    missingOutcomes: number
    questions: Record<
      string,
      {
        n: number
        predictions: number
        missingLabels: number
        curve: ReturnType<typeof calibrationFromPairs>
        thresholds: Array<{ threshold: number; n: number; accuracy: number }>
      }
    >
  }>
> {
  const read = await ledger.read()
  if (!read.succeeded) return read
  const decisions: Array<{
    finding: (typeof read.value.findings)[number]
    record: DecisionRecord
  }> = []
  for (const finding of read.value.findings) {
    if (
      finding.analyst_id !== 'decision-point' ||
      finding.area !== 'decision-point' ||
      (finding.metadata?.decision_point as Record<string, unknown> | undefined)
        ?.definitionDigest !== definitionDigest
    )
      continue
    const record = readDecisionRecord(finding)
    if (!record)
      return {
        succeeded: false,
        error: {
          kind: 'invalid',
          message: 'Malformed decision record cannot enter reliability measurements',
        },
      }
    decisions.push({ finding, record })
  }
  const outcomes = new Map<string, string>()
  for (const finding of read.value.findings) {
    if (finding.analyst_id !== 'decision-point' || finding.area !== 'decision-outcome') continue
    const parsed = outcomeSchema.safeParse(finding.metadata?.decision_point)
    if (parsed.success && parsed.data.definitionDigest === definitionDigest) {
      for (const [question, label] of Object.entries(parsed.data.labels)) {
        const key = JSON.stringify([finding.run_id, parsed.data.decisionFindingId, question])
        if (outcomes.has(key))
          return {
            succeeded: false,
            error: { kind: 'conflict', message: 'Duplicate decision outcome' },
          }
        outcomes.set(key, label)
      }
    }
  }
  const pairs = new Map(
    questionNames.map((name) => [name, [] as Array<{ evalScore: number; outcome: number }>]),
  )
  const predictions = new Map(questionNames.map((name) => [name, 0]))
  let labeled = 0
  for (const { finding, record } of decisions) {
    let complete = Object.keys(record.answers).length > 0
    for (const [question, answer] of Object.entries(record.answers)) {
      predictions.set(question, (predictions.get(question) ?? 0) + 1)
      const label = outcomes.get(JSON.stringify([finding.run_id, finding.finding_id, question]))
      if (label === undefined) {
        complete = false
        continue
      }
      if (!Object.hasOwn(answer.probabilities, label))
        return {
          succeeded: false,
          error: { kind: 'invalid', message: 'Outcome does not label a stored answer' },
        }
      const list = pairs.get(question) ?? []
      list.push({
        evalScore: answer.probabilities[answer.choice]!,
        outcome: Number(answer.choice === label),
      })
      pairs.set(question, list)
    }
    if (complete) labeled++
  }
  const attempts = read.value.findings.filter(
    (finding) =>
      finding.analyst_id === 'decision-point' &&
      finding.area === 'decision-intent' &&
      (finding.metadata?.decision_point as Record<string, unknown> | undefined)
        ?.definitionDigest === definitionDigest,
  ).length
  return {
    succeeded: true,
    value: {
      ledgerRoot: read.value.merkleRoot,
      attempts,
      unresolved: attempts - decisions.length,
      failed: decisions.filter(({ record }) => record.error !== null).length,
      decisions: decisions.length,
      labeled,
      missingOutcomes: decisions.length - labeled,
      questions: Object.fromEntries(
        [...pairs].map(([question, values]) => [
          question,
          {
            n: values.length,
            predictions: predictions.get(question) ?? 0,
            missingLabels: (predictions.get(question) ?? 0) - values.length,
            curve: calibrationFromPairs(values, question, 'observed-answer-correct', {
              range: { lo: 0, hi: 1 },
            }),
            // Development evidence for an explicit policy revision, never an automatic activation.
            thresholds: [...new Set(values.map((pair) => pair.evalScore))]
              .sort((a, b) => a - b)
              .map((threshold) => {
                const selected = values.filter((pair) => pair.evalScore >= threshold)
                return {
                  threshold,
                  n: selected.length,
                  accuracy: selected.reduce((sum, pair) => sum + pair.outcome, 0) / selected.length,
                }
              }),
          },
        ]),
      ),
    },
  }
}
