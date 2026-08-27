import type {
  AgentProfileImprovementExperiment,
  AgentProfileImprovementRunReceipt,
  Sha256Digest,
} from '@tangle-network/agent-interface'
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import {
  type AgentProfileImprovementExperimentExecutionInput,
  measuredComparisonFromAgentProfileImprovementExperiment,
  runAgentProfileImprovementExperiment,
  sealAgentProfileImprovementExperiment,
  sealAgentProfileImprovementSuite,
  sealAgentProfileImprovementTask,
  verifyAgentProfileImprovementExperimentComparison,
} from './profile-measured-comparison'

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as Sha256Digest

function signed<T extends object>(material: T): T & { digest: Sha256Digest } {
  return { ...material, digest: canonicalCandidateDigest(material) }
}

function evidence(kind: string, identity: string) {
  return {
    kind,
    identity,
    digest: canonicalCandidateDigest({ kind, identity }),
  }
}

const grader = {
  name: 'profile-quality',
  version: '1',
  format: 'tangle-grader' as const,
  artifact: {
    locator: {
      kind: 's3' as const,
      bucket: 'agent-eval',
      key: 'graders/profile-quality.json',
      region: 'us-east-1',
    },
    sha256: sha('f'),
    byteLength: 1,
  },
}

const model = {
  requested: 'anthropic/claude-sonnet-4-6',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  snapshot: '2026-06-01',
  reasoningEffort: 'medium' as const,
}

const limits = {
  timeoutMs: 30_000,
  maxSteps: 10,
  maxModelCalls: 1,
  maxInputTokens: 1_000,
  maxOutputTokens: 1_000,
  maxCostUsd: 1,
}

function experiment(reps = 3): AgentProfileImprovementExperiment {
  const task = sealAgentProfileImprovementTask({
    kind: 'agent-profile-improvement-task',
    digestAlgorithm: 'rfc8785-sha256',
    scenario: {
      id: 'support-case-1',
      kind: 'support-case',
      digest: sha('1'),
    },
    grader,
    model,
    limits,
  })
  const seeds = Array.from({ length: reps }, (_, index) => 11 + index) as [number, ...number[]]
  return sealAgentProfileImprovementExperiment({
    kind: 'agent-profile-improvement-experiment',
    digestAlgorithm: 'rfc8785-sha256',
    source: {
      kind: 'platform-agent-profile',
      sourceIdentity: 'profile-support',
      sourceDigest: sha('5'),
      sourceRevision: 7,
    },
    baseline: { stateDigest: sha('5') },
    candidate: { stateDigest: sha('8') },
    change: [
      {
        kind: 'agent-profile-diff',
        id: 'add-source-and-uncertainty',
        source: {
          kind: 'optimizer',
          artifacts: ['traces://run/intelligence-run-1'],
        },
        set: {
          prompt: {
            systemPrompt: 'Answer directly, cite the source, and state uncertainty.',
          },
        },
      },
    ],
    candidateLineage: {
      source: 'optimizer',
      parentDigests: [sha('5')],
      runIds: ['intelligence-run-1'],
      developmentSplitDigest: sha('6'),
    },
    benchmark: sealAgentProfileImprovementSuite({
      splitDigest: sha('2'),
      tasks: [task],
      reps,
      seeds,
    }),
    policy: {
      confidenceLevel: 0.95,
      resamples: 100,
      bootstrapSeed: 17,
      deltaThreshold: 0,
      minProductiveRuns: 3,
      criticalDimensions: ['quality'],
      regressionTolerance: 0,
    },
  })
}

