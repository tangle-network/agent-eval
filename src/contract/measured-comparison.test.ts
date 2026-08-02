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
import { CostCeilingReachedError, CostLedger } from '../cost-ledger'
import {
  type CandidateExperimentExecutionInput,
  evaluatePairedMeasurements,
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

function bundle(prompt: string, includePublicSource = false): AgentCandidateBundle {
  const skillContent = 'Review every factual claim before answering.'
  const skillDigest = sha('d')
  return addressed({
    kind: 'agent-candidate-bundle' as const,
    digestAlgorithm: 'rfc8785-sha256' as const,
    profile: {
      name: 'support-agent',
      prompt: { systemPrompt: prompt },
      resources: includePublicSource
        ? {
            failOnError: true as const,
            skills: [
              {
                kind: 'inline' as const,
                name: 'claim-review',
                content: skillContent,
                sha256: skillDigest,
                byteLength: new TextEncoder().encode(skillContent).byteLength,
                source: {
                  kind: 'public-agent-resource',
                  sourceIdentity: 'github:example/research-agents/claim-review.md',
                  sourceDigest: skillDigest,
                  sourceRevision: '8d3b3f5',
                  license: {
                    kind: 'custom' as const,
                    name: 'Example Research Terms',
                    reference: 'LICENSE.md',
                    termsDigest: sha('e'),
                  },
                  attribution: ['Copyright Example Research contributors'],
                  notices: ['Adapted for the support-agent benchmark.'],
                  transformations: [
                    {
                      kind: 'transformation' as const,
                      identity: 'skill-section-extractor',
                      revision: 2,
                      procedureDigest: sha('b'),
                      inputDigest: sha('c'),
                      outputDigest: skillDigest,
                    },
                  ],
                },
              },
            ],
          }
        : { failOnError: true as const },
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

function experiment(reps = 3, candidateUsesPublicSource = false): AgentCandidateExperiment {
  const task = benchmarkTask()
  const seeds = Array.from({ length: reps }, (_, index) => 101 + index) as [number, ...number[]]
  return sealCandidateExperiment({
    kind: 'agent-candidate-experiment',
    digestAlgorithm: 'rfc8785-sha256',
    baseline: bundle('Answer the support request.'),
    candidate: bundle(
      'Answer the support request and verify every claim.',
      candidateUsesPublicSource,
    ),
    candidateLineage: { source: 'human' },
    benchmark: sealCandidateBenchmarkSuite({ tasks: [task], reps, seeds }),
    policy: {
      confidenceLevel: 0.95,
      resamples: 2_000,
      bootstrapSeed: 1_337,
      deltaThreshold: 0,
      minProductiveRuns: 3,
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
        costProvenance: 'observed' as const,
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
          costProvenance: 'observed' as const,
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
    steps: 1,
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

interface PlatformProfileRun {
  score: number
  dimensions: Array<{ name: string; score: number }>
  costUsd: number
  latencyMs: number
  completed: boolean
  passed: boolean
}

function profileMeasurements(): Array<{
  cellId: string
  baseline: PlatformProfileRun
  candidate: PlatformProfileRun
}> {
  return [0, 1, 2, 3, 4, 5].map((index) => {
    const baseline = 0.2 + (index % 3) * 0.05
    // The per-cell gain VARIES (0.52 / 0.50 / 0.48, mean exactly 0.50). A
    // constant gain makes every bootstrap resample identical, and a zero-width
    // interval carries no information about how far the estimate could be
    // wrong — the paired decision refuses it rather than reading it as
    // certainty, so a constant-gain fixture would prove nothing about the
    // decision path it is here to exercise.
    const candidate = baseline + 0.5 + (1 - (index % 3)) * 0.02
    const run = (score: number): PlatformProfileRun => ({
      score,
      dimensions: [{ name: 'reliability', score }],
      costUsd: 0.01,
      latencyMs: 100,
      completed: true,
      passed: true,
    })
    return {
      cellId: `platform-case:${index}`,
      baseline: run(baseline),
      candidate: run(candidate),
    }
  })
}

const profileRunAdapter = {
  score: (run: PlatformProfileRun) => run.score,
  dimensions: (run: PlatformProfileRun) => run.dimensions,
  costUsd: (run: PlatformProfileRun) => run.costUsd,
  costProvenance: () => 'observed' as const,
  latencyMs: (run: PlatformProfileRun) => run.latencyMs,
  completed: (run: PlatformProfileRun) => run.completed,
  passed: (run: PlatformProfileRun) => run.passed,
}

function comparisonAccounting(run: Awaited<ReturnType<typeof runCandidateExperiment>>) {
  return {
    preparation: {
      wallDurationMs: 0,
      cost: { usd: 0, provenance: 'observed' as const },
    },
    measurement: run.measurement,
  }
}

describe('candidate experiment comparison', () => {
  it('retains rich public-source evidence in the signed candidate identity', () => {
    const plain = experiment()
    const sourced = experiment(3, true)
    const skill = sourced.candidate.profile.resources?.skills?.[0]

    if (skill?.kind !== 'inline') throw new Error('fixture must include an inline skill')
    expect(skill.source).toMatchObject({
      license: { kind: 'custom', name: 'Example Research Terms' },
      attribution: ['Copyright Example Research contributors'],
      notices: ['Adapted for the support-agent benchmark.'],
      transformations: [{ kind: 'transformation', outputDigest: skill.sha256 }],
    })
    expect(sourced.candidate.digest).not.toBe(plain.candidate.digest)
    expect(sourced.digest).not.toBe(plain.digest)
  })

  it('evaluates ordinary profile receipts through the same paired decision path', () => {
    const policy = experiment().policy
    const measurements = profileMeasurements()

    const result = evaluatePairedMeasurements({
      measurements,
      policy,
      adapter: profileRunAdapter,
      sharedScorerChannel: true,
      preparationCost: { usd: 0.25, provenance: 'observed' },
    })

    expect(result.overall).toMatchObject({ baseline: 0.25, candidate: 0.75, delta: 0.5, n: 6 })
    expect(result.decision.outcome).toBe('ship')
    expect(result.measurementCost).toMatchObject({ provenance: 'observed' })
    expect(result.measurementCost.usd).toBeCloseTo(0.12, 12)
    expect(result.totalCost).toMatchObject({ provenance: 'observed' })
    expect(result.totalCost.usd).toBeCloseTo(0.37, 12)
    expect(result.measurementWorkDurationMs).toBe(1_200)
    expect(() =>
      evaluatePairedMeasurements({
        measurements: [measurements[0]!, measurements[0]!],
        policy,
        adapter: profileRunAdapter,
        sharedScorerChannel: true,
      }),
    ).toThrow(/cell ids must be unique/)
    expect(() =>
      evaluatePairedMeasurements({
        measurements,
        policy: { ...policy, resamples: 0 } as unknown as typeof policy,
        adapter: profileRunAdapter,
        sharedScorerChannel: true,
      }),
    ).toThrow(/resamples/)
    expect(() =>
      evaluatePairedMeasurements({
        measurements,
        policy,
        adapter: profileRunAdapter,
        sharedScorerChannel: true,
        measurementCost: { usd: 0.05, provenance: 'observed' },
      }),
    ).toThrow(/does not match its signed receipts/)
  })

  it('uses observed paired precision instead of baseline-only variance', () => {
    const template = profileMeasurements()[0]!.baseline
    const baselines = [0.1, 0.9, 0.1, 0.9, 0.1, 0.9]
    const measurements = baselines.map((baseline, index) => {
      const run = (score: number): PlatformProfileRun => ({
        ...template,
        score,
        dimensions: [{ name: 'reliability', score }],
      })
      return {
        cellId: `paired-precision:${index}`,
        baseline: run(baseline),
        candidate: run(baseline + 0.1),
      }
    })

    const result = evaluatePairedMeasurements({
      measurements,
      policy: {
        ...experiment().policy,
        deltaThreshold: 0.05,
        minProductiveRuns: 6,
      },
      adapter: profileRunAdapter,
      sharedScorerChannel: true,
    })

    expect(result.overall.confidenceInterval.lower).toBeCloseTo(0.1)
    expect(result.overall.confidenceInterval.upper).toBeCloseTo(0.1)
    expect(result.power.minimumDetectableDelta).toBeCloseTo(0.05)
    expect(result.power.sufficient).toBe(true)
    expect(result.decision.outcome).toBe('ship')
  })

  it.each([
    {
      label: 'an empty matrix',
      input: () => ({ measurements: [] as ReturnType<typeof profileMeasurements> }),
      error: /requires at least one paired cell/,
    },
    {
      label: 'negative preparation cost',
      input: () => ({ preparationCost: { usd: -0.01, provenance: 'observed' as const } }),
      error: /preparation cost must be a non-negative number/,
    },
    {
      label: 'a non-boolean scorer-channel declaration',
      input: () => ({ sharedScorerChannel: 'shared' as never }),
      error: /sharedScorerChannel must be a boolean/,
    },
    {
      label: 'a blank cell id',
      input: () => ({
        measurements: [
          { ...profileMeasurements()[0]!, cellId: '' },
          ...profileMeasurements().slice(1),
        ],
      }),
      error: /requires a cell id/,
    },
    {
      label: 'a non-finite score',
      input: () => ({ adapter: { ...profileRunAdapter, score: () => Number.NaN } }),
      error: /score must be finite/,
    },
    {
      label: 'non-array dimensions',
      input: () => ({
        adapter: { ...profileRunAdapter, dimensions: () => 'reliability' as never },
      }),
      error: /dimensions must be an array/,
    },
    {
      label: 'an unnamed dimension',
      input: () => ({
        adapter: { ...profileRunAdapter, dimensions: () => [{ name: '', score: 0.5 }] },
      }),
      error: /contains an unnamed dimension/,
    },
    {
      label: 'a repeated dimension',
      input: () => ({
        adapter: {
          ...profileRunAdapter,
          dimensions: () => [
            { name: 'reliability', score: 0.5 },
            { name: 'reliability', score: 0.5 },
          ],
        },
      }),
      error: /repeats dimension 'reliability'/,
    },
    {
      label: 'different arm dimensions',
      input: () => ({
        measurements: profileMeasurements().map((measurement, index) =>
          index === 0
            ? {
                ...measurement,
                candidate: {
                  ...measurement.candidate,
                  dimensions: [{ name: 'different', score: measurement.candidate.score }],
                },
              }
            : measurement,
        ),
      }),
      error: /dimensions do not match the suite/,
    },
    {
      label: 'negative run cost',
      input: () => ({ adapter: { ...profileRunAdapter, costUsd: () => -0.01 } }),
      error: /cost must be non-negative/,
    },
    {
      label: 'negative run latency',
      input: () => ({ adapter: { ...profileRunAdapter, latencyMs: () => -1 } }),
      error: /latency must be non-negative/,
    },
    {
      label: 'non-boolean completion',
      input: () => ({ adapter: { ...profileRunAdapter, completed: () => 'yes' as never } }),
      error: /completion and pass values must be booleans/,
    },
  ])('rejects $label from generic receipt adapters', ({ input, error }) => {
    const policy = experiment().policy
    expect(() =>
      evaluatePairedMeasurements({
        measurements: profileMeasurements(),
        policy,
        adapter: profileRunAdapter,
        sharedScorerChannel: false,
        ...input(),
      }),
    ).toThrow(error)
  })

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
    const frozen = experiment(6)
    const observedSeeds: number[] = []
    const run = await runCandidateExperiment({
      experiment: frozen,
      maxConcurrency: 3,
      async execute(input) {
        observedSeeds.push(input.seed)
        const baseline = [0.2, 0.25, 0.3][input.benchmarkCell.repetition % 3]!
        // Varying per-cell gain (0.52 / 0.50 / 0.48, mean 0.50) — see
        // `profileMeasurements` for why a constant gain proves nothing.
        const candidate = [0.72, 0.75, 0.78][input.benchmarkCell.repetition % 3]!
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
            costProvenance: 'observed' as const,
          },
          graderDurationMs: 5,
        })
      },
    })
    const comparison = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements: run.measurements,
      ...comparisonAccounting(run),
      runId: 'candidate-experiment-1',
      candidate: { label: 'verified-claims prompt' },
      generationsExplored: 2,
      preparation: {
        wallDurationMs: 50,
        cost: { usd: 0.25, provenance: 'observed' },
      },
    })

    expect(comparison.overall).toMatchObject({ baseline: 0.25, candidate: 0.75, delta: 0.5, n: 6 })
    expect(comparison.decision.outcome).toBe('ship')
    expect(comparison.diff).toContain('--- baseline/profile')
    expect(comparison.diff).toContain('verify every claim')
    expect(comparison.measurements).toHaveLength(6)
    expect(comparison.evaluation).toMatchObject({
      preparation: { wallDurationMs: 50, cost: { usd: 0.25, provenance: 'observed' } },
      measurement: { workDurationMs: 1_200, cost: { usd: 0.12, provenance: 'observed' } },
    })
    expect(comparison.evaluation.total.cost).toEqual({ usd: 0.37, provenance: 'observed' })
    expect(verifyCandidateExperimentComparison(comparison)).toEqual(comparison)
    expect(comparison.objectives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'cost', baseline: 0.01, candidate: 0.01 }),
        expect.objectContaining({ kind: 'latency', baseline: 105, candidate: 95 }),
      ]),
    )
    expect(observedSeeds.sort((left, right) => left - right)).toEqual([
      101, 101, 102, 102, 103, 103, 104, 104, 105, 105, 106, 106,
    ])
  })

  it('refuses a budgeted suite before dispatch when its signed maximum cannot fit', async () => {
    const initial = experiment()
    const { digest: _digest, ...material } = initial
    const budgeted = sealCandidateExperiment({
      ...material,
      policy: { ...material.policy, budgetUsd: 0.5 },
    })
    let calls = 0
    const execute = async (input: CandidateExperimentExecutionInput) => {
      calls += 1
      return executionEvidence({
        experiment: input.experiment,
        arm: input.arm,
        task: input.task,
        benchmarkCell: input.benchmarkCell,
        score: input.arm === 'baseline' ? 0.2 : 0.8,
      })
    }

    await expect(runCandidateExperiment({ experiment: budgeted, execute })).rejects.toThrow(
      /requires one shared CostLedger/,
    )
    expect(calls).toBe(0)

    const ledger = new CostLedger(0.5)
    await expect(
      runCandidateExperiment({ experiment: budgeted, costLedger: ledger, execute }),
    ).rejects.toThrow(CostCeilingReachedError)
    expect(calls).toBe(0)
    expect(ledger.summary()).toMatchObject({
      totalCalls: 0,
      pendingCalls: 0,
      totalCostUsd: 0,
    })
  })

  it('keeps constant-score intervals numerically consistent with their measured delta', async () => {
    const frozen = experiment(10)
    const run = await runCandidateExperiment({
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
      measurements: run.measurements,
      ...comparisonAccounting(run),
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
    const run = await runCandidateExperiment({
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
    const measurements = run.measurements
    expect(() =>
      measuredComparisonFromCandidateExperiment({
        experiment: frozen,
        measurements: measurements.slice(0, 2),
        ...comparisonAccounting(run),
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
        ...comparisonAccounting(run),
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
    const run = await runCandidateExperiment({
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
      measurements: run.measurements,
      ...comparisonAccounting(run),
      runId: 'underpowered',
    })
    expect(comparison.decision.outcome).toBe('need_more_work')
    expect(comparison.power.sufficient).toBe(false)
  })

  it('binds decision policy before execution and recomputes the published verdict', async () => {
    const frozen = experiment()
    const run = await runCandidateExperiment({
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
    const measurements = run.measurements
    const comparison = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements,
      ...comparisonAccounting(run),
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
        ...comparisonAccounting(run),
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
    const run = await runCandidateExperiment({
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
      measurements: run.measurements,
      ...comparisonAccounting(run),
      runId: 'record-a',
      candidate: { label: 'first label' },
    })
    const second = measuredComparisonFromCandidateExperiment({
      experiment: frozen,
      measurements: run.measurements,
      ...comparisonAccounting(run),
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
    const run = await runCandidateExperiment({
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
      measurements: run.measurements,
      ...comparisonAccounting(run),
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

  it('does not ship incomplete or regressed candidate runs', async () => {
    // The 'grader' arm's baseline used to score 0.2, which the fixture grades as
    // passed=false. A candidate that also fails that cell is a SHARED failure,
    // not a regression, and the gate no longer blocks on it — so this arm now
    // scores the baseline at 0.6 (passing) and has the grader reject the
    // candidate, which is the regression the check actually guards.
    for (const failure of ['timeout', 'grader'] as const) {
      const frozen = experiment()
      const run = await runCandidateExperiment({
        experiment: frozen,
        async execute(input) {
          return executionEvidence({
            experiment: input.experiment,
            arm: input.arm,
            task: input.task,
            benchmarkCell: input.benchmarkCell,
            score: input.arm === 'baseline' ? (failure === 'grader' ? 0.6 : 0.2) : 0.8,
            ...(input.arm === 'candidate' && failure === 'timeout'
              ? { termination: { kind: 'timeout' as const, timeoutMs: 60_000 } }
              : {}),
            ...(input.arm === 'candidate' && failure === 'grader' ? { passed: false } : {}),
          })
        },
      })
      const comparison = measuredComparisonFromCandidateExperiment({
        experiment: frozen,
        measurements: run.measurements,
        ...comparisonAccounting(run),
        runId: `candidate-${failure}`,
      })
      expect(comparison.decision.outcome).toBe('hold')
      expect(
        comparison.decision.contributingChecks.find((check) =>
          failure === 'timeout'
            ? check.name === 'all-runs-completed'
            : check.name === 'no-task-regression',
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

    const run = await runCandidateExperiment({
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
        measurements: run.measurements,
        ...comparisonAccounting(run),
        runId: 'inconsistent-profile-plan',
      }),
    ).toThrow(/materialized a different profile/)
  })
})

/**
 * The promotion gate's task check used to require PERFECTION: a candidate
 * shipped only if `candidate.passed` held on every benchmark cell. On any
 * benchmark hard enough to be worth running nothing passes everything, so the
 * bar was unreachable — under the old check the CONSTRUCTED case
 * `repairedNotRegressed(8)` below (baseline mean 0.3339, candidate mean 0.8685,
 * paired delta +0.5346) would be held with "candidate failed 2 benchmark
 * tasks", and the 2 are tasks the baseline failed too.
 *
 * That case is constructed, not observed: no live run of this gate is on disk.
 * An earlier draft of this docblock reported it as a measurement and quoted a
 * bootstrap interval that nothing produced; commit d095318 retracted the same
 * claim from the source comment, and it is retracted here for the same reason.
 * The argument for the change is the unreachable bar itself, visible in the
 * predicate, which needs no measured candidate.
 *
 * The bar is now improvement WITHOUT regression. Every test below pins BOTH
 * directions: the case the gate must now let through, and the neighbouring case
 * it must still refuse. Each "must still refuse" case is the calibration for the
 * check above it — the guard is only proven by being made to FAIL.
 */
describe('promotion gate — improvement without regression, not perfection', () => {
  interface GateRun {
    score: number
    dimensions: Array<{ name: string; score: number }>
    costUsd: number
    latencyMs: number
    completed: boolean
    passed: boolean
  }

  const gateAdapter = {
    score: (run: GateRun) => run.score,
    dimensions: (run: GateRun) => run.dimensions,
    costUsd: (run: GateRun) => run.costUsd,
    costProvenance: () => 'observed' as const,
    latencyMs: (run: GateRun) => run.latencyMs,
    completed: (run: GateRun) => run.completed,
    passed: (run: GateRun) => run.passed,
  }

  const gatePolicy = {
    confidenceLevel: 0.95,
    resamples: 2_000,
    bootstrapSeed: 1_337,
    deltaThreshold: 0,
    minProductiveRuns: 6,
    budgetUsd: 100,
    criticalDimensions: ['reliability'],
    regressionTolerance: 0.05,
  }

  const gateRun = (score: number, passed: boolean, overrides: Partial<GateRun> = {}): GateRun => ({
    score,
    dimensions: [{ name: 'reliability', score }],
    costUsd: 0.01,
    latencyMs: 100,
    completed: true,
    passed,
    ...overrides,
  })

  const evaluate = (
    measurements: Array<{ cellId: string; baseline: GateRun; candidate: GateRun }>,
    policy: Partial<typeof gatePolicy> = {},
  ) =>
    evaluatePairedMeasurements({
      measurements,
      policy: { ...gatePolicy, ...policy },
      adapter: gateAdapter,
      sharedScorerChannel: true,
    })

  const check = (result: ReturnType<typeof evaluate>, name: string) => {
    const found = result.decision.contributingChecks.find((entry) => entry.name === name)
    if (!found) throw new Error(`gate emitted no '${name}' check`)
    return found.passed
  }

  /** 10 cells the baseline fails; the candidate repairs `repaired` of them and
   *  leaves the rest failing exactly where the baseline already failed. */
  const repairedNotRegressed = (repaired: number) =>
    Array.from({ length: 10 }, (_, index) => ({
      cellId: `task:${index}`,
      baseline: gateRun(0.333 + (index % 3) * 0.001, false),
      candidate:
        index < repaired
          ? gateRun(0.98 + (index % 3) * 0.005, true)
          : gateRun(0.4 + (index % 2) * 0.01, false),
    }))

  it('SHIPS a candidate that repairs 8 tasks and still fails 2 the baseline also failed', () => {
    const result = evaluate(repairedNotRegressed(8))

    expect(result.overall.delta).toBeGreaterThan(0.5)
    expect(result.overall.confidenceInterval.lower).toBeGreaterThan(0)
    expect(check(result, 'no-task-regression')).toBe(true)
    expect(result.decision.outcome).toBe('ship')
    expect(result.decision.reasons).toEqual(['all measured checks passed'])
  })

  it('CALIBRATION — still HOLDS when the candidate breaks one task the baseline passed', () => {
    // Same 8 repairs and same 1 shared failure as the shipping case above. The
    // ONLY difference is cell 9, which the baseline passed and the candidate now
    // fails. That single cell must flip the verdict.
    const measurements = repairedNotRegressed(8).map((measurement, index) =>
      index === 9
        ? {
            ...measurement,
            baseline: gateRun(0.9, true),
            candidate: gateRun(0.2, false),
          }
        : measurement,
    )

    const result = evaluate(measurements)

    // The composite lift is still large and still significant — the hold is the
    // regression check doing its job, not the statistics.
    expect(result.overall.delta).toBeGreaterThan(0.3)
    expect(check(result, 'paired-significance')).toBe(true)
    expect(check(result, 'critical-dimensions')).toBe(true)
    expect(check(result, 'no-task-regression')).toBe(false)
    expect(result.decision.outcome).toBe('hold')
    expect(result.decision.reasons).toContain(
      'candidate regressed 1 benchmark task the baseline passed: task:9',
    )
  })

  it('reports repaired / regressed / still-failing on a hold, so a null is separable from a gate artifact', () => {
    const measurements = repairedNotRegressed(8).map((measurement, index) =>
      index === 9
        ? { ...measurement, baseline: gateRun(0.9, true), candidate: gateRun(0.2, false) }
        : measurement,
    )

    const result = evaluate(measurements)

    expect(result.decision.reasons).toContain(
      'benchmark tasks: 8 repaired, 1 regressed, 1 still failing that the baseline also failed',
    )
  })

  it('CALIBRATION — the accounting line never appears on a ship, so it cannot read as a blocker', () => {
    const result = evaluate(repairedNotRegressed(8))

    expect(result.decision.outcome).toBe('ship')
    expect(result.decision.reasons.some((reason) => reason.startsWith('benchmark tasks:'))).toBe(
      false,
    )
  })

  it('CALIBRATION — still HOLDS a candidate whose lift is not distinguishable from zero', () => {
    // Every task passes on both arms, so `no-task-regression` passes. The gate
    // must still refuse: dropping the perfection bar must not turn the gate into
    // a rubber stamp for a candidate that did not actually improve anything.
    const measurements = Array.from({ length: 10 }, (_, index) => ({
      cellId: `flat:${index}`,
      baseline: gateRun(0.5 + (index % 5) * 0.02, true),
      candidate: gateRun(0.5 + ((index + 2) % 5) * 0.02, true),
    }))

    const result = evaluate(measurements)

    expect(check(result, 'no-task-regression')).toBe(true)
    expect(check(result, 'paired-significance')).toBe(false)
    expect(result.decision.outcome).not.toBe('ship')
  })

  it('CALIBRATION — still HOLDS when a benchmark execution did not complete', () => {
    const measurements = repairedNotRegressed(8).map((measurement, index) =>
      index === 0
        ? { ...measurement, candidate: gateRun(0.98, true, { completed: false }) }
        : measurement,
    )

    const result = evaluate(measurements)

    expect(check(result, 'no-task-regression')).toBe(true)
    expect(check(result, 'all-runs-completed')).toBe(false)
    expect(result.decision.outcome).toBe('hold')
  })

  it('CALIBRATION — still HOLDS a candidate that went over budget', () => {
    const result = evaluate(repairedNotRegressed(8), { budgetUsd: 0.05 })

    expect(check(result, 'no-task-regression')).toBe(true)
    expect(check(result, 'budget')).toBe(false)
    expect(result.decision.outcome).toBe('hold')
  })

  it('CALIBRATION — still HOLDS a candidate that stopped reporting a critical dimension', () => {
    // Both arms have to agree on the dimension set (a one-sided drop is rejected
    // upstream as asymmetric evidence), so the suite reports `speed` only and
    // the critical `reliability` dimension is gone from the run entirely.
    const measurements = repairedNotRegressed(8).map((measurement) => ({
      ...measurement,
      baseline: { ...measurement.baseline, dimensions: [{ name: 'speed', score: 0.5 }] },
      candidate: { ...measurement.candidate, dimensions: [{ name: 'speed', score: 0.9 }] },
    }))

    const result = evaluate(measurements)

    expect(check(result, 'no-task-regression')).toBe(true)
    expect(check(result, 'critical-dimensions')).toBe(false)
    expect(result.decision.reasons).toContain('critical dimensions missing: reliability')
    expect(result.decision.outcome).toBe('hold')
  })

  it('CALIBRATION — still HOLDS a candidate that lifted the score while regressing a critical dimension', () => {
    const measurements = Array.from({ length: 10 }, (_, index) => ({
      cellId: `goodhart:${index}`,
      baseline: {
        ...gateRun(0.3 + (index % 3) * 0.01, true),
        dimensions: [{ name: 'reliability', score: 0.9 - (index % 3) * 0.01 }],
      },
      candidate: {
        ...gateRun(0.8 + (index % 3) * 0.02, true),
        dimensions: [{ name: 'reliability', score: 0.6 - (index % 3) * 0.03 }],
      },
    }))

    const result = evaluate(measurements)

    expect(check(result, 'paired-significance')).toBe(true)
    expect(check(result, 'no-task-regression')).toBe(true)
    expect(check(result, 'critical-dimensions')).toBe(false)
    expect(result.decision.reasons).toContain('critical dimensions regressed: reliability')
    expect(result.decision.outcome).toBe('hold')
  })
})

/**
 * The paired significance reason used to print `significance.bootstrap.low` — a
 * DIAGNOSTIC bootstrap that on several paths never enters the decision. Observed
 * live: `paired interval lower bound 0.6666666666666669 did not clear 0`, which
 * is self-contradicting, because 0.667 does clear 0.
 *
 * The refusal itself is correct and is NOT relaxed here. Under the bounded
 * asymmetric null the estimator documents (2 % of pairs drop by 1.0, the rest
 * gain 0.0204, true mean paired delta exactly 0), a constant-positive sample is
 * exactly a sample in which no pair drew the drop, so its frequency is
 * closed-form 0.98^n — 88.6 % at n = 6. Promoting on a zero-variance sample
 * would therefore false-promote a true-zero candidate most of the time. What is fixed is that the gate now says which
 * interval decided and why, and routes a degenerate sample to `need_more_work`
 * (fix the held-out set) instead of `hold` (fix the candidate).
 */
describe('promotion gate — the significance reason names the interval that decided', () => {
  interface GateRun {
    score: number
    dimensions: Array<{ name: string; score: number }>
    costUsd: number
    latencyMs: number
    completed: boolean
    passed: boolean
  }

  const gateAdapter = {
    score: (run: GateRun) => run.score,
    dimensions: (run: GateRun) => run.dimensions,
    costUsd: (run: GateRun) => run.costUsd,
    costProvenance: () => 'observed' as const,
    latencyMs: (run: GateRun) => run.latencyMs,
    completed: (run: GateRun) => run.completed,
    passed: (run: GateRun) => run.passed,
  }

  const gatePolicy = {
    confidenceLevel: 0.95,
    resamples: 2_000,
    bootstrapSeed: 1_337,
    deltaThreshold: 0,
    minProductiveRuns: 6,
    budgetUsd: 100,
    criticalDimensions: ['reliability'],
    regressionTolerance: 0.05,
  }

  const gateRun = (score: number): GateRun => ({
    score,
    dimensions: [{ name: 'reliability', score }],
    costUsd: 0.01,
    latencyMs: 100,
    completed: true,
    passed: true,
  })

  const evaluate = (scores: Array<{ baseline: number; candidate: number }>) =>
    evaluatePairedMeasurements({
      measurements: scores.map((pair, index) => ({
        cellId: `cell:${index}`,
        baseline: gateRun(pair.baseline),
        candidate: gateRun(pair.candidate),
      })),
      policy: gatePolicy,
      adapter: gateAdapter,
      sharedScorerChannel: true,
    })

  it('explains a zero-variance sample instead of claiming its own bound failed to clear', () => {
    // Six cells that all move +2/3. The old reason read "lower bound
    // 0.6666666666666669 did not clear 0".
    const result = evaluate(
      Array.from({ length: 6 }, () => ({ baseline: 0.333, candidate: 0.333 + 2 / 3 })),
    )
    const reason = result.decision.reasons[0]!

    expect(reason).toMatch(/interval is degenerate at \[0\.6666666666666669, 0\.6666666666666669\]/)
    expect(reason).toMatch(/the mean CI collapsed to a point/)
    expect(reason).not.toMatch(/did not clear/)
    // The remedy is the held-out set, not a better candidate.
    expect(result.decision.outcome).toBe('need_more_work')
  })

  it('CALIBRATION — the zero-variance sample is still REFUSED, however large the constant gain', () => {
    // Same fixture. A constant +2/3 is a huge point estimate and the gate must
    // still not ship it: the sample carries no information about its own error,
    // and it is exactly the shape a true-zero candidate produces when the
    // held-out set is too small to have sampled the tail.
    const result = evaluate(
      Array.from({ length: 6 }, () => ({ baseline: 0.333, candidate: 0.333 + 2 / 3 })),
    )

    expect(result.overall.delta).toBeCloseTo(2 / 3, 12)
    expect(
      result.decision.contributingChecks.find((entry) => entry.name === 'paired-significance')
        ?.passed,
    ).toBe(false)
    expect(result.decision.outcome).not.toBe('ship')
  })

  it('CALIBRATION — a non-degenerate miss still reports a lower bound, and it is the DECIDING one', () => {
    // Varied deltas straddling zero: the interval is real, has width, and fails
    // honestly. This is the branch that must keep saying "did not clear".
    const result = evaluate([
      { baseline: 0.5, candidate: 0.56 },
      { baseline: 0.5, candidate: 0.42 },
      { baseline: 0.5, candidate: 0.58 },
      { baseline: 0.5, candidate: 0.41 },
      { baseline: 0.5, candidate: 0.57 },
      { baseline: 0.5, candidate: 0.44 },
      { baseline: 0.5, candidate: 0.55 },
      { baseline: 0.5, candidate: 0.43 },
    ])
    const reason = result.decision.reasons[0]!

    expect(reason).toMatch(/^paired mean_bootstrap interval lower bound -?\d/)
    expect(reason).toMatch(/did not clear 0/)
    expect(reason).not.toMatch(/degenerate/)
    expect(result.decision.outcome).toBe('hold')
  })

  it('CALIBRATION — a pass/fail outcome reports McNemar, not a bootstrap the decision never read', () => {
    // A two-point outcome routes to the score interval, so the diagnostic mean
    // bootstrap never enters the decision. The old string printed it anyway.
    const result = evaluate([
      { baseline: 0, candidate: 1 },
      { baseline: 0, candidate: 1 },
      { baseline: 0, candidate: 0 },
      { baseline: 1, candidate: 1 },
      { baseline: 1, candidate: 1 },
      { baseline: 1, candidate: 1 },
      { baseline: 0, candidate: 0 },
      { baseline: 1, candidate: 1 },
    ])
    const reason = result.decision.reasons[0]!

    expect(reason).toMatch(/^McNemar's exact test refuses at threshold 0: b=2, c=0/)
    expect(result.decision.outcome).toBe('hold')
  })
})
