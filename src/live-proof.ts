import type { ReleaseConfidenceScorecard, ReleaseConfidenceThresholds, ReleaseTraceEvidence } from './release-confidence'
import { evaluateReleaseConfidence } from './release-confidence'
import type { CheckResult, TestResult } from './types'
import {
  createFeedbackTrajectory,
  type FeedbackLabel,
  type FeedbackTrajectory,
  type FeedbackTrajectoryStore,
} from './feedback-trajectory'

export interface LiveProofArtifact {
  kind: string
  id?: string
  path?: string
  url?: string
  metadata?: Record<string, unknown>
}

export interface LiveProofContext {
  projectId: string
  scenarioId: string
  task: string
  checks: CheckResult[]
  artifacts: LiveProofArtifact[]
  labels: FeedbackLabel[]
  metadata: Record<string, unknown>
  transcript: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string; at: string }[]
  addCheck(check: CheckResult): void
  addArtifact(artifact: LiveProofArtifact): void
  addLabel(label: Omit<FeedbackLabel, 'createdAt'> & { createdAt?: string }): void
  addTurn(turn: { role: 'user' | 'assistant' | 'system' | 'tool'; content: string; at?: string }): void
}

export interface LiveProofConfig {
  projectId: string
  scenarioId: string
  task: string
  drive(context: LiveProofContext): Promise<void> | void
  validate?(context: LiveProofContext): Promise<CheckResult[] | void> | CheckResult[] | void
  requiredArtifacts?: string[]
  minPassRate?: number
  trajectoryStore?: FeedbackTrajectoryStore
  releaseConfidence?: {
    target: string
    candidateId?: string
    baselineId?: string
    thresholds?: ReleaseConfidenceThresholds
  }
  metadata?: Record<string, unknown>
}

export interface LiveProofResult extends TestResult {
  projectId: string
  scenarioId: string
  artifacts: LiveProofArtifact[]
  labels: FeedbackLabel[]
  transcript: LiveProofContext['transcript']
  trajectory: FeedbackTrajectory
  releaseConfidence?: ReleaseConfidenceScorecard
}

export async function runLiveProof(config: LiveProofConfig): Promise<LiveProofResult> {
  const startedAt = Date.now()
  const checks: CheckResult[] = []
  const artifacts: LiveProofArtifact[] = []
  const labels: FeedbackLabel[] = []
  const transcript: LiveProofContext['transcript'] = []
  const metadata = { ...(config.metadata ?? {}), live: true }
  const context: LiveProofContext = {
    projectId: config.projectId,
    scenarioId: config.scenarioId,
    task: config.task,
    checks,
    artifacts,
    labels,
    metadata,
    transcript,
    addCheck: (check) => checks.push(check),
    addArtifact: (artifact) => artifacts.push(artifact),
    addLabel: (label) => labels.push({ ...label, createdAt: label.createdAt ?? new Date().toISOString() }),
    addTurn: (turn) => transcript.push({ ...turn, at: turn.at ?? new Date().toISOString() }),
  }

  try {
    await config.drive(context)
    const validationChecks = await config.validate?.(context)
    if (validationChecks) checks.push(...validationChecks)
  } catch (err) {
    checks.push({
      name: 'live_proof_runtime',
      passed: false,
      expected: 'live proof completes without runtime failure',
      actual: err instanceof Error ? err.message : String(err),
    })
  }

  for (const kind of config.requiredArtifacts ?? []) {
    checks.push({
      name: `artifact:${kind}`,
      passed: artifacts.some((artifact) => artifact.kind === kind),
      expected: `artifact kind ${kind}`,
      actual: artifacts.map((artifact) => artifact.kind).join(', ') || 'none',
    })
  }

  const passRate = checks.length === 0 ? 0 : checks.filter((check) => check.passed).length / checks.length
  if (config.minPassRate !== undefined) {
    checks.push({
      name: 'min_pass_rate',
      passed: passRate >= config.minPassRate,
      expected: `pass rate >= ${config.minPassRate}`,
      actual: passRate.toFixed(3),
    })
  }

  const passed = checks.length > 0 && checks.every((check) => check.passed)
  const duration = Date.now() - startedAt
  const trajectory = createFeedbackTrajectory({
    projectId: config.projectId,
    scenarioId: config.scenarioId,
    task: { intent: config.task },
    labels,
    outcome: {
      success: passed,
      score: checks.length === 0 ? 0 : checks.filter((check) => check.passed).length / checks.length,
      detail: `${checks.filter((check) => check.passed).length}/${checks.length} checks passed`,
      observedAt: new Date().toISOString(),
      metadata: {
        artifacts,
        transcript,
      },
    },
    metadata,
  })
  await config.trajectoryStore?.save(trajectory)

  const releaseConfidence = config.releaseConfidence
    ? evaluateReleaseConfidence({
      ...config.releaseConfidence,
      traces: [liveProofToReleaseTrace(config, trajectory, duration)],
      thresholds: {
        requireCorpus: false,
        requireHoldout: false,
        minScenarioCount: 0,
        minSearchRuns: 0,
        minHoldoutRuns: 0,
        requireAsiForFailures: false,
        ...(config.releaseConfidence.thresholds ?? {}),
      },
    })
    : undefined

  return {
    name: config.scenarioId,
    passed: passed && (releaseConfidence ? releaseConfidence.status !== 'fail' : true),
    duration,
    detail: `${checks.filter((check) => check.passed).length}/${checks.length} checks passed`,
    checks,
    projectId: config.projectId,
    scenarioId: config.scenarioId,
    artifacts,
    labels,
    transcript,
    trajectory,
    releaseConfidence,
  }
}

function liveProofToReleaseTrace(
  config: LiveProofConfig,
  trajectory: FeedbackTrajectory,
  durationMs: number,
): ReleaseTraceEvidence {
  return {
    scenarioId: config.scenarioId,
    candidateId: config.releaseConfidence?.candidateId,
    split: trajectory.split === 'holdout' ? 'holdout' : trajectory.split === 'dev' ? 'dev' : 'search',
    score: trajectory.outcome?.score,
    ok: trajectory.outcome?.success,
    turnCount: Array.isArray(trajectory.outcome?.metadata?.transcript)
      ? trajectory.outcome.metadata.transcript.length
      : undefined,
    durationMs,
    metadata: {
      projectId: config.projectId,
      artifacts: trajectory.outcome?.metadata?.artifacts,
    },
  }
}
