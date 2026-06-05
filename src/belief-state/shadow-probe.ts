import type { BeliefDecisionKind, BeliefDecisionOutcome, BeliefDecisionPoint } from './types'

export interface BeliefShadowProbeInput {
  probeId: string
  decisionId: string
  runId: string
  scenarioId?: string
  stepIndex: number
  decisionKind: BeliefDecisionKind
  candidateActions: string[]
  observedAction?: string
  evidence: BeliefShadowProbeEvidenceRef[]
  context?: string
  metadata?: Record<string, unknown>
}

export interface BeliefShadowProbeEvidenceRef {
  id: string
  source: string
  detail?: string
}

export interface BeliefShadowProbeResponse {
  predictedAction: string
  confidence: number
  beliefSummary?: string
  uncertainty?: string[]
  evidenceRefs?: string[]
  wouldChangeMindIf?: string[]
  targetProb?: number
  qHat?: number | null
  metadata?: Record<string, unknown>
}

export interface BeliefShadowProbeRecord extends BeliefShadowProbeResponse {
  probeId: string
  decisionId: string
  runId: string
  scenarioId?: string
  stepIndex: number
  decisionKind: BeliefDecisionKind
  candidateActions: string[]
  observedAction: string
  agreesWithObservedAction: boolean
  outcome?: BeliefDecisionOutcome
}

export interface BeliefShadowProbeDiagnostic {
  decisionId: string
  severity: 'warning' | 'error'
  reason: string
}

export interface BeliefShadowProbeSummary {
  attempted: number
  completed: number
  dropped: number
  withOutcome: number
  withTargetProb: number
  meanConfidence: number | null
  observedAgreementRate: number | null
}

export interface BeliefShadowProbeRun {
  probeId: string
  records: BeliefShadowProbeRecord[]
  diagnostics: BeliefShadowProbeDiagnostic[]
  summary: BeliefShadowProbeSummary
}

export interface RunBeliefShadowProbeOptions {
  probeId: string
  points: BeliefDecisionPoint[]
  probe: (
    input: BeliefShadowProbeInput,
  ) => BeliefShadowProbeResponse | Promise<BeliefShadowProbeResponse>
  contextOf?: (point: BeliefDecisionPoint) => string | undefined | Promise<string | undefined>
  metadataOf?: (
    point: BeliefDecisionPoint,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  includeObservedAction?: boolean
  includeEvidenceDetail?: boolean
  includeOutcomeInRecord?: boolean
  requireCandidateActions?: boolean
  allowOutOfSetActions?: boolean
  concurrency?: number
  maxContextChars?: number
}

const DEFAULT_CONCURRENCY = 4
const DEFAULT_MAX_CONTEXT_CHARS = 12_000

export async function runBeliefShadowProbe(
  options: RunBeliefShadowProbeOptions,
): Promise<BeliefShadowProbeRun> {
  const concurrency = boundedInteger(options.concurrency ?? DEFAULT_CONCURRENCY, 1, 32)
  const records: Array<BeliefShadowProbeRecord | undefined> = []
  const diagnostics: BeliefShadowProbeDiagnostic[] = []
  let next = 0

  async function worker() {
    while (next < options.points.length) {
      const index = next
      next += 1
      const point = options.points[index]
      if (!point) continue
      const result = await probePoint(point, options)
      records[index] = result.record
      diagnostics.push(...result.diagnostics)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, options.points.length) }, worker))
  const completed = records.filter((record): record is BeliefShadowProbeRecord => !!record)

  return {
    probeId: options.probeId,
    records: completed,
    diagnostics,
    summary: summarizeShadowProbe(options.points.length, completed),
  }
}

export function formatBeliefShadowProbePrompt(input: BeliefShadowProbeInput): string {
  return [
    'Return only JSON. Do not include chain-of-thought.',
    'Infer the agent belief state at this decision boundary using only the context below.',
    '',
    `decisionKind: ${input.decisionKind}`,
    `candidateActions: ${JSON.stringify(input.candidateActions)}`,
    input.observedAction ? `observedAction: ${JSON.stringify(input.observedAction)}` : '',
    input.context ? `context:\n${input.context}` : '',
    '',
    'Schema:',
    JSON.stringify({
      predictedAction: 'one candidate action',
      confidence: 'number in [0,1]',
      beliefSummary: 'short outcome-blind summary',
      uncertainty: ['short uncertainty'],
      evidenceRefs: ['evidence id'],
      wouldChangeMindIf: ['observable evidence'],
      targetProb: 'optional number in [0,1]',
      qHat: 'optional number in [0,1]',
    }),
  ]
    .filter(Boolean)
    .join('\n')
}

