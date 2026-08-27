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

export interface RuntimeBeliefHookEvent {
  id: string
  runId: string
  scenarioId?: string
  target: string
  phase: string
  timestamp: number
  stepIndex?: number
  parentId?: string
  payload?: unknown
  metadata?: Record<string, unknown>
}

export interface RuntimeBeliefHookContext {
  signal?: AbortSignal
}

export interface RuntimeBeliefHooks {
  onEvent?: (
    event: RuntimeBeliefHookEvent,
    context: RuntimeBeliefHookContext,
  ) => void | Promise<void>
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
  includeLifecycleEvidence?: boolean
  lifecycleEvents?: RuntimeBeliefHookEvent[]
  maxContextChars?: number
}

export interface RuntimeBeliefDecisionPointOptions {
  chosenAction?: string
  decisionKind?: BeliefDecisionKind
  confidence?: number
  behaviorProb?: number
  targetProb?: number
  qHatChosen?: number | null
  vHatTarget?: number | null
  /** @deprecated Use `qHatChosen` and `vHatTarget` together. */
  qHat?: number | null
  costUsd?: number
  outcome?: BeliefDecisionOutcome
  metadata?: Record<string, unknown>
  includeLifecycleEvidence?: boolean
  lifecycleEvents?: RuntimeBeliefHookEvent[]
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
  events: RuntimeBeliefHookEvent[]
  toShadowProbeInputs(options?: Partial<RuntimeBeliefShadowProbeInputOptions>): {
    inputs: BeliefShadowProbeInput[]
    diagnostics: RuntimeBeliefConversionDiagnostic[]
  }
  clear(): void
}

const DEFAULT_MAX_CONTEXT_CHARS = 12_000
const DEFAULT_PAYLOAD_PREVIEW_CHARS = 2_000

export function runtimeDecisionPointToBeliefShadowProbeInput(
  point: RuntimeBeliefDecisionPoint,
  options: RuntimeBeliefShadowProbeInputOptions,
): RuntimeBeliefShadowProbeInputReport {
  const diagnostics: RuntimeBeliefConversionDiagnostic[] = []
  const decisionKind = resolveDecisionKind(point, options.decisionKind, diagnostics)
  if (!decisionKind) return { diagnostics }
  const lifecycleEvidence = runtimeHookEventsToEvidenceRefs(point, options)
  const evidence = [...(point.evidence ?? []), ...lifecycleEvidence]

  return {
    input: {
      probeId: options.probeId,
      decisionId: point.id,
      runId: point.runId,
      scenarioId: point.scenarioId,
      stepIndex: point.stepIndex,
      decisionKind,
      candidateActions: uniqueStrings(point.candidateActions ?? []),
      evidence: evidence.map((ref) => ({
        id: ref.id,
        source: ref.source,
        ...(options.includeEvidenceDetail && ref.detail ? { detail: ref.detail } : {}),
        ...(ref.quality ? { quality: ref.quality } : {}),
      })),
      context: trimText(point.context, options.maxContextChars),
      metadata: mergeMetadata(point.metadata, lifecycleMetadata(lifecycleEvidence)),
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
  const lifecycleEvidence = runtimeHookEventsToEvidenceRefs(point, options)
  const evidence = [...(point.evidence ?? []), ...lifecycleEvidence]

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
      qHatChosen:
        options.qHatChosen === null ? null : unitProbabilityOrUndefined(options.qHatChosen),
      vHatTarget:
        options.vHatTarget === null ? null : unitProbabilityOrUndefined(options.vHatTarget),
      qHat: options.qHat === null ? null : unitProbabilityOrUndefined(options.qHat),
      costUsd: nonNegativeNumberOrUndefined(options.costUsd),
      evidence: evidence.map((ref) => runtimeEvidenceToBeliefEvidence(ref, point)),
      outcome: options.outcome,
      metadata: mergeMetadata(
        mergeMetadata(point.metadata, lifecycleMetadata(lifecycleEvidence)),
        options.metadata,
      ),
    },
    diagnostics,
  }
}

