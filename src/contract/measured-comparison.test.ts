import type {
  AgentCandidateBenchmarkCellRef,
  AgentCandidateBenchmarkTask,
  AgentCandidateBundle,
  AgentCandidateExperiment,
  AgentCandidateFixedSpend,
  AgentCandidateTermination,
  CandidateExecutionEvidence,
  Sha256Digest,
} from '@tangle-network/agent-interface'
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import {
  measuredComparisonFromCandidateExperiment,
  runCandidateExperiment,
  sealCandidateBenchmarkSuite,
  sealCandidateBenchmarkTask,
  sealCandidateExperiment,
  verifyCandidateExperiment,
  verifyCandidateExperimentComparison,
} from './measured-comparison'

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as Sha256Digest

function artifact(key: string, digest = sha('a'), byteLength = 1) {
  return {
    locator: { kind: 's3' as const, bucket: 'candidate-artifacts', key },
    sha256: digest,
    byteLength,
  }
}

function addressed<T extends object>(material: T): T & { digest: Sha256Digest } {
  return { ...material, digest: canonicalCandidateDigest(material) }
}

function materialEvidence<TKind extends string, TMaterial extends object>(
  kind: TKind,
  material: TMaterial,
  key: string,
) {
  const digest = canonicalCandidateDigest(material)
  return {
    kind,
    digest,
    material,
    artifact: artifact(key, digest),
  }
}

function workspace(name: string) {
  const material = {
    kind: 'agent-candidate-workspace-manifest' as const,
    files: [],
  }
  const digest = canonicalCandidateDigest(material)
  return {
    kind: 'agent-candidate-workspace-snapshot' as const,
    digest,
    material,
    manifest: artifact(`workspaces/${name}.manifest.json`, digest),
    archive: artifact(`workspaces/${name}.tar`, sha('b')),
  }
}

const resolvedModel = {
  requested: 'openai/gpt-5.4',
  provider: 'openai',
  model: 'gpt-5.4',
  snapshot: 'gpt-5.4-2026-07-15',
  reasoningEffort: 'high' as const,
}

function bundle(prompt: string): AgentCandidateBundle {
  return addressed({
    kind: 'agent-candidate-bundle' as const,
    digestAlgorithm: 'rfc8785-sha256' as const,
    profile: {
      name: 'support-agent',
      prompt: { systemPrompt: prompt },
      resources: { failOnError: true as const },
    },
    code: {
      kind: 'disabled' as const,
    },
    execution: {
      harness: 'codex' as const,
      harnessVersion: '0.1.0',
      launch: { kind: 'container-command' as const, executable: 'node' },
      instructionDelivery: { kind: 'stdin-utf8' as const },
      cwd: { workspace: 'task' as const, path: '.' },
      env: {
        PATH: { kind: 'public' as const, value: '/usr/local/bin:/usr/bin:/bin' },
      },
      environment: { kind: 'evaluator-task-container' as const },
      isolation: {
        network: 'disabled' as const,
        remoteIntegrations: 'disabled' as const,
        candidateSecrets: 'disabled' as const,
      },
    },
    memory: { mode: 'disabled' as const },
  })
}

function benchmarkTask(): AgentCandidateBenchmarkTask {
  return sealCandidateBenchmarkTask({
    kind: 'agent-candidate-benchmark-task',
    digestAlgorithm: 'rfc8785-sha256',
    benchmark: {
      name: 'support-quality',
      version: '2026-07-15',
      splitDigest: sha('1'),
    },
    scenario: {
      id: 'case-1',
      kind: 'support-case',
      scenarioDigest: sha('2'),
    },
    instruction: 'Resolve the support case.',
    outcome: { kind: 'output', mediaType: 'text/plain', maxBytes: 4_096 },
    workspace: workspace('case-1'),
    grader: {
      name: 'support-grader',
      version: '1.0.0',
      format: 'tangle-grader',
      artifact: artifact('graders/support-grader.tar', sha('3')),
    },
    model: resolvedModel,
    attempt: { maxAttempts: 1, retryPolicy: 'none' },
    evaluatorTaskContainer: {
      source: 'evaluator-task-container',
      image: 'ghcr.io/tangle-network/support-eval:sha-abc',
      indexDigest: sha('4'),
      manifestDigest: sha('5'),
      platform: { os: 'linux', architecture: 'amd64' },
    },
    limits: {
      timeoutMs: 60_000,
      maxSteps: 20,
      maxModelCalls: 1,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxCostUsd: 0.1,
    },
  })
}

