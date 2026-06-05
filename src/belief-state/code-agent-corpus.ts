import type { CodeAgentSessionSource } from '../contract/intake/code-agent-session'
import type { RunRecord } from '../run-record'
import { embeddedBeliefOpeTargetPolicy } from './ope'
import { type AnalyzeBeliefPolicyOptions, analyzeBeliefPolicy } from './report'
import { thresholdSelectivePolicy } from './selective'
import type {
  BeliefDecisionExtractionDiagnostic,
  BeliefDecisionExtractionReport,
  BeliefDecisionKind,
  BeliefDecisionOutcome,
  BeliefDecisionPoint,
  BeliefEvidenceRef,
  BeliefPolicyEvaluationReport,
  BeliefSelectivePolicy,
} from './types'

export type CodeAgentBeliefDecisionTargetId =
  | 'failure-recovery'
  | 'tool-selection'
  | 'graph-completion'

export interface ExtractCodeAgentBeliefDecisionPointsOptions {
  source: CodeAgentSessionSource
  entries: unknown[]
  run: Pick<RunRecord, 'runId' | 'scenarioId' | 'outcome' | 'costUsd'>
  sourcePath?: string
}

export interface BeliefDecisionInventoryBucket {
  id: string
  kind?: BeliefDecisionKind
  targetId?: CodeAgentBeliefDecisionTargetId
  n: number
  withOutcome: number
  withConfidence: number
  withCandidateActions: number
  withBehaviorProb: number
  withTargetProb: number
  successRate: number | null
  meanScore: number | null
  meanConfidence: number | null
}

export interface BeliefDecisionInventoryReport {
  n: number
  byKind: BeliefDecisionInventoryBucket[]
  byTarget: BeliefDecisionInventoryBucket[]
  diagnostics: string[]
}

export interface BeliefDecisionTargetSelection {
  id: CodeAgentBeliefDecisionTargetId
  label: string
  points: BeliefDecisionPoint[]
  support: BeliefDecisionInventoryBucket
  reasons: string[]
}

export interface SelectBeliefDecisionTargetOptions {
  minN?: number
  minOutcomeCoverage?: number
  preferredTargets?: CodeAgentBeliefDecisionTargetId[]
}

export interface AnalyzeBeliefDecisionCorpusOptions {
  points: BeliefDecisionPoint[]
  targetId?: CodeAgentBeliefDecisionTargetId
  minN?: number
  minAccepted?: number
  confidenceThreshold?: number
  policy?: BeliefSelectivePolicy
  requireOpe?: boolean
  policyOptions?: Partial<AnalyzeBeliefPolicyOptions>
}

export interface BeliefDecisionCorpusEvaluation {
  inventory: BeliefDecisionInventoryReport
  target?: BeliefDecisionTargetSelection
  policy?: BeliefSelectivePolicy
  evaluation?: BeliefPolicyEvaluationReport
  diagnostics: string[]
}

type ObservedActionKind = 'tool' | 'patch' | 'terminal' | 'graph-completion'

interface ObservedAction {
  id: string
  localId: string
  stepIndex: number
  kind: ObservedActionKind
  action: string
  timestamp?: number
  success?: boolean
  costUsd?: number
  evidence: BeliefEvidenceRef[]
  metadata: Record<string, unknown>
}

const FAILURE_RECOVERY_ACTIONS = ['retry', 'verify', 'continue', 'stop'] as const

const TARGET_LABELS: Record<CodeAgentBeliefDecisionTargetId, string> = {
  'failure-recovery': 'Failure recovery after tool or patch failure',
  'tool-selection': 'Tool/action selection',
  'graph-completion': 'Graph completion decision',
}