export function createBeliefRuntimeHookCollector(
  defaults: RuntimeBeliefShadowProbeInputOptions,
): BeliefRuntimeHookCollector {
  const decisions: RuntimeBeliefDecisionPoint[] = []
  const events: RuntimeBeliefHookEvent[] = []

  return {
    hooks: {
      onEvent: (event) => {
        events.push(snapshotRuntimeHookEvent(event))
      },
      onDecisionPoint: (point) => {
        decisions.push(snapshotRuntimeDecisionPoint(point))
      },
    },
    decisions,
    events,
    toShadowProbeInputs: (options = {}) => {
      const inputs: BeliefShadowProbeInput[] = []
      const diagnostics: RuntimeBeliefConversionDiagnostic[] = []
      const includeLifecycleEvidence =
        options.includeLifecycleEvidence ?? defaults.includeLifecycleEvidence
      for (const point of decisions) {
        const report = runtimeDecisionPointToBeliefShadowProbeInput(point, {
          ...defaults,
          ...options,
          includeLifecycleEvidence,
          lifecycleEvents:
            includeLifecycleEvidence === false
              ? undefined
              : (options.lifecycleEvents ?? defaults.lifecycleEvents ?? events),
        })
        if (report.input) inputs.push(report.input)
        diagnostics.push(...report.diagnostics)
      }
      return { inputs, diagnostics }
    },
    clear: () => {
      decisions.length = 0
      events.length = 0
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

function runtimeHookEventsToEvidenceRefs(
  point: RuntimeBeliefDecisionPoint,
  options: {
    includeLifecycleEvidence?: boolean
    lifecycleEvents?: RuntimeBeliefHookEvent[]
  },
): RuntimeBeliefDecisionEvidenceRef[] {
  if (options.includeLifecycleEvidence === false) return []
  return (options.lifecycleEvents ?? [])
    .filter((event) => runtimeHookEventMatchesDecision(point, event))
    .map(runtimeHookEventToEvidenceRef)
}

function runtimeHookEventMatchesDecision(
  point: RuntimeBeliefDecisionPoint,
  event: RuntimeBeliefHookEvent,
): boolean {
  if (event.runId !== point.runId) return false
  if (event.scenarioId && point.scenarioId && event.scenarioId !== point.scenarioId) return false
  return event.stepIndex === undefined || event.stepIndex === point.stepIndex
}

function runtimeHookEventToEvidenceRef(
  event: RuntimeBeliefHookEvent,
): RuntimeBeliefDecisionEvidenceRef {
  return {
    source: 'runtime_event',
    id: event.id,
    detail: `${event.target}:${event.phase}`,
    quality: 'direct',
    metadata: mergeMetadata(
      compactMetadata({
        target: event.target,
        phase: event.phase,
        timestamp: event.timestamp,
        stepIndex: event.stepIndex,
        parentId: event.parentId,
        payloadPreview: previewUnknown(event.payload),
      }),
      event.metadata,
    ),
  }
}

function lifecycleMetadata(
  refs: RuntimeBeliefDecisionEvidenceRef[],
): Record<string, unknown> | undefined {
  if (refs.length === 0) return undefined
  return {
    lifecycleEventCount: refs.length,
    lifecycleEventIds: refs.map((ref) => ref.id),
  }
}

function snapshotRuntimeHookEvent(event: RuntimeBeliefHookEvent): RuntimeBeliefHookEvent {
  return {
    id: event.id,
    runId: event.runId,
    scenarioId: event.scenarioId,
    target: event.target,
    phase: event.phase,
    timestamp: event.timestamp,
    stepIndex: event.stepIndex,
    parentId: event.parentId,
    payload: snapshotUnknown(event.payload),
    metadata: event.metadata ? { ...event.metadata } : undefined,
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

function compactMetadata(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function previewUnknown(
  value: unknown,
  maxChars = DEFAULT_PAYLOAD_PREVIEW_CHARS,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return trimText(value, maxChars)
  try {
    return trimText(JSON.stringify(value), maxChars)
  } catch {
    return trimText(String(value), maxChars)
  }
}

function snapshotUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return [...value]
  if (isRecord(value)) return { ...value }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