function experiment(reps = 3): AgentCandidateExperiment {
  const task = benchmarkTask()
  const seeds = Array.from({ length: reps }, (_, index) => 101 + index) as [number, ...number[]]
  return sealCandidateExperiment({
    kind: 'agent-candidate-experiment',
    digestAlgorithm: 'rfc8785-sha256',
    baseline: bundle('Answer the support request.'),
    candidate: bundle('Answer the support request and verify every claim.'),
    candidateLineage: { source: 'human' },
    benchmark: sealCandidateBenchmarkSuite({ tasks: [task], reps, seeds }),
    policy: {
      confidenceLevel: 0.95,
      resamples: 2_000,
      bootstrapSeed: 1_337,
      deltaThreshold: 0,
      minProductiveRuns: 3,
      budgetUsd: 1,
      criticalDimensions: ['reliability'],
      regressionTolerance: 0.05,
    },
  })
}

function executionEvidence(input: {
  experiment: AgentCandidateExperiment
  arm: 'baseline' | 'candidate'
  task: AgentCandidateBenchmarkTask
  benchmarkCell: AgentCandidateBenchmarkCellRef
  score: number
  passed?: boolean
  termination?: AgentCandidateTermination
  sourceProfileDigest?: Sha256Digest
  profileEnv?: Record<string, { kind: 'public'; value: string }>
  graderUsage?: AgentCandidateFixedSpend
  graderDurationMs?: number
  dimensions?: Array<{ name: string; score: number }>
}): CandidateExecutionEvidence {
  const bundle = input.experiment[input.arm]
  const executionId = `${input.arm}-${input.benchmarkCell.repetition}`
  const cellIndex =
    input.benchmarkCell.taskIndex * input.experiment.benchmark.suite.reps +
    input.benchmarkCell.repetition
  const seed = input.experiment.benchmark.suite.seeds[cellIndex]!
  const runCell = addressed({
    kind: 'agent-candidate-run-cell' as const,
    experimentDigest: input.experiment.digest,
    arm: input.arm,
    bundleDigest: bundle.digest,
    suiteDigest: input.experiment.benchmark.suite.digest,
    taskDigest: input.task.digest,
    taskIndex: input.benchmarkCell.taskIndex,
    repetition: input.benchmarkCell.repetition,
    seed,
    attempt: 1,
  })
  const profilePlan = materialEvidence(
    'agent-profile-workspace-plan',
    {
      sourceProfileDigest: input.sourceProfileDigest ?? canonicalCandidateDigest(bundle.profile),
      harness: 'codex' as const,
      files: [],
      env: input.profileEnv ?? {},
      flags: [],
      unsupported: [],
    },
    `plans/${executionId}-profile.json`,
  )
  const profileActivation = addressed({
    kind: 'agent-candidate-profile-activation' as const,
    profilePlan,
    files: [],
  })
  const executionPlan = materialEvidence(
    'agent-candidate-execution-plan',
    {
      kind: 'agent-candidate-execution-plan-material' as const,
      runCell,
      executionId,
      workspaces: { taskRoot: '/work/task' },
      codeKind: 'disabled' as const,
      profile: {
        planDigest: profilePlan.digest,
        targetWorkspace: 'task' as const,
        mountPaths: [],
      },
      harness: 'codex' as const,
      harnessVersion: '0.1.0',
      instructionDelivery: bundle.execution.instructionDelivery,
      limits: input.task.limits,
      container: {
        source: 'evaluator-task-container' as const,
        image: 'ghcr.io/tangle-network/support-eval:sha-abc',
        indexDigest: sha('4'),
        manifestDigest: sha('5'),
        platform: { os: 'linux', architecture: 'amd64' },
      },
      model: {
        policy: 'single' as const,
        resolved: resolvedModel,
        access: {
          kind: 'evaluator-mediated' as const,
          grantDigest: sha('6'),
          network: {
            mode: 'gateway-only' as const,
            domains: ['router.tangle.tools'],
          },
        },
        routes: [{ kind: 'primary' as const, requested: resolvedModel.requested }],
      },
      launch: {
        executable: 'node',
        args: [],
        env: {
          PATH: { kind: 'public' as const, value: '/usr/local/bin:/usr/bin:/bin' },
        },
        cwd: { workspace: 'task' as const, path: '.' },
      },
      memory: { mode: 'disabled' as const },
      network: { mode: 'disabled' as const },
    },
    `plans/${executionId}-execution.json`,
  )
  const materializationReceipt = addressed({
    kind: 'agent-candidate-materialization' as const,
    digestAlgorithm: 'rfc8785-sha256' as const,
    bundleDigest: bundle.digest,
    benchmark: {
      suite: {
        digest: input.experiment.benchmark.suite.digest,
        material: artifact(
          `benchmarks/${input.experiment.benchmark.suite.digest}.json`,
          input.experiment.benchmark.suite.digest,
        ),
      },
      task: {
        digest: input.task.digest,
        material: artifact(`benchmarks/${input.task.digest}.json`, input.task.digest),
      },
    },
    profileActivation,
    executionPlan,
    codeKind: 'disabled' as const,
    harness: 'codex' as const,
    harnessVersion: '0.1.0',
    container: executionPlan.material.container,
    resolvedModel,
  })
  const modelSettlement = materialEvidence(
    'agent-candidate-model-settlement',
    {
      kind: 'agent-candidate-model-settlement-material' as const,
      executionPlanDigest: executionPlan.digest,
      preparationId: `preparation-${executionId}`,
      grantDigest: executionPlan.material.model.access.grantDigest,
      closed: true as const,
      resolved: resolvedModel,
      calls: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        modelCalls: 0,
        costUsdNanos: 0,
      },
    },
    `settlements/${executionId}.json`,
  )
  const taskOutcome = materialEvidence(
    'agent-candidate-task-outcome',
    {
      kind: 'agent-candidate-task-outcome-material' as const,
      executionPlanDigest: executionPlan.digest,
      outcome: {
        kind: 'output' as const,
        spec:
          input.task.outcome.kind === 'output'
            ? {
                mediaType: input.task.outcome.mediaType,
                maxBytes: input.task.outcome.maxBytes,
              }
            : neverOutput(),
        artifact: artifact(`outcomes/${executionId}.txt`, sha('7'), 20),
      },
    },
    `outcomes/${executionId}.json`,
  )
  const benchmarkResult = materialEvidence(
    'agent-candidate-benchmark-result',
    {
      kind: 'agent-candidate-benchmark-result-material' as const,
      executionPlanDigest: executionPlan.digest,
      taskOutcomeDigest: taskOutcome.digest,
      grader: input.task.grader,
      evidence: artifact(`results/${executionId}-grader.json`, sha('8'), 20),
      grading: {
        usage: input.graderUsage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          modelCalls: 0,
          costUsdNanos: 0,
        },
        timing: {
          startedAtMs: 2_000,
          endedAtMs: 2_000 + (input.graderDurationMs ?? 0),
          durationMs: input.graderDurationMs ?? 0,
        },
      },
      score: input.score,
      passed: input.passed ?? input.score >= 0.5,
      dimensions: input.dimensions ?? [{ name: 'reliability', score: input.score }],
    },
    `results/${executionId}.json`,
  )
  const startedAtMs = 1_000 + input.benchmarkCell.repetition * 100
  const durationMs = input.arm === 'baseline' ? 100 : 90
  const receipt = addressed({
    kind: 'agent-candidate-run' as const,
    digestAlgorithm: 'rfc8785-sha256' as const,
    bundleDigest: bundle.digest,
    runCellDigest: runCell.digest,
    materializationReceiptDigest: materializationReceipt.digest,
    executionPlanDigest: executionPlan.digest,
    timing: {
      startedAtMs,
      endedAtMs: startedAtMs + durationMs,
      durationMs,
    },
    memory: { mode: 'disabled' as const },
    trace: {
      artifact: artifact(`traces/${executionId}.json`, sha('9'), 20),
      eventCount: 1,
      modelCallCount: 0,
    },
    termination: input.termination ?? { kind: 'exit' as const, exitCode: 0 },
    executorCapture: artifact(`captures/${executionId}.json`, sha('a'), 20),
    modelSettlement,
    taskOutcome,
    benchmarkResult,
  })
  return addressed({
    kind: 'agent-candidate-execution-evidence' as const,
    materializationReceipt,
    receipt,
  })
}

