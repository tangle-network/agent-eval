import type { RunSplitTag } from '../run-record'
import {
  type BeliefDecisionResearchEvidencePacket,
  type BuildBeliefDecisionResearchEvidencePacketOptions,
  buildBeliefDecisionResearchEvidencePacket,
} from './research-evidence'
import {
  type RuntimeBeliefDecisionPoint,
  type RuntimeBeliefHookEvent,
  runtimeDecisionPointToBeliefDecisionPoint,
} from './runtime-hooks'
import type { BeliefDecisionOutcome, BeliefDecisionPoint } from './types'

export interface RuntimeBeliefPhase0RunRecord {
  runId: string
  scenarioId?: string
  splitTag: RunSplitTag
}

export interface RuntimeBeliefDecisionLabel {
  decisionId: string
  chosenAction: string
  outcome: BeliefDecisionOutcome
  confidence?: number
  behaviorProb?: number
  targetProb?: number
  qHat?: number | null
  costUsd?: number
  splitTag?: RunSplitTag
  metadata?: Record<string, unknown>
}

export interface BuildRuntimeBeliefPhase0MeasurementOptions
  extends Omit<BuildBeliefDecisionResearchEvidencePacketOptions, 'points'> {
  runs: RuntimeBeliefPhase0RunRecord[]
  decisions: RuntimeBeliefDecisionPoint[]
  events?: RuntimeBeliefHookEvent[]
  labels: RuntimeBeliefDecisionLabel[]
  baselinePolicyId?: string
}

export interface RuntimeBeliefPhase0MeasurementSummary {
  runCount: number
  producerDecisionCount: number
  lifecycleEventCount: number
  labelCount: number
  completedPointCount: number
  runJoinRate: number
  labelJoinRate: number
  missingRunRecordCount: number
  missingLabelCount: number
  withEvidence: number
  withOutcome: number
  withSplit: number
  withBehaviorProb: number
  withTargetProb: number
  baselinePolicyId: string
  packetStatus: BeliefDecisionResearchEvidencePacket['status']
  claimScope: BeliefDecisionResearchEvidencePacket['claimScope']
}

export interface RuntimeBeliefPhase0Measurement {
  points: BeliefDecisionPoint[]
  packet: BeliefDecisionResearchEvidencePacket
  summary: RuntimeBeliefPhase0MeasurementSummary
  diagnostics: string[]
}

const DEFAULT_BASELINE_POLICY_ID = 'always-accept-observed-action'

export function buildRuntimeBeliefPhase0Measurement(
  options: BuildRuntimeBeliefPhase0MeasurementOptions,
): RuntimeBeliefPhase0Measurement {
  const runsById = new Map(options.runs.map((run) => [run.runId, run]))
  const labelsByDecisionId = new Map<string, RuntimeBeliefDecisionLabel>()
  const diagnostics: string[] = []

  for (const label of options.labels) {
    if (labelsByDecisionId.has(label.decisionId)) {
      diagnostics.push(`${label.decisionId}: duplicate label; using the last label`)
    }
    labelsByDecisionId.set(label.decisionId, label)
  }

  const points: BeliefDecisionPoint[] = []
  let missingRunRecordCount = 0
  let missingLabelCount = 0

  for (const decision of options.decisions) {
    const run = runsById.get(decision.runId)
    if (!run) {
      missingRunRecordCount += 1
      diagnostics.push(`${decision.id}: missing RunRecord join for runId ${decision.runId}`)
      continue
    }

    const label = labelsByDecisionId.get(decision.id)
    if (!label) {
      missingLabelCount += 1
      diagnostics.push(`${decision.id}: missing observed action/outcome label`)
      continue
    }

    const splitTag = label.splitTag ?? run.splitTag
    const report = runtimeDecisionPointToBeliefDecisionPoint(
      { ...decision, scenarioId: decision.scenarioId ?? run.scenarioId },
      {
        chosenAction: label.chosenAction,
        confidence: label.confidence,
        behaviorProb: label.behaviorProb,
        targetProb: label.targetProb,
        qHat: label.qHat,
        costUsd: label.costUsd,
        outcome: label.outcome,
        lifecycleEvents: options.events,
        metadata: compactMetadata({
          baselinePolicyId: options.baselinePolicyId ?? DEFAULT_BASELINE_POLICY_ID,
          splitTag,
          ...label.metadata,
        }),
      },
    )
    diagnostics.push(...report.diagnostics.map((item) => `${item.decisionId}: ${item.reason}`))
    if (report.point) points.push(report.point)
  }

  const packet = buildBeliefDecisionResearchEvidencePacket({
    ...options,
    points,
  })

  return {
    points,
    packet,
    summary: summarizePhase0Measurement(options, points, packet, {
      missingRunRecordCount,
      missingLabelCount,
    }),
    diagnostics,
  }
}

function summarizePhase0Measurement(
  options: BuildRuntimeBeliefPhase0MeasurementOptions,
  points: BeliefDecisionPoint[],
  packet: BeliefDecisionResearchEvidencePacket,
  counts: { missingRunRecordCount: number; missingLabelCount: number },
): RuntimeBeliefPhase0MeasurementSummary {
  const producerDecisionCount = options.decisions.length
  return {
    runCount: options.runs.length,
    producerDecisionCount,
    lifecycleEventCount: options.events?.length ?? 0,
    labelCount: options.labels.length,
    completedPointCount: points.length,
    runJoinRate: ratio(producerDecisionCount - counts.missingRunRecordCount, producerDecisionCount),
    labelJoinRate: ratio(points.length, producerDecisionCount),
    missingRunRecordCount: counts.missingRunRecordCount,
    missingLabelCount: counts.missingLabelCount,
    withEvidence: points.filter((point) => point.evidence.length > 0).length,
    withOutcome: points.filter((point) => point.outcome).length,
    withSplit: points.filter((point) => typeof point.metadata?.splitTag === 'string').length,
    withBehaviorProb: points.filter((point) => point.behaviorProb !== undefined).length,
    withTargetProb: points.filter((point) => point.targetProb !== undefined).length,
    baselinePolicyId: options.baselinePolicyId ?? DEFAULT_BASELINE_POLICY_ID,
    packetStatus: packet.status,
    claimScope: packet.claimScope,
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function compactMetadata(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