export function extractCodeAgentBeliefDecisionPoints(
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): BeliefDecisionExtractionReport {
  const entries = options.entries.filter(isRecord)
  const diagnostics: BeliefDecisionExtractionDiagnostic[] = []
  const observed = observedActionsFor(options.source, entries, options)
  const decisions: BeliefDecisionPoint[] = []

  for (const action of observed) {
    if (action.kind === 'tool' || action.kind === 'patch') {
      decisions.push(toolSelectionDecision(action, options))
    }
    if (action.kind === 'graph-completion') {
      decisions.push(graphCompletionDecision(action, options))
    }
  }

  for (const failed of observed) {
    if ((failed.kind !== 'tool' && failed.kind !== 'patch') || failed.success !== false) continue
    const next = observed.find(
      (candidate) =>
        candidate.stepIndex > failed.stepIndex &&
        (candidate.kind === 'tool' || candidate.kind === 'patch' || candidate.kind === 'terminal'),
    )
    if (!next) {
      diagnostics.push({
        runId: options.run.runId,
        severity: 'warning',
        reason: `${failed.id}: failed action has no observable follow-up decision`,
      })
      continue
    }
    decisions.push(failureRecoveryDecision(failed, next, options))
  }

  if (decisions.length === 0) {
    diagnostics.push({
      runId: options.run.runId,
      severity: 'info',
      reason: `no belief decision points extracted from ${options.source} entries`,
    })
  }

  return { decisions, diagnostics }
}

export function inventoryBeliefDecisionPoints(
  points: BeliefDecisionPoint[],
): BeliefDecisionInventoryReport {
  const byKind = [...groupBy(points, (point) => point.kind).entries()]
    .map(([kind, bucketPoints]) =>
      bucketFor(kind, bucketPoints, { kind: kind as BeliefDecisionKind }),
    )
    .sort(sortBuckets)
  const byTarget = [...groupBy(points, targetIdOf).entries()]
    .filter((entry): entry is [CodeAgentBeliefDecisionTargetId, BeliefDecisionPoint[]] => {
      return entry[0] !== undefined
    })
    .map(([targetId, bucketPoints]) => bucketFor(targetId, bucketPoints, { targetId }))
    .sort(sortBuckets)

  const diagnostics: string[] = []
  if (points.length === 0) diagnostics.push('no decision points available')
  for (const bucket of byTarget) {
    if (bucket.withOutcome < bucket.n) {
      diagnostics.push(`${bucket.id}: ${bucket.n - bucket.withOutcome} decision(s) missing outcome`)
    }
    if (bucket.withBehaviorProb < bucket.n || bucket.withTargetProb < bucket.n) {
      diagnostics.push(`${bucket.id}: OPE support incomplete`)
    }
  }

  return { n: points.length, byKind, byTarget, diagnostics }
}

export function selectBeliefDecisionTarget(
  points: BeliefDecisionPoint[],
  options: SelectBeliefDecisionTargetOptions = {},
): BeliefDecisionTargetSelection | null {
  const minN = options.minN ?? 10
  const minOutcomeCoverage = options.minOutcomeCoverage ?? 0.8
  const preferredTargets = options.preferredTargets ?? [
    'failure-recovery',
    'tool-selection',
    'graph-completion',
  ]
  const inventory = inventoryBeliefDecisionPoints(points)

  for (const targetId of preferredTargets) {
    const support = inventory.byTarget.find((bucket) => bucket.targetId === targetId)
    if (!support) continue
    const reasons: string[] = []
    if (support.n < minN) reasons.push(`need at least ${minN} decisions, got ${support.n}`)
    const outcomeCoverage = support.n > 0 ? support.withOutcome / support.n : 0
    if (outcomeCoverage < minOutcomeCoverage) {
      reasons.push(
        `outcome coverage ${outcomeCoverage.toFixed(2)} below ${minOutcomeCoverage.toFixed(2)}`,
      )
    }
    if (reasons.length > 0) continue
    const targetPoints = points.filter((point) => targetIdOf(point) === targetId)
    return {
      id: targetId,
      label: TARGET_LABELS[targetId],
      points: targetPoints,
      support,
      reasons,
    }
  }

  return null
}

