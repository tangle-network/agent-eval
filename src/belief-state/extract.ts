import type { TraceEvent } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import type {
  BeliefDecisionExtractionDiagnostic,
  BeliefDecisionExtractionReport,
  BeliefDecisionKind,
  BeliefDecisionOutcome,
  BeliefDecisionPoint,
  BeliefEvidenceRef,
} from './types'

export interface ExtractBeliefDecisionPointsOptions {
  runIds?: string[]
}

const DECISION_MARKERS = new Set(['belief_decision', 'belief.decision', 'decision_point'])
const DECISION_KINDS: ReadonlySet<string> = new Set([
  'continue',
  'verify',
  'ask',
  'retry',
  'stop',
  'memory-write',
  'memory-read',
  'tool-select',
  'skill-select',
  'workflow-select',
  'surface-promote',
])

export async function extractBeliefDecisionPoints(
  store: TraceStore,
  options: ExtractBeliefDecisionPointsOptions = {},
): Promise<BeliefDecisionExtractionReport> {
  const runs = options.runIds
    ? (await Promise.all(options.runIds.map((runId) => store.getRun(runId)))).filter(Boolean)
    : await store.listRuns()
  const decisions: BeliefDecisionPoint[] = []
  const diagnostics: BeliefDecisionExtractionDiagnostic[] = []

  for (const run of runs) {
    if (!run) continue
    const events = await store.events({ runId: run.runId })
    const spans = await store.spans({ runId: run.runId })
    const spanIds = new Set(spans.map((span) => span.spanId))
    let stepIndex = 0
    for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
      const parsed = parseDecisionEvent(event, {
        scenarioId: run.scenarioId,
        stepIndex,
        spanExists: event.spanId ? spanIds.has(event.spanId) : false,
      })
      if (!parsed) continue
      if ('diagnostic' in parsed) {
        diagnostics.push(parsed.diagnostic)
        continue
      }
      decisions.push(parsed.decision)
      stepIndex++
    }
  }

  return { decisions, diagnostics }
}

function parseDecisionEvent(
  event: TraceEvent,
  context: { scenarioId?: string; stepIndex: number; spanExists: boolean },
): { decision: BeliefDecisionPoint } | { diagnostic: BeliefDecisionExtractionDiagnostic } | null {
  const payload = event.payload
  const marker = stringField(payload, 'kind') ?? stringField(payload, 'type')
  if (!marker || !DECISION_MARKERS.has(marker)) return null

  const decisionKind = stringField(payload, 'decisionKind')
  if (!decisionKind || !DECISION_KINDS.has(decisionKind)) {
    return {
      diagnostic: {
        runId: event.runId,
        eventId: event.eventId,
        severity: 'warning',
        reason: `belief decision event has unsupported decisionKind "${decisionKind ?? ''}"`,
      },
    }
  }

  const chosenAction = stringField(payload, 'chosenAction')
  if (!chosenAction) {
    return {
      diagnostic: {
        runId: event.runId,
        eventId: event.eventId,
        severity: 'warning',
        reason: 'belief decision event is missing chosenAction',
      },
    }
  }

  const evidence: BeliefEvidenceRef[] = [
    {
      source: 'event',
      id: event.eventId,
      runId: event.runId,
      eventId: event.eventId,
    },
  ]
  if (event.spanId && context.spanExists) {
    evidence.push({ source: 'span', id: event.spanId, runId: event.runId, spanId: event.spanId })
  }

  return {
    decision: {
      id: stringField(payload, 'id') ?? event.eventId,
      runId: event.runId,
      scenarioId: stringField(payload, 'scenarioId') ?? context.scenarioId,
      stepIndex: numberField(payload, 'stepIndex') ?? context.stepIndex,
      kind: decisionKind as BeliefDecisionKind,
      chosenAction,
      candidateActions: stringArrayField(payload, 'candidateActions'),
      confidence: finiteUnitField(payload, 'confidence'),
      behaviorProb: numberField(payload, 'behaviorProb'),
      targetProb: numberField(payload, 'targetProb'),
      qHat: finiteUnitField(payload, 'qHat'),
      costUsd: nonNegativeNumberField(payload, 'costUsd'),
      evidence,
      outcome: parseOutcome(payload),
      metadata: recordField(payload, 'metadata'),
    },
  }
}

function parseOutcome(payload: Record<string, unknown>): BeliefDecisionOutcome | undefined {
  const value = recordField(payload, 'outcome')
  if (!value) return undefined
  return {
    success: typeof value.success === 'boolean' ? value.success : undefined,
    score: finiteUnitField(value, 'score'),
    reward: finiteUnitField(value, 'reward'),
    costUsd: nonNegativeNumberField(value, 'costUsd'),
    observedAt: stringField(value, 'observedAt'),
    metadata: recordField(value, 'metadata'),
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function finiteUnitField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = numberField(obj, key)
  return value === undefined ? undefined : Math.max(0, Math.min(1, value))
}

function nonNegativeNumberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = numberField(obj, key)
  return value === undefined ? undefined : Math.max(0, value)
}

function stringArrayField(obj: Record<string, unknown>, key: string): string[] | undefined {
  const value = obj[key]
  if (!Array.isArray(value)) return undefined
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  )
  return strings.length > 0 ? strings : undefined
}

function recordField(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
