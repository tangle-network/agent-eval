import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { type AnalystFinding, type AnalystRunResult, makeFinding } from './analyst/types'
import type { ControlRunResult } from './control-runtime'
import {
  type AnalystReviewDecision,
  analystFindingsToReviewRequests,
  analystRunToFeedbackTrajectory,
  controlRunToFeedbackTrajectory,
  createFeedbackTrajectory,
  type FeedbackAttempt,
  type FeedbackLabel,
  FileSystemFeedbackTrajectoryStore,
  feedbackTrajectoriesToOptimizerRows,
  feedbackTrajectoryToOptimizerRow,
  InMemoryFeedbackTrajectoryStore,
  parseFeedbackTrajectoriesJsonl,
  renderPreferenceMemoryMarkdown,
  replayFeedbackTrajectory,
  serializeFeedbackTrajectoriesJsonl,
  summarizePreferenceMemory,
  withAssignedFeedbackSplit,
} from './feedback-trajectory'

describe('feedback trajectories', () => {
  it('archives a raw analyst run without labels, decisions, or an observed outcome', () => {
    const finding = analystFinding('The tool failed repeatedly', 'tool-3')
    const reviewRequests = analystFindingsToReviewRequests([finding], {
      createdAt: '2026-01-01T00:00:02.000Z',
    })
    const trajectory = analystRunToFeedbackTrajectory(analystRun([finding]), {
      projectId: 'coding-agent',
      scenarioId: 'failed-command',
      task: { intent: 'Fix the command failure.' },
      reviewRequests,
      trace: {
        artifactUri: 'file:///tmp/traces.otlp.jsonl',
        traceIds: ['run'],
      },
    })

    expect(trajectory.attempts[0]?.artifact).toMatchObject({
      type: 'analyst-run',
      analystRunId: 'analysis-1',
      findings: [{ finding_id: finding.finding_id }],
    })
    expect(trajectory.attempts[0]?.metadata?.reviewRequests).toEqual([
      expect.objectContaining({
        findingId: finding.finding_id,
        severity: 'error',
        analystId: 'failure-mode',
      }),
    ])
    expect(trajectory.labels).toHaveLength(0)
    expect(trajectory.outcome?.costUsd).toBe(0.02)
    expect(trajectory.metadata?.analysis).toMatchObject({ reviewDecisions: [] })
    expect(() => feedbackTrajectoryToOptimizerRow(trajectory)).toThrow(
      new RegExp(`missing independent decisions.*${finding.finding_id}`),
    )
  })

  it('rejects two findings with a run-level outcome but no per-finding decisions', () => {
    const findings = [
      analystFinding('The tool failed repeatedly', 'tool-3'),
      analystFinding('The failure was never verified', 'tool-4'),
    ]
    const trajectory = analystRunToFeedbackTrajectory(analystRun(findings), {
      task: { intent: 'Inspect traces.' },
      outcome: { success: false, score: 0 },
    })

    expect(() => feedbackTrajectoryToOptimizerRow(trajectory)).toThrow(
      /missing independent decisions/,
    )
  })

  it('rejects incomplete decisions instead of filtering unreviewed findings', () => {
    const findings = [
      analystFinding('The tool failed repeatedly', 'tool-3'),
      analystFinding('The failure was never verified', 'tool-4'),
    ]
    const incomplete = analystRunToFeedbackTrajectory(analystRun(findings), {
      task: { intent: 'Inspect traces.' },
      reviewDecisions: [findingDecision(findings[0]!.finding_id, 'confirmed')],
    })
    const complete = analystRunToFeedbackTrajectory(analystRun(findings), {
      task: { intent: 'Inspect traces.' },
      reviewDecisions: [
        findingDecision(findings[0]!.finding_id, 'confirmed'),
        findingDecision(findings[1]!.finding_id, 'rejected'),
      ],
    })

    expect(() => feedbackTrajectoriesToOptimizerRows([complete, incomplete])).toThrow(
      /missing independent decisions/,
    )
  })

  it('rejects duplicate, unknown, and non-independent decisions at archival time', () => {
    const finding = analystFinding('The tool failed repeatedly', 'tool-3')
    const run = analystRun([finding])
    const duplicate = findingDecision(finding.finding_id, 'confirmed')

    expect(() =>
      analystRunToFeedbackTrajectory(run, {
        task: { intent: 'Inspect traces.' },
        reviewDecisions: [duplicate, { ...duplicate, verdict: 'rejected' }],
      }),
    ).toThrow(/duplicate analyst review decision/)
    expect(() =>
      analystRunToFeedbackTrajectory(run, {
        task: { intent: 'Inspect traces.' },
        reviewDecisions: [findingDecision('unknown-finding', 'rejected')],
      }),
    ).toThrow(/unknown finding id "unknown-finding"/)
    expect(() =>
      analystRunToFeedbackTrajectory(run, {
        task: { intent: 'Inspect traces.' },
        reviewDecisions: [
          {
            ...findingDecision(finding.finding_id, 'confirmed'),
            reviewerId: 'failure-mode',
          },
        ],
      }),
    ).toThrow(/reviewerId must differ from the generating analyst/)
  })

  it('checks stored decisions against the archived findings at export time', () => {
    const finding = analystFinding('The tool failed repeatedly', 'tool-3')
    const trajectory = analystRunToFeedbackTrajectory(analystRun([finding]), {
      task: { intent: 'Inspect traces.' },
      reviewDecisions: [findingDecision(finding.finding_id, 'confirmed')],
    })
    const artifact = trajectory.attempts[0]!.artifact as {
      findings: AnalystFinding[]
    }
    artifact.findings.push(analystFinding('The failure was never verified', 'tool-4'))

    expect(() => feedbackTrajectoryToOptimizerRow(trajectory)).toThrow(
      /missing independent decisions/,
    )
  })

  it('exports a completely reviewed confirmed and rejected finding set', () => {
    const findings = [
      analystFinding('The tool failed repeatedly', 'tool-3'),
      analystFinding('The failure was never verified', 'tool-4'),
    ]
    const reviewDecisions = [
      findingDecision(findings[0]!.finding_id, 'confirmed'),
      findingDecision(findings[1]!.finding_id, 'rejected'),
    ]
    const trajectory = analystRunToFeedbackTrajectory(analystRun(findings), {
      task: { intent: 'Inspect traces.' },
      reviewDecisions,
      outcome: { success: false, score: 0.9 },
    })

    expect(feedbackTrajectoryToOptimizerRow(trajectory)).toMatchObject({
      labelKinds: ['approve', 'reject'],
      score: 0.5,
      metadata: {
        analystReview: {
          findingIds: findings.map((finding) => finding.finding_id),
          decisions: reviewDecisions,
        },
      },
    })
  })

  it('requires independent clean confirmation before exporting a zero-finding run', () => {
    const raw = analystRunToFeedbackTrajectory(analystRun([]), {
      task: { intent: 'Inspect traces.' },
      labels: [
        {
          source: 'environment',
          kind: 'approve',
          value: true,
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      ],
      outcome: { success: true, score: 1 },
    })
    expect(() => feedbackTrajectoryToOptimizerRow(raw)).toThrow(
      /zero-finding analyst run requires one independent confirmed_clean decision/,
    )

    const reviewed = analystRunToFeedbackTrajectory(analystRun([]), {
      task: { intent: 'Inspect traces.' },
      reviewDecisions: [cleanDecision()],
    })
    expect(feedbackTrajectoryToOptimizerRow(reviewed)).toMatchObject({
      labelKinds: ['approve'],
      score: 1,
      metadata: {
        analystReview: {
          findingIds: [],
          decisions: [cleanDecision()],
        },
      },
    })
  })

  it('turns control runs into stable feedback trajectories for optimization', () => {
    const run: ControlRunResult<{ count: number }, { type: 'increment' }, { count: number }> = {
      intent: 'make count positive',
      pass: true,
      completed: true,
      reason: 'all critical evals passed',
      score: 1,
      steps: [
        {
          index: 0,
          decision: { type: 'continue', action: { type: 'increment' } },
          beforeState: { count: 0 },
          afterState: { count: 1 },
          evalsBefore: [],
          evalsAfter: [
            { id: 'count-positive', passed: true, severity: 'critical', objective: true },
          ],
          actionOutcome: { ok: true, result: { count: 1 }, durationMs: 5 },
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:00.005Z',
        },
      ],
      finalState: { count: 1 },
      finalEvals: [{ id: 'count-positive', passed: true, severity: 'critical', objective: true }],
      wallMs: 5,
      spentCostUsd: 0.01,
      runId: null,
      runtimeErrors: [],
      stoppedBy: 'stop-policy',
    }

    const trajectory = controlRunToFeedbackTrajectory(run, {
      projectId: 'project-1',
      scenarioId: 'scenario-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const row = feedbackTrajectoryToOptimizerRow(trajectory)

    expect(trajectory.id).toMatch(/^ft_control_/)
    expect(trajectory.attempts[0]!.id).toBe(`${trajectory.id}_step_0`)
    expect(trajectory.outcome?.metadata?.stoppedBy).toBe('stop-policy')
    expect(row).toMatchObject({
      scenarioId: 'scenario-1',
      trajectoryId: trajectory.id,
      score: 1,
    })
  })

  it('keeps attempt feedback scoped and deduplicated for preference memory', async () => {
    const store = new InMemoryFeedbackTrajectoryStore()
    const trajectory = createFeedbackTrajectory({
      id: 'feedback-1',
      task: { intent: 'draft a launch plan' },
      createdAt: '2026-01-01T00:00:00.000Z',
      attempts: [attempt('attempt-1')],
    })
    const label: FeedbackLabel = {
      id: 'label-1',
      source: 'user',
      kind: 'revision_request',
      value: 'too vague',
      reason: 'make the rollout steps concrete',
      severity: 'critical',
      createdAt: '2026-01-01T00:01:00.000Z',
    }

    await store.save(trajectory)
    const updated = await store.appendLabel('feedback-1', label, 'attempt-1')
    const entries = summarizePreferenceMemory([updated])

    expect(updated.labels).toHaveLength(0)
    expect(updated.attempts[0]!.feedback).toEqual([label])
    expect(entries).toHaveLength(1)
    expect(renderPreferenceMemoryMarkdown(entries)).toContain('make the rollout steps concrete')
  })

  it('round-trips deterministic JSONL and assigns stable dataset splits', () => {
    const trajectory = withAssignedFeedbackSplit(
      createFeedbackTrajectory({
        id: 'feedback-2',
        projectId: 'project-2',
        scenarioId: 'scenario-2',
        task: { intent: 'fix checkout' },
        createdAt: '2026-01-01T00:00:00.000Z',
        tags: { product: 'checkout' },
      }),
    )

    const jsonl = serializeFeedbackTrajectoriesJsonl([trajectory])
    const parsed = parseFeedbackTrajectoriesJsonl(jsonl)

    expect(parsed).toEqual([trajectory])
    expect(parsed[0]!.split).toBe(trajectory.split)
  })

  it('persists trajectories and skips corrupt JSONL records without losing valid data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedback-trajectories-'))
    try {
      const file = join(dir, 'feedback-trajectories.ndjson')
      const saved = createFeedbackTrajectory({
        id: 'feedback-3',
        task: { intent: 'ship docs' },
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      await writeFile(
        file,
        [
          JSON.stringify({ op: 'save', trajectory: saved }),
          '{bad json',
          JSON.stringify({ op: 'appendAttempt', id: 'feedback-3', attempt: attempt('attempt-3') }),
          '',
        ].join('\n'),
        'utf8',
      )

      const store = new FileSystemFeedbackTrajectoryStore({ dir })
      const loaded = await store.get('feedback-3')

      expect(loaded?.attempts.map((item) => item.id)).toEqual(['attempt-3'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('replays trajectories through a caller adapter and returns structured failures', async () => {
    const trajectory = createFeedbackTrajectory({
      id: 'feedback-4',
      task: { intent: 'complete browser checkout' },
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const pass = await replayFeedbackTrajectory(trajectory, {
      replay: () => ({
        pass: true,
        score: 0.9,
        labels: [
          {
            source: 'environment',
            kind: 'approve',
            value: true,
            createdAt: '2026-01-01T00:01:00.000Z',
          },
        ],
      }),
    })
    expect(pass).toMatchObject({ trajectoryId: 'feedback-4', pass: true, score: 0.9 })

    const fail = await replayFeedbackTrajectory(trajectory, {
      replay: () => {
        throw new Error('browser assertion failed')
      },
    })
    expect(fail.pass).toBe(false)
    expect(fail.labels[0]!.reason).toBe('browser assertion failed')
    expect(fail.metadata?.replayError).toBe(true)
  })
})

function attempt(id: string): FeedbackAttempt {
  return {
    id,
    stepIndex: 0,
    artifactType: 'plan',
    artifact: { title: 'draft' },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function analystFinding(claim: string, spanId: string): AnalystFinding {
  return makeFinding({
    analyst_id: 'failure-mode',
    area: 'failure-mode',
    claim,
    severity: 'high',
    confidence: 0.9,
    evidence_refs: [{ kind: 'span', uri: `trace://run/span/${spanId}` }],
  })
}

function analystRun(findings: AnalystFinding[]): AnalystRunResult {
  return {
    run_id: 'analysis-1',
    correlation_id: 'correlation-1',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:00:02.000Z',
    findings,
    per_analyst: [],
    total_cost_usd: 0.02,
    total_cost_provenance: { kind: 'observed', usd: 0.02 },
  }
}

function findingDecision(
  findingId: string,
  verdict: 'confirmed' | 'rejected',
): Extract<AnalystReviewDecision, { findingId: string }> {
  return {
    findingId,
    verdict,
    source: 'user',
    reviewerId: 'reviewer-1',
    reviewId: 'review-1',
    reason:
      verdict === 'confirmed' ? 'The cited span proves the claim.' : 'The span contradicts it.',
    decidedAt: '2026-01-01T00:00:03.000Z',
  }
}

function cleanDecision(): Extract<AnalystReviewDecision, { verdict: 'confirmed_clean' }> {
  return {
    verdict: 'confirmed_clean',
    source: 'environment',
    reviewerId: 'trace-check-1',
    reviewId: 'review-clean-1',
    reason: 'Independent checks found no reportable failure.',
    decidedAt: '2026-01-01T00:00:03.000Z',
  }
}
