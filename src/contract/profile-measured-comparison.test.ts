import { setTimeout as delay } from 'node:timers/promises'
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

function profileTask(scenarioDigest = sha('1')) {
  return sealAgentProfileImprovementTask({
    kind: 'agent-profile-improvement-task',
    digestAlgorithm: 'rfc8785-sha256',
    scenario: {
      id: 'support-case-1',
      kind: 'support-case',
      digest: scenarioDigest,
    },
    grader,
    model,
    limits,
  })
}

function experiment(
  reps = 3,
  tasks: [ReturnType<typeof profileTask>, ...ReturnType<typeof profileTask>[]] = [profileTask()],
): AgentProfileImprovementExperiment {
  const seeds = Array.from({ length: tasks.length * reps }, (_, index) => 11 + index) as [
    number,
    ...number[],
  ]
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
      tasks,
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
  executionId = `${input.arm}-${input.runCell.repetition}`,
): AgentProfileImprovementRunReceipt {
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
    steps: 1,
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

  it('keeps distinct signed task positions when scenarios share a display id', async () => {
    const frozen = experiment(2, [profileTask(), profileTask(sha('a'))])
    const measurements = await runAgentProfileImprovementExperiment({
      experiment: frozen,
      async execute(input) {
        return receipt(
          input,
          input.arm === 'baseline' ? 0.2 : 0.8,
          `${input.arm}-${input.runCell.taskIndex}-${input.runCell.repetition}`,
        )
      },
    })

    expect(() =>
      measuredComparisonFromAgentProfileImprovementExperiment({
        experiment: frozen,
        measurements,
        runId: 'same-profile-scenario-id',
      }),
    ).not.toThrow()
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

  it('rejects forged receipts and receipts bound to a different task contract', async () => {
    const frozen = experiment()
    const measurements = await runAgentProfileImprovementExperiment({
      experiment: frozen,
      async execute(input) {
        return receipt(input, input.arm === 'baseline' ? 0.2 : 0.8)
      },
    })
    const first = measurements[0]!

    expect(() =>
      measuredComparisonFromAgentProfileImprovementExperiment({
        experiment: frozen,
        measurements: [
          { ...first, candidate: { ...first.candidate, steps: 2 } },
          ...measurements.slice(1),
        ],
        runId: 'forged-receipt',
      }),
    ).toThrow(/profile improvement run receipt digest is invalid/)

    const { digest: _digest, ...candidateMaterial } = first.candidate
    const substitutedModel = signed({
      ...candidateMaterial,
      resolvedModel: { ...candidateMaterial.resolvedModel, model: 'claude-opus-4-6' },
    })
    expect(() =>
      measuredComparisonFromAgentProfileImprovementExperiment({
        experiment: frozen,
        measurements: [{ ...first, candidate: substitutedModel }, ...measurements.slice(1)],
        runId: 'substituted-task-contract',
      }),
    ).toThrow(/substituted its candidate task contract/)
  })

  it('rejects invalid suite schedules and concurrency before execution', async () => {
    expect(() =>
      sealAgentProfileImprovementSuite({
        splitDigest: sha('2'),
        tasks: [profileTask()],
        reps: 2,
        seeds: [11],
      }),
    ).toThrow(/one seed per task and repetition/)

    await expect(
      runAgentProfileImprovementExperiment({
        experiment: experiment(),
        maxConcurrency: 0,
        async execute(input) {
          return receipt(input, 1)
        },
      }),
    ).rejects.toThrow(/maxConcurrency must be a positive integer/)
  })

  it('limits simultaneous host executions rather than paired cells', async () => {
    let active = 0
    let peakActive = 0
    const measurements = await runAgentProfileImprovementExperiment({
      experiment: experiment(),
      maxConcurrency: 1,
      async execute(input) {
        active += 1
        peakActive = Math.max(peakActive, active)
        await delay(1)
        active -= 1
        return receipt(input, input.arm === 'baseline' ? 0.2 : 0.8)
      },
    })

    expect(measurements).toHaveLength(3)
    expect(peakActive).toBe(1)
  })

  it('cancels and settles a sibling arm before rejecting a failed cell', async () => {
    const frozen = experiment()
    const failure = new Error('baseline execution failed')
    let calls = 0
    let candidateAborted = false
    let candidateSettled = false

    const run = runAgentProfileImprovementExperiment({
      experiment: frozen,
      maxConcurrency: 2,
      async execute(input) {
        calls += 1
        if (input.runCell.repetition > 0) {
          throw new Error('dispatched work after the first failed cell')
        }
        if (input.arm === 'baseline') {
          await delay(1)
          throw failure
        }
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve()
          else input.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        candidateAborted = input.signal?.aborted ?? false
        await delay(20)
        candidateSettled = true
        return receipt(input, 0.8)
      },
    })

    await expect(run).rejects.toBe(failure)
    expect(candidateAborted).toBe(true)
    expect(candidateSettled).toBe(true)
    expect(calls).toBe(2)
  })
})