async function probePoint(
  point: BeliefDecisionPoint,
  options: RunBeliefShadowProbeOptions,
): Promise<{ record?: BeliefShadowProbeRecord; diagnostics: BeliefShadowProbeDiagnostic[] }> {
  const diagnostics: BeliefShadowProbeDiagnostic[] = []
  const candidateActions = uniqueStrings(point.candidateActions ?? [])
  if ((options.requireCandidateActions ?? true) && candidateActions.length === 0) {
    diagnostics.push({
      decisionId: point.id,
      severity: 'warning',
      reason: 'missing candidateActions',
    })
    return { diagnostics }
  }

  let response: BeliefShadowProbeResponse
  try {
    response = await options.probe({
      probeId: options.probeId,
      decisionId: point.id,
      runId: point.runId,
      scenarioId: point.scenarioId,
      stepIndex: point.stepIndex,
      decisionKind: point.kind,
      candidateActions,
      ...(options.includeObservedAction ? { observedAction: point.chosenAction } : {}),
      evidence: point.evidence.map((ref) => ({
        id: ref.id,
        source: ref.source,
        ...(options.includeEvidenceDetail && ref.detail ? { detail: ref.detail } : {}),
      })),
      context: trimText(await options.contextOf?.(point), options.maxContextChars),
      metadata: await options.metadataOf?.(point),
    })
  } catch (error) {
    diagnostics.push({
      decisionId: point.id,
      severity: 'error',
      reason: `probe threw: ${errorMessage(error)}`,
    })
    return { diagnostics }
  }

  const normalized = normalizeProbeResponse(response, {
    point,
    candidateActions,
    allowOutOfSetActions: options.allowOutOfSetActions ?? false,
  })
  if (!normalized.record) {
    diagnostics.push(...normalized.diagnostics)
    return { diagnostics }
  }

  return {
    record: {
      probeId: options.probeId,
      decisionId: point.id,
      runId: point.runId,
      scenarioId: point.scenarioId,
      stepIndex: point.stepIndex,
      decisionKind: point.kind,
      candidateActions,
      observedAction: point.chosenAction,
      agreesWithObservedAction: normalized.record.predictedAction === point.chosenAction,
      ...(options.includeOutcomeInRecord === false ? {} : { outcome: point.outcome }),
      ...normalized.record,
    },
    diagnostics,
  }
}

function normalizeProbeResponse(
  response: BeliefShadowProbeResponse,
  options: {
    point: BeliefDecisionPoint
    candidateActions: string[]
    allowOutOfSetActions: boolean
  },
): { record?: BeliefShadowProbeResponse; diagnostics: BeliefShadowProbeDiagnostic[] } {
  const diagnostics: BeliefShadowProbeDiagnostic[] = []
  const predictedAction = stringOrNull(response.predictedAction)
  if (!predictedAction) {
    diagnostics.push({
      decisionId: options.point.id,
      severity: 'error',
      reason: 'missing predictedAction',
    })
  } else if (
    !options.allowOutOfSetActions &&
    options.candidateActions.length > 0 &&
    !options.candidateActions.includes(predictedAction)
  ) {
    diagnostics.push({
      decisionId: options.point.id,
      severity: 'error',
      reason: `predictedAction ${predictedAction} is not in candidateActions`,
    })
  }

  if (!isUnitProbability(response.confidence)) {
    diagnostics.push({
      decisionId: options.point.id,
      severity: 'error',
      reason: `invalid confidence ${String(response.confidence)}`,
    })
  }
  if (response.targetProb !== undefined && !isUnitProbability(response.targetProb)) {
    diagnostics.push({
      decisionId: options.point.id,
      severity: 'error',
      reason: `invalid targetProb ${String(response.targetProb)}`,
    })
  }
  if (response.qHat !== undefined && response.qHat !== null && !isUnitProbability(response.qHat)) {
    diagnostics.push({
      decisionId: options.point.id,
      severity: 'error',
      reason: `invalid qHat ${String(response.qHat)}`,
    })
  }
  if (diagnostics.length > 0 || !predictedAction) return { diagnostics }

  return {
    record: {
      predictedAction,
      confidence: response.confidence,
      ...(response.beliefSummary ? { beliefSummary: trimText(response.beliefSummary, 2_000) } : {}),
      uncertainty: compactStrings(response.uncertainty),
      evidenceRefs: compactStrings(response.evidenceRefs),
      wouldChangeMindIf: compactStrings(response.wouldChangeMindIf),
      ...(response.targetProb !== undefined ? { targetProb: response.targetProb } : {}),
      ...(response.qHat !== undefined ? { qHat: response.qHat } : {}),
      ...(response.metadata ? { metadata: response.metadata } : {}),
    },
    diagnostics,
  }
}

function summarizeShadowProbe(
  attempted: number,
  records: BeliefShadowProbeRecord[],
): BeliefShadowProbeSummary {
  const confidences = records.map((record) => record.confidence)
  const agreements = records.filter((record) => record.agreesWithObservedAction).length
  return {
    attempted,
    completed: records.length,
    dropped: attempted - records.length,
    withOutcome: records.filter((record) => record.outcome !== undefined).length,
    withTargetProb: records.filter((record) => record.targetProb !== undefined).length,
    meanConfidence: confidences.length > 0 ? mean(confidences) : null,
    observedAgreementRate: records.length > 0 ? agreements / records.length : null,
  }
}

function isUnitProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function compactStrings(values: unknown, maxItems = 12): string[] {
  if (!Array.isArray(values)) return []
  return values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .slice(0, maxItems)
    .map((value) => trimText(value, 500) ?? '')
    .filter(Boolean)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function trimText(
  value: string | undefined,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): string | undefined {
  if (!value) return undefined
  return value.length > maxChars ? value.slice(value.length - maxChars) : value
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