export function analyzeBeliefDecisionCorpus(
  options: AnalyzeBeliefDecisionCorpusOptions,
): BeliefDecisionCorpusEvaluation {
  const inventory = inventoryBeliefDecisionPoints(options.points)
  const diagnostics = [...inventory.diagnostics]
  const target =
    options.targetId !== undefined
      ? targetSelectionFor(options.points, options.targetId, options)
      : selectBeliefDecisionTarget(options.points, options)

  if (!target) {
    diagnostics.push('no decision target has enough support for policy evaluation')
    return { inventory, diagnostics }
  }

  const policy =
    options.policy ??
    thresholdSelectivePolicy({
      id: `${target.id}:confidence>=${options.confidenceThreshold ?? 0.5}`,
      confidenceThreshold: options.confidenceThreshold ?? 0.5,
      belowThresholdAction: 'verify',
    })
  const minN = options.minN ?? 10
  const evaluation = analyzeBeliefPolicy({
    points: target.points,
    policy,
    selective: {
      minN,
      minAccepted: options.minAccepted ?? Math.min(5, minN),
      minUtilityDelta: 0,
      ...(options.policyOptions?.selective ?? {}),
    },
    calibration: {
      minPairs: Math.min(10, minN),
      policy,
      region: 'all',
      ...(options.policyOptions?.calibration ?? {}),
    },
    ope: {
      targetPolicy: embeddedBeliefOpeTargetPolicy(`${target.id}:embedded-target-prob`),
      minEffectiveSampleSize: minN,
      ...(options.policyOptions?.ope ?? {}),
    },
    requireOpe: options.requireOpe ?? true,
  })

  return { inventory, target, policy, evaluation, diagnostics }
}

function observedActionsFor(
  source: CodeAgentSessionSource,
  entries: Record<string, unknown>[],
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): ObservedAction[] {
  switch (source) {
    case 'codex':
      return codexObservedActions(entries, options)
    case 'claude-code':
      return claudeObservedActions(entries, options)
    case 'opencode':
      return openCodeObservedActions(entries, options)
    case 'kimi-code':
      return kimiObservedActions(entries, options)
    case 'pi':
      return piObservedActions(entries, options)
  }
}

function codexObservedActions(
  entries: Record<string, unknown>[],
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): ObservedAction[] {
  const actions: ObservedAction[] = []
  const calls = new Map<string, ObservedAction>()
  for (const entry of entries) {
    const payload = record(entry.payload) ?? {}
    const entryType = stringField(entry, 'type')
    const payloadType = stringField(payload, 'type')
    const timestamp = timestampMs(entry.timestamp)
    if (entryType === 'response_item') {
      if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
        const callId =
          stringField(payload, 'call_id') ?? stringField(payload, 'id') ?? `${actions.length}`
        const action = observedAction({
          options,
          localId: callId,
          stepIndex: actions.length,
          kind: 'tool',
          action: stringField(payload, 'name') ?? payloadType,
          timestamp,
          metadata: { sourceEventType: entryType, payloadType },
        })
        calls.set(callId, action)
        actions.push(action)
      }
      if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
        const callId = stringField(payload, 'call_id') ?? stringField(payload, 'id')
        const action = callId ? calls.get(callId) : undefined
        if (action) action.success = !looksLikeError(payload.output)
      }
    }
    if (entryType === 'event_msg') {
      if (payloadType === 'patch_apply_end') {
        actions.push(
          observedAction({
            options,
            localId: stringField(payload, 'call_id') ?? `patch-${actions.length}`,
            stepIndex: actions.length,
            kind: 'patch',
            action: 'patch',
            timestamp,
            success: typeof payload.success === 'boolean' ? payload.success : undefined,
            metadata: { sourceEventType: entryType, payloadType },
          }),
        )
      }
      if (payloadType === 'task_complete' || payloadType === 'turn_aborted') {
        actions.push(
          observedAction({
            options,
            localId: `${payloadType}-${actions.length}`,
            stepIndex: actions.length,
            kind: 'terminal',
            action: payloadType === 'task_complete' ? 'stop' : 'abort',
            timestamp,
            success: payloadType === 'task_complete',
            metadata: { sourceEventType: entryType, payloadType },
          }),
        )
      }
    }
  }
  return actions
}

