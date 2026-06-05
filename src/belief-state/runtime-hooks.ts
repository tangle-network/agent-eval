import type { BeliefShadowProbeInput } from './shadow-probe'
import type {
  BeliefDecisionKind,
  BeliefDecisionOutcome,
  BeliefDecisionPoint,
  BeliefEvidenceQuality,
  BeliefEvidenceRef,
} from './types'
import { isBeliefDecisionKind, isBeliefEvidenceSource } from './types'

export interface RuntimeBeliefDecisionEvidenceRef {
  source: string
  id: string
  detail?: string
  quality?: BeliefEvidenceQuality
  metadata?: Record<string, unknown>
}

export interface RuntimeBeliefDecisionPoint {
  id: string
  runId: string
  scenarioId?: string
  stepIndex: number
  kind: string
  candidateActions?: string[]
  context?: string
  evidence?: RuntimeBeliefDecisionEvidenceRef[]
  metadata?: Record<string, unknown>
}

export interface RuntimeBeliefHookContext {
  signal?: AbortSignal
}

export interface RuntimeBeliefHooks {
  onDecisionPoint?: (
    point: RuntimeBeliefDecisionPoint,
    context: RuntimeBeliefHookContext,
  ) => void | Promise<void>
}

export interface RuntimeBeliefConversionDiagnostic {
  decisionId: string
  severity: 'warning' | 'error'
  reason: string
}

export interface RuntimeBeliefShadowProbeInputOptions {
  probeId: string
  decisionKind?: BeliefDecisionKind
  includeEvidenceDetail?: boolean
  maxContextChars?: number
}

export interface RuntimeBeliefDecisionPointOptions {
  chosenAction?: string
  decisionKind?: BeliefDecisionKind
  confidence?: number
  behaviorProb?: number
  targetProb?: number
  qHat?: number | null
  costUsd?: number
  outcome?: BeliefDecisionOutcome
  metadata?: Record<string, unknown>
}

export interface RuntimeBeliefShadowProbeInputReport {
  input?: BeliefShadowProbeInput
  diagnostics: RuntimeBeliefConversionDiagnostic[]
}

export interface RuntimeBeliefDecisionPointReport {
  point?: BeliefDecisionPoint
  diagnostics: RuntimeBeliefConversionDiagnostic[]
}

export interface BeliefRuntimeHookCollector {
  hooks: RuntimeBeliefHooks
  decisions: RuntimeBeliefDecisionPoint[]
  toShadowProbeInputs(options?: Partial<RuntimeBeliefShadowProbeInputOptions>): {
    inputs: BeliefShadowProbeInput[]
    diagnostics: RuntimeBeliefConversionDiagnostic[]
  }
  clear(): void
}

const DEFAULT_MAX_CONTEXT_CHARS = 12_000

export function runtimeDecisionPointToBeliefShadowProbeInput(
  point: RuntimeBeliefDecisionPoint,
  options: RuntimeBeliefShadowProbeInputOptions,
): RuntimeBeliefShadowProbeInputReport {
  const diagnostics: RuntimeBeliefConversionDiagnostic[] = []
  const decisionKind = resolveDecisionKind(point, options.decisionKind, diagnostics)
  if (!decisionKind) return { diagnostics }

  return {
    input: {
      probeId: options.probeId,
      decisionId: point.id,
      runId: point.runId,
      scenarioId: point.scenarioId,
      stepIndex: point.stepIndex,
      decisionKind,
      candidateActions: uniqueStrings(point.candidateActions ?? []),
      evidence: (point.evidence ?? []).map((ref) => ({
        id: ref.id,
        source: ref.source,
        ...(options.includeEvidenceDetail && ref.detail ? { detail: ref.detail } : {}),
        ...(ref.quality ? { quality: ref.quality } : {}),
      })),
      context: trimText(point.context, options.maxContextChars),
      metadata: point.metadata,
    },
    diagnostics,
  }
}