function neverOutput(): never {
  throw new Error('fixture task must use an output contract')
}

describe('candidate experiment comparison', () => {
  it('rejects an experiment whose candidate is identical to its baseline', () => {
    const frozen = experiment()
    const { digest: _digest, ...material } = frozen
    expect(() =>
      sealCandidateExperiment({
        ...material,
        candidate: frozen.baseline,
      }),
    ).toThrow(/identical/)
  })

  it('runs the exact signed matrix and derives every statistic from Runtime receipts', async () => {
    const frozen = experiment()
    const observedSeeds: number[] = []
    const measurements = await runCandidateExperiment({
      experiment: frozen,
      maxConcurrency: 3,
      async execute(input) {
        observedSeeds.push(input.seed)
        const baseline = [0.2, 0.25, 0.3][input.benchmarkCell.repetition]!
        const candidate = [0.7, 0.75, 0.8][input.benchmarkCell.repetition]!
        return executionEvidence({
          experiment: input.experiment,
          arm: input.arm,
          task: input.task,
          benchmarkCell: input.benchmarkCell,
          score: input.arm === 'baseline' ? baseline : candidate,
          graderUsage: {
            inputTokens: 10,
            outputTokens: 2,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            modelCalls: 1,
            costUsdNanos: 10_000_000,
          },
          graderDurationMs: 5,
        })
      },
    })
    const comparison = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements,
      runId: 'candidate-experiment-1',
      candidate: { label: 'verified-claims prompt' },
      generationsExplored: 2,
      searchDurationMs: 50,
      searchCostUsd: 0.25,
    })

    expect(comparison.overall).toMatchObject({ baseline: 0.25, candidate: 0.75, delta: 0.5, n: 3 })
    expect(comparison.decision.outcome).toBe('ship')
    expect(comparison.diff).toContain('--- baseline/profile')
    expect(comparison.diff).toContain('verify every claim')
    expect(comparison.measurements).toHaveLength(3)
    expect(comparison.evaluation).toMatchObject({
      executionDurationMs: 600,
      durationMs: 650,
    })
    expect(comparison.evaluation.executionCostUsd).toBeCloseTo(0.06)
    expect(comparison.evaluation.totalCostUsd).toBeCloseTo(0.31)
    expect(comparison.objectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'cost', baseline: 0.01, candidate: 0.01 }),
        expect.objectContaining({ kind: 'latency', baseline: 105, candidate: 95 }),
      ]),
    )
    expect(observedSeeds.sort((left, right) => left - right)).toEqual([
      101, 101, 102, 102, 103, 103,
    ])
  })

  it('keeps constant-score intervals numerically consistent with their measured delta', async () => {
    const frozen = experiment(10)
    const measurements = await runCandidateExperiment({
      experiment: frozen,
      async execute(input) {
        return executionEvidence({
          experiment: input.experiment,
          arm: input.arm,
          task: input.task,
          benchmarkCell: input.benchmarkCell,
          score: input.arm === 'baseline' ? 0.3 : 0.9,
        })
      },
    })
    const comparison = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements,
      runId: 'constant-score-interval',
    })

    expect(comparison.overall.confidenceInterval.lower).toBeLessThanOrEqual(
      comparison.overall.delta,
    )
    expect(comparison.overall.confidenceInterval.upper).toBeGreaterThanOrEqual(
      comparison.overall.delta,
    )
  })

  it('rejects missing cells, substituted arms, and changed signed task bytes', async () => {
    const frozen = experiment()
    const measurements = await runCandidateExperiment({
      experiment: frozen,
      async execute(input) {
        return executionEvidence({
          experiment: input.experiment,
          arm: input.arm,
          task: input.task,
          benchmarkCell: input.benchmarkCell,
          score: input.arm === 'baseline' ? 0.2 : 0.8,
        })
      },
    })
    expect(() =>
      measuredComparisonFromCandidateExperiment({
        experiment: frozen,
        measurements: measurements.slice(0, 2),
        runId: 'missing-cell',
      }),
    ).toThrow(/incomplete/)

    const baselineAsCandidate = measurements[0]!.baseline
    expect(() =>
      measuredComparisonFromCandidateExperiment({
        experiment: frozen,
        measurements: [
          { ...measurements[0]!, candidate: baselineAsCandidate },
          ...measurements.slice(1),
        ],
        runId: 'substituted-arm',
      }),
    ).toThrow(/substituted|bundle/)

    const changedTask = {
      ...frozen.benchmark.tasks[0],
      instruction: 'A different task with the old digest.',
    }
    expect(() =>
      verifyCandidateExperiment({
        ...frozen,
        benchmark: { ...frozen.benchmark, tasks: [changedTask] },
      }),
    ).toThrow(/digest/)
  })

  it('holds an experiment with fewer than three paired cells', async () => {
    const frozen = experiment(2)
    const measurements = await runCandidateExperiment({
      experiment: frozen,
      async execute(input) {
        return executionEvidence({
          experiment: input.experiment,
          arm: input.arm,
          task: input.task,
          benchmarkCell: input.benchmarkCell,
          score: input.arm === 'baseline' ? 0.2 : 0.9,
        })
      },
    })
    const comparison = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements,
      runId: 'underpowered',
    })
    expect(comparison.decision.outcome).toBe('need_more_work')
    expect(comparison.power.sufficient).toBe(false)
  })

  it('binds decision policy before execution and recomputes the published verdict', async () => {
    const frozen = experiment()
    const measurements = await runCandidateExperiment({
      experiment: frozen,
      async execute(input) {
        return executionEvidence({
          experiment: input.experiment,
          arm: input.arm,
          task: input.task,
          benchmarkCell: input.benchmarkCell,
          score: input.arm === 'baseline' ? 0.2 : 0.8,
        })
      },
    })
    const comparison = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements,
      runId: 'policy-binding',
    })

    const { digest: _digest, ...material } = frozen
    const alteredExperiment = addressed({
      ...material,
      policy: { ...frozen.policy, deltaThreshold: 0.9 },
    })
    expect(() =>
      measuredComparisonFromCandidateExperiment({
        experiment: alteredExperiment,
        measurements,
        runId: 'changed-policy',
      }),
    ).toThrow(/substituted/)

    expect(() =>
      verifyCandidateExperimentComparison({
        ...comparison,
        decision: {
          ...comparison.decision,
          outcome: 'hold',
          reasons: ['caller changed the verdict'],
        },
      }),
    ).toThrow(/does not match/)
  })

  it('binds the complete comparison record, not only its measurements', async () => {
    const frozen = experiment()
    const measurements = await runCandidateExperiment({
      experiment: frozen,
      async execute(input) {
        return executionEvidence({
          experiment: input.experiment,
          arm: input.arm,
          task: input.task,
          benchmarkCell: input.benchmarkCell,
          score: input.arm === 'baseline' ? 0.2 : 0.8,
        })
      },
    })
    const first = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements,
      runId: 'record-a',
      candidate: { label: 'first label' },
    })
    const second = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements,
      runId: 'record-b',
      candidate: { label: 'second label' },
    })

    expect(first.provenance.recordDigest).not.toBe(second.provenance.recordDigest)
    expect(() =>
      verifyCandidateExperimentComparison({
        ...first,
        metadata: { altered: true },
      }),
    ).toThrow(/does not match/)
  })

  it('holds when a required dimension is absent and preserves schema-level dimension checks', async () => {
    const initial = experiment()
    const { digest: _digest, ...material } = initial
    const frozen = sealCandidateExperiment({
      ...material,
      policy: { ...material.policy, criticalDimensions: ['safety'] },
    })
    const measurements = await runCandidateExperiment({
      experiment: frozen,
      async execute(input) {
        return executionEvidence({
          experiment: input.experiment,
          arm: input.arm,
          task: input.task,
          benchmarkCell: input.benchmarkCell,
          score: input.arm === 'baseline' ? 0.2 : 0.8,
        })
      },
    })
    const comparison = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements,
      runId: 'missing-critical-dimension',
    })
    expect(comparison.decision.outcome).toBe('hold')
    expect(comparison.decision.reasons).toContain('critical dimensions missing: safety')

    await expect(
      runCandidateExperiment({
        experiment: initial,
        async execute(input) {
          return executionEvidence({
            experiment: input.experiment,
            arm: input.arm,
            task: input.task,
            benchmarkCell: input.benchmarkCell,
            score: input.arm === 'baseline' ? 0.2 : 0.8,
            dimensions: [
              { name: 'reliability', score: 0.8 },
              { name: 'reliability', score: 0.8 },
            ],
          })
        },
      }),
    ).rejects.toThrow(/dimensions must be unique/)
  })

  it('does not ship incomplete or grader-failed candidate runs', async () => {
    for (const failure of ['timeout', 'grader'] as const) {
      const frozen = experiment()
      const measurements = await runCandidateExperiment({
        experiment: frozen,
        async execute(input) {
          return executionEvidence({
            experiment: input.experiment,
            arm: input.arm,
            task: input.task,
            benchmarkCell: input.benchmarkCell,
            score: input.arm === 'baseline' ? 0.2 : 0.8,
            ...(input.arm === 'candidate' && failure === 'timeout'
              ? { termination: { kind: 'timeout' as const, timeoutMs: 60_000 } }
              : {}),
            ...(input.arm === 'candidate' && failure === 'grader' ? { passed: false } : {}),
          })
        },
      })
      const comparison = measuredComparisonFromCandidateExperiment({
        experiment: frozen,
        measurements,
        runId: `candidate-${failure}`,
      })
      expect(comparison.decision.outcome).toBe('hold')
      expect(
        comparison.decision.contributingChecks.find((check) =>
          failure === 'timeout'
            ? check.name === 'all-runs-completed'
            : check.name === 'candidate-task-pass',
        )?.passed,
      ).toBe(false)
    }
  })

  it('rejects materialized profile bytes that do not come from the experiment arm', async () => {
    const frozen = experiment()
    await expect(
      runCandidateExperiment({
        experiment: frozen,
        async execute(input) {
          return executionEvidence({
            experiment: input.experiment,
            arm: input.arm,
            task: input.task,
            benchmarkCell: input.benchmarkCell,
            score: input.arm === 'baseline' ? 0.2 : 0.8,
            ...(input.arm === 'candidate' ? { sourceProfileDigest: sha('f') } : {}),
          })
        },
      }),
    ).rejects.toThrow(/substituted/)
  })

  it('accepts signed pre-model retries and rejects inconsistent native profile plans', async () => {
    const frozen = experiment()
    const task = frozen.benchmark.tasks[0]!
    const { digest: _taskDigest, ...taskMaterial } = task
    const retriedTask = sealCandidateBenchmarkTask({
      ...taskMaterial,
      attempt: { maxAttempts: 2, retryPolicy: 'pre-model-infrastructure-only' },
    })
    const { digest: _experimentDigest, ...experimentMaterial } = frozen
    const retriedExperiment = sealCandidateExperiment({
      ...experimentMaterial,
      benchmark: sealCandidateBenchmarkSuite({
        tasks: [retriedTask],
        reps: 3,
        seeds: [101, 102, 103],
      }),
    })
    expect(retriedExperiment.benchmark.tasks[0]?.attempt).toEqual({
      maxAttempts: 2,
      retryPolicy: 'pre-model-infrastructure-only',
    })

    const measurements = await runCandidateExperiment({
      experiment: frozen,
      async execute(input) {
        return executionEvidence({
          experiment: input.experiment,
          arm: input.arm,
          task: input.task,
          benchmarkCell: input.benchmarkCell,
          score: input.arm === 'baseline' ? 0.2 : 0.8,
          ...(input.arm === 'candidate' && input.benchmarkCell.repetition === 1
            ? { profileEnv: { DIFFERENT: { kind: 'public', value: '1' } } }
            : {}),
        })
      },
    })
    expect(() =>
      measuredComparisonFromCandidateExperiment({
        experiment: frozen,
        measurements,
        runId: 'inconsistent-profile-plan',
      }),
    ).toThrow(/materialized a different profile/)
  })
})