function claudeObservedActions(
  entries: Record<string, unknown>[],
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): ObservedAction[] {
  const actions: ObservedAction[] = []
  const calls = new Map<string, ObservedAction>()
  for (const entry of entries) {
    const timestamp = timestampMs(entry.timestamp)
    const message = record(entry.message)
    const content = Array.isArray(message?.content) ? message.content : []
    for (const item of content) {
      const part = record(item)
      if (!part) continue
      const partType = stringField(part, 'type')
      if (partType === 'tool_use') {
        const id = stringField(part, 'id') ?? `tool-${actions.length}`
        const action = observedAction({
          options,
          localId: id,
          stepIndex: actions.length,
          kind: 'tool',
          action: stringField(part, 'name') ?? 'tool',
          timestamp,
          metadata: { sourceEventType: stringField(entry, 'type'), partType },
        })
        calls.set(id, action)
        actions.push(action)
      }
      if (partType === 'tool_result') {
        const id = stringField(part, 'tool_use_id')
        const action = id ? calls.get(id) : undefined
        if (action) action.success = part.is_error !== true
      }
    }
    if (stringField(entry, 'type') === 'pr-link') {
      actions.push(
        observedAction({
          options,
          localId: `pr-link-${actions.length}`,
          stepIndex: actions.length,
          kind: 'terminal',
          action: 'stop',
          timestamp,
          success: true,
          metadata: { sourceEventType: 'pr-link' },
        }),
      )
    }
  }
  return actions
}

function openCodeObservedActions(
  entries: Record<string, unknown>[],
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): ObservedAction[] {
  const actions: ObservedAction[] = []
  for (const entry of entries) {
    const type = stringField(entry, 'type')
    const role = stringField(entry, 'role')
    const time = record(entry.time)
    const timestamp = timestampMs(time?.created)
    if (type === 'tool') {
      const state = record(entry.state)
      const status = stringField(state ?? {}, 'status')
      actions.push(
        observedAction({
          options,
          localId: stringField(entry, 'id') ?? `tool-${actions.length}`,
          stepIndex: actions.length,
          kind: 'tool',
          action: stringField(entry, 'tool') ?? 'tool',
          timestamp,
          success: status === 'completed' ? true : status === 'error' ? false : undefined,
          metadata: { sourceEventType: type, status },
        }),
      )
    }
    if (type === 'patch') {
      actions.push(
        observedAction({
          options,
          localId: stringField(entry, 'id') ?? `patch-${actions.length}`,
          stepIndex: actions.length,
          kind: 'patch',
          action: 'patch',
          timestamp,
          success: true,
          metadata: { sourceEventType: type },
        }),
      )
    }
    if (role === 'assistant') {
      const finish = stringField(entry, 'finish')
      if (finish === 'stop' || finish === 'error') {
        actions.push(
          observedAction({
            options,
            localId: stringField(entry, 'id') ?? `terminal-${actions.length}`,
            stepIndex: actions.length,
            kind: 'terminal',
            action: finish === 'stop' ? 'stop' : 'abort',
            timestamp: timestampMs(time?.completed) ?? timestamp,
            success: finish === 'stop',
            costUsd: numberField(entry, 'cost'),
            metadata: { sourceEventType: 'assistant', finish },
          }),
        )
      }
    }
  }
  return actions
}