function receipt(
  input: AgentProfileImprovementExperimentExecutionInput,
  score: number,
): AgentProfileImprovementRunReceipt {
  const executionId = `${input.arm}-${input.runCell.repetition}`
  const startedAtMs = input.runCell.repetition * 1_000
  return signed({
    kind: 'agent-profile-improvement-run' as const,
    digestAlgorithm: 'rfc8785-sha256' as const,
    executionId,
    runCell: input.runCell,
    runRecord: evidence('agent-eval-run-record', executionId),
    billing: [evidence('platform-billing', `bill-${executionId}`)] as [ReturnType<typeof evidence>],
    timing: {
      startedAtMs,
      endedAtMs: startedAtMs + 100,
      durationMs: 100,
    },
    resolvedModel: input.task.model,
    limits: input.task.limits,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      modelCalls: 1,
      costUsdNanos: 100,
    },
    trace: {
      evidence: evidence('platform-trace', `trace-${executionId}`),
      eventCount: 4,
      modelCallCount: 1,
    },
    output: evidence('platform-output', `output-${executionId}`),
    outcome: { status: 'succeeded' as const },
    grading: {
      grader: input.task.grader,
      evidence: evidence('agent-eval-grading', `grade-${executionId}`),
      timing: {
        startedAtMs: startedAtMs + 100,
        endedAtMs: startedAtMs + 110,
        durationMs: 10,
      },
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        modelCalls: 1,
        costUsdNanos: 10,
      },
      score,
      passed: true,
      dimensions: [{ name: 'quality', score }],
    },
  })
}

describe('profile improvement measured comparison', () => {
  it('runs exact profile states through one paired measurement path', async () => {
    const frozen = experiment()
    const observed: Array<{
      arm: string
      stateDigest: Sha256Digest
      cellDigest: Sha256Digest
    }> = []
    const measurements = await runAgentProfileImprovementExperiment({
      experiment: frozen,
      maxConcurrency: 2,
      async execute(input) {
        observed.push({
          arm: input.arm,
          stateDigest: input.stateDigest,
          cellDigest: input.runCell.digest,
        })
        return receipt(input, input.arm === 'baseline' ? 0.2 : 0.8)
      },
    })

    const comparison = measuredComparisonFromAgentProfileImprovementExperiment({
      experiment: frozen,
      measurements,
      runId: 'profile-improvement-1',
      candidate: { label: 'source-grounded prompt' },
      generationsExplored: 2,
      searchDurationMs: 50,
      searchCostUsd: 0.25,
    })

    expect(observed).toHaveLength(6)
    expect(observed.filter((entry) => entry.arm === 'baseline')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stateDigest: frozen.baseline.stateDigest }),
      ]),
    )
    expect(observed.filter((entry) => entry.arm === 'candidate')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stateDigest: frozen.candidate.stateDigest }),
      ]),
    )
    expect(new Set(observed.map((entry) => entry.cellDigest)).size).toBe(6)
    expect(comparison.overall.n).toBe(3)
    expect(comparison.overall.baseline).toBeCloseTo(0.2)
    expect(comparison.overall.candidate).toBeCloseTo(0.8)
    expect(comparison.overall.delta).toBeCloseTo(0.6)
    expect(comparison.decision.outcome).toBe('ship')
    expect(comparison.evaluation).toMatchObject({
      executionDurationMs: 660,
      durationMs: 710,
      searchCostUsd: 0.25,
    })
    expect(comparison.evaluation.executionCostUsd).toBeCloseTo(0.00000066)
    expect(comparison.evaluation.totalCostUsd).toBeCloseTo(0.25000066)
    expect(comparison.diff).toContain('add-source-and-uncertainty')
    expect(verifyAgentProfileImprovementExperimentComparison(comparison)).toEqual(comparison)
  })

  it('rejects missing cells, substituted states, and altered published summaries', async () => {
    const frozen = experiment()
    const measurements = await runAgentProfileImprovementExperiment({
      experiment: frozen,
      async execute(input) {
        return receipt(input, input.arm === 'baseline' ? 0.2 : 0.8)
      },
    })

    expect(() =>
      measuredComparisonFromAgentProfileImprovementExperiment({
        experiment: frozen,
        measurements: measurements.slice(0, 2),
        runId: 'missing-cell',
      }),
    ).toThrow(/incomplete/)
    expect(() =>
      measuredComparisonFromAgentProfileImprovementExperiment({
        experiment: frozen,
        measurements: [
          { ...measurements[0]!, candidate: measurements[0]!.baseline },
          ...measurements.slice(1),
        ],
        runId: 'substituted-state',
      }),
    ).toThrow(/substituted/)

    const comparison = measuredComparisonFromAgentProfileImprovementExperiment({
      experiment: frozen,
      measurements,
      runId: 'published-summary',
    })
    expect(() =>
      verifyAgentProfileImprovementExperimentComparison({
        ...comparison,
        overall: { ...comparison.overall, candidate: 0.9, delta: 0.7 },
      }),
    ).toThrow()
  })
})