export function runtimeDecisionPointToBeliefDecisionPoint(
  point: RuntimeBeliefDecisionPoint,
  options: RuntimeBeliefDecisionPointOptions,
): RuntimeBeliefDecisionPointReport {
  const diagnostics: RuntimeBeliefConversionDiagnostic[] = []
  const decisionKind = resolveDecisionKind(point, options.decisionKind, diagnostics)
  const chosenAction = stringOrUndefined(options.chosenAction)

  if (!chosenAction) {
    diagnostics.push({
      decisionId: point.id,
      severity: 'error',
      reason: 'missing chosenAction',
    })
  }

  const candidateActions = uniqueStrings(point.candidateActions ?? [])
  if (chosenAction && candidateActions.length > 0 && !candidateActions.includes(chosenAction)) {
    diagnostics.push({
      decisionId: point.id,
      severity: 'warning',
      reason: `chosenAction ${chosenAction} is not in candidateActions`,
    })
  }

  if (!decisionKind || !chosenAction) return { diagnostics }

  return {
    point: {
      id: point.id,
      runId: point.runId,
      scenarioId: point.scenarioId,
      stepIndex: point.stepIndex,
      kind: decisionKind,
      chosenAction,
      candidateActions,
      confidence: unitProbabilityOrUndefined(options.confidence),
      behaviorProb: finiteNumberOrUndefined(options.behaviorProb),
      targetProb: finiteNumberOrUndefined(options.targetProb),
      qHat: options.qHat === null ? null : unitProbabilityOrUndefined(options.qHat),
      costUsd: nonNegativeNumberOrUndefined(options.costUsd),
      evidence: (point.evidence ?? []).map((ref) => runtimeEvidenceToBeliefEvidence(ref, point)),
      outcome: options.outcome,
      metadata: mergeMetadata(point.metadata, options.metadata),
    },
    diagnostics,
  }
}

export function createBeliefRuntimeHookCollector(
  defaults: RuntimeBeliefShadowProbeInputOptions,
): BeliefRuntimeHookCollector {
  const decisions: RuntimeBeliefDecisionPoint[] = []

  return {
    hooks: {
      onDecisionPoint: (point) => {
        decisions.push(snapshotRuntimeDecisionPoint(point))
      },
    },
    decisions,
    toShadowProbeInputs: (options = {}) => {
      const inputs: BeliefShadowProbeInput[] = []
      const diagnostics: RuntimeBeliefConversionDiagnostic[] = []
      for (const point of decisions) {
        const report = runtimeDecisionPointToBeliefShadowProbeInput(point, {
          ...defaults,
          ...options,
        })
        if (report.input) inputs.push(report.input)
        diagnostics.push(...report.diagnostics)
      }
      return { inputs, diagnostics }
    },
    clear: () => {
      decisions.length = 0
    },
  }
}

function resolveDecisionKind(
  point: RuntimeBeliefDecisionPoint,
  override: BeliefDecisionKind | undefined,
  diagnostics: RuntimeBeliefConversionDiagnostic[],
): BeliefDecisionKind | undefined {
  const kind = override ?? point.kind
  if (isBeliefDecisionKind(kind)) return kind
  diagnostics.push({
    decisionId: point.id,
    severity: 'error',
    reason: `unsupported decisionKind "${kind}"`,
  })
  return undefined
}

function runtimeEvidenceToBeliefEvidence(
  ref: RuntimeBeliefDecisionEvidenceRef,
  point: RuntimeBeliefDecisionPoint,
): BeliefEvidenceRef {
  if (isBeliefEvidenceSource(ref.source)) {
    return {
      source: ref.source,
      id: ref.id,
      runId: point.runId,
      detail: ref.detail,
      quality: ref.quality,
      metadata: ref.metadata,
    }
  }

  return {
    source: 'event',
    id: ref.id,
    runId: point.runId,
    detail: ref.detail,
    quality: ref.quality,
    metadata: mergeMetadata({ runtimeSource: ref.source }, ref.metadata),
  }
}

function snapshotRuntimeDecisionPoint(
  point: RuntimeBeliefDecisionPoint,
): RuntimeBeliefDecisionPoint {
  return {
    id: point.id,
    runId: point.runId,
    scenarioId: point.scenarioId,
    stepIndex: point.stepIndex,
    kind: point.kind,
    candidateActions: [...(point.candidateActions ?? [])],
    context: point.context,
    evidence: (point.evidence ?? []).map((ref) => ({
      source: ref.source,
      id: ref.id,
      detail: ref.detail,
      quality: ref.quality,
      metadata: ref.metadata ? { ...ref.metadata } : undefined,
    })),
    metadata: point.metadata ? { ...point.metadata } : undefined,
  }
}

function mergeMetadata(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !extra) return undefined
  return { ...(base ?? {}), ...(extra ?? {}) }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function trimText(
  value: string | undefined,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
): string | undefined {
  if (!value) return undefined
  return value.length > maxChars ? value.slice(value.length - maxChars) : value
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function unitProbabilityOrUndefined(value: unknown): number | undefined {
  const number = finiteNumberOrUndefined(value)
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined
}

function nonNegativeNumberOrUndefined(value: unknown): number | undefined {
  const number = finiteNumberOrUndefined(value)
  return number !== undefined && number >= 0 ? number : undefined
}