function kimiObservedActions(
  entries: Record<string, unknown>[],
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): ObservedAction[] {
  const actions: ObservedAction[] = []
  const calls = new Map<string, ObservedAction>()
  for (const entry of entries) {
    const timestamp = timestampMs(entry.timestamp)
    const message = record(entry.message)
    const messageType = stringField(message ?? {}, 'type')
    const payload = record(message?.payload) ?? {}
    if (messageType === 'ToolCall') {
      const call = record(payload.function)
      const id = stringField(payload, 'id') ?? `tool-${actions.length}`
      const action = observedAction({
        options,
        localId: id,
        stepIndex: actions.length,
        kind: 'tool',
        action: stringField(call ?? {}, 'name') ?? 'tool',
        timestamp,
        metadata: { sourceEventType: messageType },
      })
      calls.set(id, action)
      actions.push(action)
    }
    if (messageType === 'ToolResult') {
      const id = stringField(payload, 'tool_call_id')
      const action = id ? calls.get(id) : undefined
      if (action) action.success = record(payload.return_value)?.is_error !== true
    }
    if (messageType === 'TurnEnd' || messageType === 'StepInterrupted') {
      actions.push(
        observedAction({
          options,
          localId: `${messageType}-${actions.length}`,
          stepIndex: actions.length,
          kind: 'terminal',
          action: messageType === 'TurnEnd' ? 'stop' : 'abort',
          timestamp,
          success: messageType === 'TurnEnd',
          metadata: { sourceEventType: messageType },
        }),
      )
    }
  }
  return actions
}

function piObservedActions(
  entries: Record<string, unknown>[],
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): ObservedAction[] {
  const actions: ObservedAction[] = []
  for (const entry of entries) {
    const nodes = Array.isArray(entry.nodes) ? entry.nodes : []
    for (const node of nodes) {
      const obj = record(node)
      const ir = record(obj?.ir) ?? obj
      const kind = stringField(ir ?? {}, 'kind')
      if (kind === 'ToolInvocation') {
        actions.push(
          observedAction({
            options,
            localId:
              stringField(ir ?? {}, 'id') ??
              stringField(obj ?? {}, 'id') ??
              `tool-${actions.length}`,
            stepIndex: actions.length,
            kind: 'tool',
            action: 'graph-tool',
            timestamp: timestampMs(ir?.createdAt),
            success: undefined,
            metadata: { sourceEventType: 'graph-node', graphKind: kind },
          }),
        )
      }
      if (kind === 'ToolResult') {
        const prior = [...actions].reverse().find((action) => action.kind === 'tool')
        if (prior) prior.success = true
      }
      if (kind === 'CompletionDecision') {
        actions.push(
          observedAction({
            options,
            localId:
              stringField(ir ?? {}, 'id') ??
              stringField(obj ?? {}, 'id') ??
              `completion-${actions.length}`,
            stepIndex: actions.length,
            kind: 'graph-completion',
            action: 'complete',
            timestamp: timestampMs(ir?.createdAt),
            success: true,
            metadata: { sourceEventType: 'graph-node', graphKind: kind },
          }),
        )
      }
    }
  }
  return actions
}

function toolSelectionDecision(
  action: ObservedAction,
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): BeliefDecisionPoint {
  return {
    id: `${options.run.runId}:tool-selection:${action.localId}`,
    runId: options.run.runId,
    scenarioId: options.run.scenarioId,
    stepIndex: action.stepIndex,
    kind: 'tool-select',
    chosenAction: action.action,
    candidateActions: [action.action],
    confidence: 0.65,
    costUsd: action.costUsd,
    evidence: action.evidence,
    outcome: outcomeFromAction(action, options.run),
    metadata: {
      target: 'tool-selection',
      source: options.source,
      actionKind: action.kind,
      confidenceSource: 'fixed-observed-action-prior',
      ...action.metadata,
    },
  }
}

function graphCompletionDecision(
  action: ObservedAction,
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): BeliefDecisionPoint {
  return {
    id: `${options.run.runId}:graph-completion:${action.localId}`,
    runId: options.run.runId,
    scenarioId: options.run.scenarioId,
    stepIndex: action.stepIndex,
    kind: 'stop',
    chosenAction: 'complete',
    candidateActions: ['complete', 'continue', 'verify'],
    confidence: 0.75,
    evidence: action.evidence,
    outcome: outcomeFromAction(action, options.run),
    metadata: {
      target: 'graph-completion',
      source: options.source,
      confidenceSource: 'fixed-graph-completion-prior',
      ...action.metadata,
    },
  }
}

function failureRecoveryDecision(
  failed: ObservedAction,
  next: ObservedAction,
  options: ExtractCodeAgentBeliefDecisionPointsOptions,
): BeliefDecisionPoint {
  const chosenAction = classifyFailureRecovery(failed, next)
  return {
    id: `${options.run.runId}:failure-recovery:${failed.localId}`,
    runId: options.run.runId,
    scenarioId: options.run.scenarioId,
    stepIndex: failed.stepIndex,
    kind: 'retry',
    chosenAction,
    candidateActions: [...FAILURE_RECOVERY_ACTIONS],
    confidence: recoveryConfidence(chosenAction),
    evidence: [...failed.evidence, ...next.evidence],
    outcome: outcomeFromAction(next, options.run),
    metadata: {
      target: 'failure-recovery',
      source: options.source,
      failedActionKind: failed.kind,
      failedAction: failed.action,
      nextActionKind: next.kind,
      nextAction: next.action,
      confidenceSource: 'heuristic-observed-follow-up',
    },
  }
}

function classifyFailureRecovery(
  failed: ObservedAction,
  next: ObservedAction,
): (typeof FAILURE_RECOVERY_ACTIONS)[number] {
  if (next.kind === 'terminal') return 'stop'
  if (isVerificationAction(next.action)) return 'verify'
  if (next.kind === failed.kind && next.action === failed.action) return 'retry'
  return 'continue'
}

function recoveryConfidence(action: string): number {
  if (action === 'verify') return 0.8
  if (action === 'retry') return 0.6
  if (action === 'stop') return 0.55
  return 0.35
}

function isVerificationAction(action: string): boolean {
  const normalized = action.toLowerCase()
  return (
    normalized.includes('verify') ||
    normalized.includes('test') ||
    normalized.includes('check') ||
    normalized.includes('lint') ||
    normalized.includes('build') ||
    normalized.includes('typecheck') ||
    normalized.includes('pytest') ||
    normalized.includes('vitest') ||
    normalized.includes('tsc')
  )
}

function outcomeFromAction(
  action: ObservedAction,
  run: Pick<RunRecord, 'outcome' | 'costUsd'>,
): BeliefDecisionOutcome | undefined {
  const runScore = scoreFromRun(run)
  const success = action.success ?? (runScore !== null ? runScore >= 0.5 : undefined)
  const score = action.success === undefined ? (runScore ?? undefined) : action.success ? 1 : 0
  if (success === undefined && score === undefined) return undefined
  return {
    ...(success !== undefined ? { success } : {}),
    ...(score !== undefined ? { score, reward: score } : {}),
    ...(action.costUsd !== undefined ? { costUsd: action.costUsd } : {}),
    metadata: {
      outcomeSource: action.success === undefined ? 'run-score' : 'observed-action-status',
    },
  }
}

function observedAction(input: {
  options: ExtractCodeAgentBeliefDecisionPointsOptions
  localId: string
  stepIndex: number
  kind: ObservedActionKind
  action: string
  timestamp?: number
  success?: boolean
  costUsd?: number
  metadata?: Record<string, unknown>
}): ObservedAction {
  const id = `${input.options.run.runId}:${input.options.source}:${input.localId}`
  return {
    id,
    localId: input.localId,
    stepIndex: input.stepIndex,
    kind: input.kind,
    action: input.action,
    timestamp: input.timestamp,
    success: input.success,
    costUsd: input.costUsd,
    evidence: [
      {
        source: 'event',
        id,
        runId: input.options.run.runId,
        detail: input.action,
        metadata: {
          source: input.options.source,
          sourcePath: input.options.sourcePath,
          ...input.metadata,
        },
      },
    ],
    metadata: input.metadata ?? {},
  }
}

function targetSelectionFor(
  points: BeliefDecisionPoint[],
  targetId: CodeAgentBeliefDecisionTargetId,
  options: SelectBeliefDecisionTargetOptions,
): BeliefDecisionTargetSelection | null {
  const targetPoints = points.filter((point) => targetIdOf(point) === targetId)
  if (targetPoints.length === 0) return null
  const support = bucketFor(targetId, targetPoints, { targetId })
  const minN = options.minN ?? 10
  const minOutcomeCoverage = options.minOutcomeCoverage ?? 0.8
  const reasons: string[] = []
  if (support.n < minN) reasons.push(`need at least ${minN} decisions, got ${support.n}`)
  const outcomeCoverage = support.n > 0 ? support.withOutcome / support.n : 0
  if (outcomeCoverage < minOutcomeCoverage) {
    reasons.push(
      `outcome coverage ${outcomeCoverage.toFixed(2)} below ${minOutcomeCoverage.toFixed(2)}`,
    )
  }
  if (reasons.length > 0) return null
  return { id: targetId, label: TARGET_LABELS[targetId], points: targetPoints, support, reasons }
}

function bucketFor(
  id: string,
  points: BeliefDecisionPoint[],
  identity: { kind?: BeliefDecisionKind; targetId?: CodeAgentBeliefDecisionTargetId },
): BeliefDecisionInventoryBucket {
  const outcomes = points.filter((point) => point.outcome)
  const scores = outcomes
    .map((point) => outcomeScore(point.outcome))
    .filter((score): score is number => score !== null)
  const confidences = points
    .map((point) => point.confidence)
    .filter((confidence): confidence is number => typeof confidence === 'number')
  const successes = outcomes.filter((point) => point.outcome?.success === true).length
  const successDenominator = outcomes.filter(
    (point) => typeof point.outcome?.success === 'boolean',
  ).length
  return {
    id,
    ...identity,
    n: points.length,
    withOutcome: outcomes.length,
    withConfidence: confidences.length,
    withCandidateActions: points.filter((point) => (point.candidateActions?.length ?? 0) > 0)
      .length,
    withBehaviorProb: points.filter((point) => point.behaviorProb !== undefined).length,
    withTargetProb: points.filter((point) => point.targetProb !== undefined).length,
    successRate: successDenominator > 0 ? successes / successDenominator : null,
    meanScore: scores.length > 0 ? mean(scores) : null,
    meanConfidence: confidences.length > 0 ? mean(confidences) : null,
  }
}

function targetIdOf(point: BeliefDecisionPoint): CodeAgentBeliefDecisionTargetId | undefined {
  const target = point.metadata?.target
  if (target === 'failure-recovery' || target === 'tool-selection' || target === 'graph-completion')
    return target
  return undefined
}

function outcomeScore(outcome: BeliefDecisionOutcome | undefined): number | null {
  if (!outcome) return null
  if (typeof outcome.score === 'number') return outcome.score
  if (typeof outcome.reward === 'number') return outcome.reward
  if (outcome.success === true) return 1
  if (outcome.success === false) return 0
  return null
}

function scoreFromRun(run: Pick<RunRecord, 'outcome'>): number | null {
  if (typeof run.outcome.holdoutScore === 'number') return run.outcome.holdoutScore
  if (typeof run.outcome.searchScore === 'number') return run.outcome.searchScore
  return null
}

function sortBuckets(a: BeliefDecisionInventoryBucket, b: BeliefDecisionInventoryBucket): number {
  return b.n - a.n || a.id.localeCompare(b.id)
}

function groupBy<T, K>(values: T[], keyOf: (value: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const value of values) {
    const key = keyOf(value)
    const bucket = map.get(key)
    if (bucket) bucket.push(value)
    else map.set(key, [value])
  }
  return map
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function looksLikeError(value: unknown): boolean {
  if (isRecord(value)) {
    if (value.is_error === true || value.error === true) return true
    if ('Err' in value) return true
  }
  if (typeof value !== 'string') return false
  return /\b(error|failed|exception|traceback)\b/i.test(value)
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
