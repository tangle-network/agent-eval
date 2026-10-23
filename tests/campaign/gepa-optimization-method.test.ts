import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testModelExecutionOwner } from '../../src/analyst/model-execution.test-support'
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  type JudgeConfig,
  type MutableSurface,
  type OpenAICompatibleOptimizerModel,
  type Scenario,
} from '../../src/campaign'

interface TestScenario extends Scenario {
  kind: string
  prompt: string
  privateNote: string
}

interface TestArtifact {
  text: string
}

let runDir: string
const openServers: Server[] = []

const GEPA_MODEL_BUDGET = {
  maxCostUsd: 0.1,
  maxRequests: 2,
  maxRequestBytes: 100_000,
  maxResponseBytes: 100_000,
  maxOutputTokensPerRequest: 100,
  pricing: {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  },
}

const GEPA_RUNTIME_IDENTITY = {
  python: {
    implementation: 'CPython',
    version: '3.12.0',
  },
  bridge: {
    package: 'agent-eval-rpc',
    version: 'test-bridge',
    sourceUrl: 'https://github.com/tangle-network/agent-eval',
    revision: 'test-bridge-revision',
    sourceSha256: 'a'.repeat(64),
  },
  optimizer: {
    package: 'gepa',
    version: 'test',
    sourceUrl: 'https://github.com/gepa-ai/gepa',
    revision: 'test-revision',
    sourceSha256: 'b'.repeat(64),
  },
  engineModules: [],
} as const

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'gepa-method-'))
})

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections?.()
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
  rmSync(runDir, { recursive: true, force: true })
})

describe('gepaOptimizationMethod', () => {
  it('allows evaluation-bounded engines when billed proposer USD is unknown', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: { engine: 'best_of_n', maxEvaluations: 1 },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
      }),
    ).not.toThrow()
  })

  it('requires explicit trust before enabling pickle-backed GEPA resume', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        resume: 'if-compatible',
      }),
    ).toThrow('resumable GEPA pickle state requires trustResumeState: true')
  })

  it('rejects a duplicate seed in GEPA engine settings', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
            engineConfig: { engine: { seed: 7 } },
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
      }),
    ).toThrow('engineConfig.engine.seed conflicts with the comparison seed')
  })

  it('rejects credentials in persisted GEPA settings', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
            engineConfig: {
              reflection: { reflection_lm_kwargs: { api_key: 'secret' } },
            },
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
      }),
    ).toThrow('must be supplied through runner.env')
  })

  it('requires a standard GEPA engine for exact optimizer receipts', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'best_of_n',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: optimizerModel(),
      }),
    ).toThrow("optimizer requires GEPA's 'gepa' engine")
  })

  it('rejects duplicate transport settings on proxied GEPA reflection', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
            engineConfig: {
              reflection: { reflection_lm_kwargs: { base_url: 'https://other.example/v1' } },
            },
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: optimizerModel(),
      }),
    ).toThrow('proxied reflection transport settings belong in optimizer')
  })

  it('allows official reflection retry and timeout settings', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
            engineConfig: {
              reflection: {
                reflection_lm_kwargs: {
                  num_retries: 3,
                  timeout: 20,
                  drop_params: true,
                },
              },
            },
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: optimizerModel(),
      }),
    ).not.toThrow()
  })

  it('validates official GEPA engine registration modules', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'custom',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        engineModules: ['my_engines.register', 'my_engines.register'],
      }),
    ).toThrow('engineModules must not contain duplicates')
  })

  it('rejects an unknown optimizer servedModelPolicy value', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: { ...optimizerModel(), servedModelPolicy: 'within-family' as never },
      }),
    ).toThrow("servedModelPolicy must be 'exact' or 'allow-within-family'")
  })

  it('accepts both declared servedModelPolicy values', () => {
    for (const servedModelPolicy of ['exact', 'allow-within-family'] as const) {
      expect(() =>
        gepaOptimizationMethod({
          recipe: {
            kind: 'engine',
            run: {
              engine: 'gepa',
              maxEvaluations: 1,
              maxProposerCostUsd: 1,
            },
          },
          objective: 'Return a better policy.',
          evaluationId: 'test',
          optimizer: { ...optimizerModel(), servedModelPolicy },
        }),
      ).not.toThrow()
    }
  })

  it('does not let custom modules replace the metered built-in GEPA engine', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 1,
            maxProposerCostUsd: 1,
          },
        },
        objective: 'Return a better policy.',
        evaluationId: 'test',
        optimizer: optimizerModel(),
        engineModules: ['my_engines.register'],
      }),
    ).toThrow('optimizer cannot be combined with engineModules')
  })

  it('meters standard GEPA reflection through the local model proxy', async () => {
    const upstreamBaseUrl = await startModelServer()
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'gepa',
          maxEvaluations: 1,
          maxProposerCostUsd: 0.1,
        },
      },
      objective: 'Return the better policy.',
      evaluationId: 'test',
      optimizer: optimizerModel(upstreamBaseUrl),
      runner: fakeMeteredGepaRunner(upstreamBaseUrl),
    })

    const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [method],
      baselineSurface: 'baseline',
      trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'visible train', privateNote: '' }],
      selectionScenarios: [
        { id: 'selection', kind: 'qa', prompt: 'visible selection', privateNote: '' },
      ],
      testScenarios: [
        { id: 'final', kind: 'qa', prompt: 'final', privateNote: '' },
        { id: 'final-2', kind: 'qa', prompt: 'final 2', privateNote: '' },
      ],
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [betterJudge],
      runDir,
      seed: 11,
      resamples: 40,
      expectUsage: 'off',
    })

    expect(result.scores[0]!.optimizationCost).toEqual({
      totalCostUsd: 0.00002,
      costProvenance: { kind: 'estimated', usd: 0.00002 },
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(result.scores[0]!.provenance).toMatchObject({
      optimizerModel: 'model',
      seedApplied: true,
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        calls: 1,
      },
      observations: {
        scope: 'callback-submitted-candidates',
        sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        submittedCandidates: 1,
        evaluations: 1,
        refusals: 0,
      },
      gepaCandidatePopulation: {
        scope: 'gepa-candidate-population',
        sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        candidates: 1,
        bestIndex: 0,
      },
      modelExecutions: {
        scope: 'runtime-model-calls',
        sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        calls: 1,
        succeeded: 1,
        failed: 0,
      },
    })
    const provenance = result.scores[0]!.provenance!
    expect(readFileSync(provenance.observations!.path, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(readFileSync(provenance.modelExecutions!.path, 'utf8').trim().split('\n')).toHaveLength(
      1,
    )
  })

  it('continues external GEPA after a failed cell without measuring the penalty as zero', async () => {
    const observedInputPath = join(runDir, 'failed-cell-input.json')
    let failedDispatches = 0
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'best_of_n',
          maxEvaluations: 2,
          maxProposerCostUsd: 1,
        },
      },
      objective: 'Return the better policy.',
      evaluationId: 'failed-cell',
      runner: fakeGepaRunnerWithFailedEvaluation(observedInputPath),
    })

    const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [method],
      baselineSurface: 'baseline',
      trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'train', privateNote: '' }],
      selectionScenarios: [{ id: 'selection', kind: 'qa', prompt: 'selection', privateNote: '' }],
      testScenarios: [
        { id: 'final', kind: 'qa', prompt: 'final', privateNote: '' },
        { id: 'final-2', kind: 'qa', prompt: 'final 2', privateNote: '' },
      ],
      dispatchWithSurface: async (surface, scenario) => {
        if (scenario.id === 'train' && surface === 'failed') {
          failedDispatches += 1
          throw new Error('provider 500')
        }
        return { text: String(surface) }
      },
      judges: [betterJudge],
      optimizationRunOptions: { abortOnCellError: false, expectUsage: 'off' },
      runDir,
      seed: 11,
      resamples: 40,
    })

    expect(failedDispatches).toBe(1)
    expect(result.scores[0]).toMatchObject({
      winnerSurface: 'better',
      winnerComposite: 1,
      provenance: {
        evaluationCount: 2,
        upstreamReportedEvaluations: 2,
        observations: {
          evaluations: 2,
          refusals: 0,
        },
        gepaCandidatePopulation: {
          candidates: 2,
          bestIndex: 1,
        },
      },
    })

    const observationsPath = result.scores[0]!.provenance!.observations!.path
    const observations = readFileSync(observationsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as Array<{
      kind: string
      response?: { score?: number; info?: { status?: string } }
    }>
    expect(
      observations
        .filter((observation) => observation.kind === 'evaluation')
        .map((observation) => ({
          score: observation.response?.score,
          status: observation.response?.info?.status,
        })),
    ).toEqual([
      { score: 0, status: 'failed' },
      { score: 1, status: 'scored' },
    ])

    const failurePath = findFile(runDir, 'failure-receipt.json')
    expect(failurePath).not.toBeUndefined()
    expect(JSON.parse(readFileSync(failurePath!, 'utf8'))).toMatchObject({
      failure: { stage: 'dispatch', error: { message: 'provider 500' } },
      cell: {
        errorStage: 'dispatch',
        error: 'provider 500',
        judgeScores: {},
      },
    })
    expect(findFile(dirname(failurePath!), 'cached-result.json')).toBeUndefined()

    const populationPath = result.scores[0]!.provenance!.gepaCandidatePopulation!.path
    const population = JSON.parse(readFileSync(populationPath, 'utf8')) as {
      candidates: Array<{ aggregateScore: number | null; selectionScores: unknown[] }>
    }
    expect(population.candidates[0]).toMatchObject({
      aggregateScore: null,
      selectionScores: [],
    })
    expect(population.candidates[1]).toMatchObject({
      aggregateScore: 1,
      selectionScores: [{ scenarioId: 'selection', score: 1 }],
    })
  })

  it('keeps evaluation and optimizer-model budgets cumulative across resumes', async () => {
    const upstreamBaseUrl = await startModelServer()
    const resumeMarker = join(runDir, 'fake-gepa-resume')
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'gepa',
          maxEvaluations: 2,
          maxProposerCostUsd: 0.1,
        },
      },
      objective: 'Return the better policy.',
      evaluationId: 'resume-budget',
      optimizer: optimizerModel(upstreamBaseUrl),
      resume: 'if-compatible',
      trustResumeState: true,
      runner: fakeMeteredGepaRunner(upstreamBaseUrl, resumeMarker),
    })

    const first = await compareOptimizationMethods(gepaComparisonOptions(method, 'execution-a'))
    const second = await compareOptimizationMethods(gepaComparisonOptions(method, 'execution-a'))

    expect(first.scores[0]!.provenance).toMatchObject({
      resumed: false,
      evaluationCount: 1,
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: 1 },
    })
    expect(second.scores[0]!.optimizationCost).toEqual({
      totalCostUsd: 0.00004,
      costProvenance: { kind: 'estimated', usd: 0.00004 },
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(second.scores[0]!.provenance).toMatchObject({
      resumed: true,
      evaluationCount: 2,
      tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, calls: 2 },
    })
    const resumedObservations = readFileSync(
      second.scores[0]!.provenance!.observations!.path,
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as {
      kind: string
      evaluationNumber?: number
    }[]
    expect(
      resumedObservations
        .filter((observation) => observation.kind === 'evaluation')
        .map((observation) => observation.evaluationNumber),
    ).toEqual([1])
    expect(first.scores[0]!.provenance?.runId).toBe(first.scores[0]!.provenance?.compatibleRunId)
    expect(second.scores[0]!.provenance?.runId).toBe(first.scores[0]!.provenance?.compatibleRunId)
    const changedExecution = await compareOptimizationMethods(
      gepaComparisonOptions(method, 'execution-b'),
    )
    expect(changedExecution.scores[0]!.provenance).toMatchObject({
      resumed: false,
      evaluationCount: 1,
    })
    expect(changedExecution.scores[0]!.provenance?.compatibleRunId).not.toBe(
      first.scores[0]!.provenance?.compatibleRunId,
    )
    await expect(
      compareOptimizationMethods(gepaComparisonOptions(method, 'execution-a')),
    ).rejects.toThrow('model failed: 429')
  })

  it('rejects an invalid upstream-reported evaluation count', async () => {
    const observedInputPath = join(runDir, 'invalid-upstream-count-input.json')
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'best_of_n',
          maxEvaluations: 1,
          maxProposerCostUsd: 1,
        },
      },
      objective: 'Return the better policy.',
      evaluationId: 'invalid-upstream-count',
      runner: fakeGepaRunner(observedInputPath, 'better', { upstreamReportedEvaluations: -1 }),
    })

    await expect(compareOptimizationMethods(gepaComparisonOptions(method))).rejects.toThrow(
      'invalid upstreamReportedEvaluations',
    )
  })

  it('exposes only described train and selection cases to the external process', async () => {
    const observedInputPath = join(runDir, 'external-input.json')
    const runner = fakeGepaRunner(observedInputPath)
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'best_of_n',
          maxEvaluations: 1,
          maxProposerCostUsd: 1,
        },
      },
      objective: 'Return the better policy.',
      evaluationId: 'test',
      timeoutMs: 2_700_000,
      describeScenario: (scenario) => ({ prompt: scenario.prompt }),
      runner,
    })

    const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [method],
      baselineSurface: 'baseline',
      trainScenarios: [
        { id: 'train', kind: 'qa', prompt: 'visible train prompt', privateNote: 'TRAIN_SECRET' },
      ],
      selectionScenarios: [
        {
          id: 'selection',
          kind: 'qa',
          prompt: 'visible selection prompt',
          privateNote: 'SELECTION_SECRET',
        },
      ],
      testScenarios: [
        { id: 'final', kind: 'qa', prompt: 'private final prompt', privateNote: 'FINAL_SECRET' },
        { id: 'final-2', kind: 'qa', prompt: 'second final prompt', privateNote: 'FINAL_SECRET_2' },
      ],
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [betterJudge],
      runDir,
      seed: 11,
      resamples: 40,
      expectUsage: 'off',
    })

    const observed = JSON.parse(readFileSync(observedInputPath, 'utf8')) as Record<string, unknown>
    expect(observed).toMatchObject({
      resume: 'never',
      evaluationId: 'test',
      seed: 11,
      timeoutMs: 2_700_000,
      engineModules: [],
      recipe: {
        kind: 'engine',
        run: {
          engine: 'best_of_n',
          maxEvaluations: 1,
          maxProposerCostUsd: 1,
        },
      },
      trainSet: [{ id: 'train', data: { prompt: 'visible train prompt' } }],
      selectionSet: [{ id: 'selection', data: { prompt: 'visible selection prompt' } }],
    })
    expect(JSON.stringify(observed)).not.toContain('SECRET')
    expect(observed).not.toHaveProperty('testSet')
    expect(observed).not.toHaveProperty('test_set')
    expect(basename(String(observed.cwd))).toMatch(/^agent-eval-gepa-/)
    expect(String(observed.cwd)).not.toContain(runDir)

    expect(result.scores[0]!.winnerSurface).toBe('better')
    expect(result.scores[0]!.baselineComposite).toBe(0)
    expect(result.scores[0]!.winnerComposite).toBe(1)
    expect(result.scores[0]!.optimizationCost.accountingComplete).toBe(false)
    expect(result.scores[0]!.optimizationCost.incompleteReasons).toContain(
      'GEPA proposer cost is unavailable',
    )
    expect(result.scores[0]!.provenance).toMatchObject({
      source: {
        kind: 'package',
        evidence: 'observed',
        package: 'gepa',
        version: 'test',
        sourceUrl: 'https://github.com/gepa-ai/gepa',
        revision: 'test-revision',
        sourceSha256: 'b'.repeat(64),
      },
      bridge: {
        kind: 'package',
        evidence: 'observed',
        package: 'agent-eval-rpc',
        version: 'test-bridge',
        sourceUrl: 'https://github.com/tangle-network/agent-eval',
        revision: 'test-bridge-revision',
        sourceSha256: 'a'.repeat(64),
      },
      modules: [],
      python: {
        implementation: 'CPython',
        version: '3.12.0',
      },
      compatibleRunId: expect.stringMatching(/^[0-9a-f]{64}$/),
      runId: expect.stringMatching(/^[0-9a-f]{64}-[0-9a-f]{32}$/),
      resumed: false,
      seedApplied: false,
      evaluationCount: 1,
    })
    expect(result.scores[0]!.provenance?.runId).toMatch(
      new RegExp(`^${result.scores[0]!.provenance?.compatibleRunId}-[0-9a-f]{32}$`),
    )
    expect(result.scores[0]!.provenance).not.toHaveProperty('optimizerModel')
    expect(result.scores[0]!.provenance?.artifactDir).toContain('/gepa/external')
  })

  it('round-trips component surfaces through the official GEPA engine', async () => {
    const observedInputPath = join(runDir, 'component-input.json')
    const winner = { system: 'better system', tools: 'better tools' }
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'gepa',
          maxEvaluations: 1,
          maxProposerCostUsd: 1,
        },
      },
      objective: 'Improve both components.',
      evaluationId: 'test',
      runner: fakeGepaRunner(observedInputPath, winner),
    })

    const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [method],
      baselineSurface: {
        kind: 'components',
        components: { system: 'baseline system', tools: 'baseline tools' },
      },
      trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'train', privateNote: '' }],
      selectionScenarios: [{ id: 'selection', kind: 'qa', prompt: 'selection', privateNote: '' }],
      testScenarios: [
        { id: 'final', kind: 'qa', prompt: 'final', privateNote: '' },
        { id: 'final-2', kind: 'qa', prompt: 'final 2', privateNote: '' },
      ],
      dispatchWithSurface: async (surface) => ({ text: JSON.stringify(surface) }),
      judges: [
        {
          name: 'components',
          dimensions: [{ key: 'better', description: 'both components improved' }],
          score: ({ artifact }) => {
            const score = artifact.text.includes('better system') ? 1 : 0
            return { dimensions: { better: score }, composite: score }
          },
        },
      ],
      runDir,
      seed: 11,
      resamples: 40,
      expectUsage: 'off',
    })

    expect(result.scores[0]!.winnerSurface).toEqual({
      kind: 'components',
      components: winner,
    })
    const observed = JSON.parse(readFileSync(observedInputPath, 'utf8')) as Record<string, unknown>
    expect(observed.seedCandidate).toEqual({
      system: 'baseline system',
      tools: 'baseline tools',
    })
  })

  it('rejects component surfaces before starting a single-text engine', async () => {
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'best_of_n',
          maxEvaluations: 1,
          maxProposerCostUsd: 1,
        },
      },
      objective: 'Improve both components.',
      evaluationId: 'test',
    })

    await expect(
      compareOptimizationMethods<TestScenario, TestArtifact>({
        methods: [method],
        baselineSurface: {
          kind: 'components',
          components: { system: 'baseline', tools: 'baseline' },
        },
        trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'train', privateNote: '' }],
        selectionScenarios: [{ id: 'selection', kind: 'qa', prompt: 'selection', privateNote: '' }],
        testScenarios: [
          { id: 'final', kind: 'qa', prompt: 'final', privateNote: '' },
          { id: 'final-2', kind: 'qa', prompt: 'final 2', privateNote: '' },
        ],
        dispatchWithSurface: async (surface) => ({ text: JSON.stringify(surface) }),
        judges: [betterJudge],
        runDir,
        seed: 11,
        resamples: 40,
        expectUsage: 'off',
      }),
    ).rejects.toThrow("component surfaces require GEPA's 'gepa' engine")
  })
})

const betterJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'better',
  dimensions: [{ key: 'better', description: 'candidate is the known better surface' }],
  score: ({ artifact }) => {
    const score = artifact.text === 'better' ? 1 : 0
    return { dimensions: { better: score }, composite: score, notes: '' }
  },
}

function fakeGepaRunner(
  observedInputPath: string,
  candidate: string | Record<string, string> = 'better',
  outputExtras: Record<string, unknown> = {},
) {
  const serializedCandidate = JSON.stringify(candidate)
  const serializedExtras = JSON.stringify(outputExtras)
  const source = [
    "const fs = require('node:fs')",
    "const crypto = require('node:crypto')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(GEPA_RUNTIME_IDENTITY)}`,
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    `fs.writeFileSync(${JSON.stringify(observedInputPath)}, JSON.stringify({ ...input, cwd: process.cwd() }))`,
    ';(async () => {',
    '  const response = await fetch(input.callbackUrl, {',
    '    method: "POST",',
    '    headers: { authorization: "Bearer " + input.callbackToken, "content-type": "application/json" },',
    `    body: JSON.stringify({ candidate: ${serializedCandidate}, exampleId: input.trainSet[0].id }),`,
    '  })',
    '  if (!response.ok) throw new Error("callback failed: " + response.status)',
    '  const scored = await response.json()',
    '  fs.mkdirSync(input.outputDir, { recursive: true })',
    '  const populationPath = input.outputDir + "/candidate-population-test.json"',
    `  const populationContents = JSON.stringify({ schemaVersion: 1, scope: "gepa-candidate-population", runId: input.runId, bestIndex: 0, candidates: [{ index: 0, candidate: ${serializedCandidate}, parentIndices: [null], aggregateScore: scored.score, selectionScores: [{ scenarioId: (input.selectionSet[0] || input.trainSet[0]).id, score: scored.score }], discoveryEvaluationCount: 1 }] }, null, 2) + "\\n"`,
    '  fs.writeFileSync(populationPath, populationContents)',
    '  const candidatePopulation = { scope: "gepa-candidate-population", path: populationPath, sha256: "sha256:" + crypto.createHash("sha256").update(populationContents).digest("hex"), bytes: Buffer.byteLength(populationContents), runId: input.runId, candidates: 1, bestIndex: 0, maxCandidates: input.maxPopulationCandidates, maxCandidateChars: input.maxCandidateChars, scenarioIds: (input.selectionSet.length ? input.selectionSet : input.trainSet).map((scenario) => scenario.id), surfaceKind: typeof input.seedCandidate === "string" ? "text" : "components" }',
    '  fs.writeFileSync(outputPath, JSON.stringify({',
    `    bestCandidate: ${serializedCandidate},`,
    '    bestScore: scored.score,',
    '    totalEvaluations: 1,',
    '    recipeKind: input.recipe.kind,',
    '    seedApplied: input.recipe.run.engine === "gepa",',
    '    proposerCostAccounting: "unavailable",',
    '    upstream: runtime.optimizer,',
    '    runId: input.runId,',
    '    resumed: false,',
    '    candidatePopulation,',
    `    ...${serializedExtras},`,
    '  }))',
    '})().catch((error) => { console.error(error); process.exit(1) })',
  ].join('\n')
  return { command: process.execPath, args: ['-e', source, '--'] }
}

function fakeGepaRunnerWithFailedEvaluation(observedInputPath: string) {
  const source = [
    "const fs = require('node:fs')",
    "const crypto = require('node:crypto')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(GEPA_RUNTIME_IDENTITY)}`,
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    `fs.writeFileSync(${JSON.stringify(observedInputPath)}, JSON.stringify({ ...input, cwd: process.cwd() }))`,
    ';(async () => {',
    '  const evaluate = async (candidate) => {',
    '    const response = await fetch(input.callbackUrl, {',
    '      method: "POST",',
    '      headers: { authorization: "Bearer " + input.callbackToken, "content-type": "application/json" },',
    '      body: JSON.stringify({ candidate, exampleId: input.trainSet[0].id }),',
    '    })',
    '    if (!response.ok) throw new Error("callback failed: " + response.status)',
    '    return response.json()',
    '  }',
    '  const failed = await evaluate("failed")',
    '  const scored = await evaluate("better")',
    '  fs.mkdirSync(input.outputDir, { recursive: true })',
    '  const populationPath = input.outputDir + "/candidate-population-failed-cell.json"',
    '  const populationContents = JSON.stringify({',
    '    schemaVersion: 1,',
    '    scope: "gepa-candidate-population",',
    '    runId: input.runId,',
    '    bestIndex: 1,',
    '    candidates: [',
    '      { index: 0, candidate: "failed", parentIndices: [null], aggregateScore: null, selectionScores: [], discoveryEvaluationCount: 1 },',
    '      { index: 1, candidate: "better", parentIndices: [0], aggregateScore: scored.score, selectionScores: [{ scenarioId: input.selectionSet[0].id, score: scored.score }], discoveryEvaluationCount: 2 },',
    '    ],',
    '  }, null, 2) + "\\n"',
    '  fs.writeFileSync(populationPath, populationContents)',
    '  const candidatePopulation = { scope: "gepa-candidate-population", path: populationPath, sha256: "sha256:" + crypto.createHash("sha256").update(populationContents).digest("hex"), bytes: Buffer.byteLength(populationContents), runId: input.runId, candidates: 2, bestIndex: 1, maxCandidates: input.maxPopulationCandidates, maxCandidateChars: input.maxCandidateChars, scenarioIds: (input.selectionSet.length ? input.selectionSet : input.trainSet).map((scenario) => scenario.id), surfaceKind: typeof input.seedCandidate === "string" ? "text" : "components" }',
    '  fs.writeFileSync(outputPath, JSON.stringify({',
    '    bestCandidate: "better",',
    '    bestScore: scored.score,',
    '    totalEvaluations: 2,',
    '    upstreamReportedEvaluations: 2,',
    '    recipeKind: input.recipe.kind,',
    '    seedApplied: input.recipe.run.engine === "gepa",',
    '    proposerCostAccounting: "unavailable",',
    '    upstream: runtime.optimizer,',
    '    runId: input.runId,',
    '    resumed: false,',
    '    candidatePopulation,',
    '  }))',
    '})().catch((error) => { console.error(error); process.exit(1) })',
  ].join('\n')
  return { command: process.execPath, args: ['-e', source, '--'] }
}

function fakeMeteredGepaRunner(upstreamBaseUrl: string, resumeMarker?: string) {
  const source = [
    "const fs = require('node:fs')",
    "const crypto = require('node:crypto')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `const runtime = ${JSON.stringify(GEPA_RUNTIME_IDENTITY)}`,
    'if (process.env.OPENAI_API_KEY) throw new Error("upstream secret reached child")',
    'if (process.env.AWS_SECRET_ACCESS_KEY) throw new Error("AWS secret reached child")',
    'if (process.env.CUSTOM_AUTH_TOKEN) throw new Error("custom token reached child")',
    'if (input.operation === "inspect") {',
    '  fs.writeFileSync(outputPath, JSON.stringify({ runtime }))',
    '  process.exit(0)',
    '}',
    `if (input.modelProxy.baseUrl === ${JSON.stringify(upstreamBaseUrl)}) throw new Error("upstream URL reached child")`,
    'if (input.modelProxy.apiKey === "provider-secret") throw new Error("upstream secret reached input")',
    ...(resumeMarker
      ? [
          `const resumed = fs.existsSync(${JSON.stringify(resumeMarker)}) && fs.readFileSync(${JSON.stringify(resumeMarker)}, "utf8") === input.runId`,
          `fs.writeFileSync(${JSON.stringify(resumeMarker)}, input.runId)`,
        ]
      : ['const resumed = false']),
    ';(async () => {',
    '  const completionResponse = await fetch(input.modelProxy.baseUrl + "/chat/completions", {',
    '    method: "POST",',
    '    headers: { authorization: "Bearer " + input.modelProxy.apiKey, "content-type": "application/json" },',
    '    body: JSON.stringify({ model: input.modelProxy.model, messages: [{ role: "user", content: "improve" }], max_tokens: 20 }),',
    '  })',
    '  if (!completionResponse.ok) throw new Error("model failed: " + completionResponse.status + " " + await completionResponse.text())',
    '  const completion = await completionResponse.json()',
    '  const response = await fetch(input.callbackUrl, {',
    '    method: "POST",',
    '    headers: { authorization: "Bearer " + input.callbackToken, "content-type": "application/json" },',
    '    body: JSON.stringify({ candidate: "better", exampleId: input.trainSet[0].id }),',
    '  })',
    '  if (!response.ok) throw new Error("callback failed: " + response.status)',
    '  const scored = await response.json()',
    '  fs.mkdirSync(input.outputDir, { recursive: true })',
    '  const populationPath = input.outputDir + "/candidate-population-test.json"',
    '  const populationContents = JSON.stringify({ schemaVersion: 1, scope: "gepa-candidate-population", runId: input.runId, bestIndex: 0, candidates: [{ index: 0, candidate: "better", parentIndices: [null], aggregateScore: scored.score, selectionScores: [{ scenarioId: (input.selectionSet[0] || input.trainSet[0]).id, score: scored.score }], discoveryEvaluationCount: 1 }] }, null, 2) + "\\n"',
    '  fs.writeFileSync(populationPath, populationContents)',
    '  const candidatePopulation = { scope: "gepa-candidate-population", path: populationPath, sha256: "sha256:" + crypto.createHash("sha256").update(populationContents).digest("hex"), bytes: Buffer.byteLength(populationContents), runId: input.runId, candidates: 1, bestIndex: 0, maxCandidates: input.maxPopulationCandidates, maxCandidateChars: input.maxCandidateChars, scenarioIds: (input.selectionSet.length ? input.selectionSet : input.trainSet).map((scenario) => scenario.id), surfaceKind: typeof input.seedCandidate === "string" ? "text" : "components" }',
    '  fs.writeFileSync(outputPath, JSON.stringify({',
    '    bestCandidate: "better",',
    '    bestScore: scored.score,',
    '    totalEvaluations: 1,',
    '    recipeKind: input.recipe.kind,',
    '    seedApplied: input.recipe.run.engine === "gepa",',
    '    proposerCostUsd: 0.00002,',
    '    proposerCostAccounting: "metered",',
    '    tokenUsage: { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens, totalTokens: completion.usage.total_tokens, calls: 1, requestAttempts: 1 },',
    '    upstream: runtime.optimizer,',
    '    runId: input.runId,',
    '    resumed,',
    '    candidatePopulation,',
    '  }))',
    '})().catch((error) => { console.error(error); process.exit(1) })',
  ].join('\n')
  return {
    command: process.execPath,
    args: ['-e', source, '--'],
    env: {
      OPENAI_API_KEY: 'unrelated-provider-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      CUSTOM_AUTH_TOKEN: 'custom-secret',
    },
  }
}

function gepaComparisonOptions(
  method: ReturnType<typeof gepaOptimizationMethod<TestScenario, TestArtifact>>,
  dispatchRef = 'test:gepa-optimization-method',
) {
  return {
    methods: [method],
    baselineSurface: 'baseline',
    trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'visible train', privateNote: '' }],
    selectionScenarios: [
      { id: 'selection', kind: 'qa', prompt: 'visible selection', privateNote: '' },
    ],
    testScenarios: [
      { id: 'final', kind: 'qa', prompt: 'final', privateNote: '' },
      { id: 'final-2', kind: 'qa', prompt: 'final 2', privateNote: '' },
    ],
    dispatchWithSurface: async (surface: MutableSurface) => ({
      text: String(surface),
    }),
    judges: [betterJudge],
    runDir,
    seed: 11,
    resamples: 40,
    expectUsage: 'off' as const,
    dispatchRef,
  }
}

function findFile(root: string, name: string): string | undefined {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    }
  }
  return undefined
}

async function startModelServer(): Promise<string> {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before replying.
    }
    if (request.headers.authorization !== 'Bearer provider-secret') {
      response.writeHead(401)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        id: 'completion-1',
        choices: [{ message: { role: 'assistant', content: 'better' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    )
  })
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('model server failed to bind')
  return `http://127.0.0.1:${address.port}/v1`
}

function optimizerModel(baseUrl = 'http://127.0.0.1:1/v1'): OpenAICompatibleOptimizerModel {
  const owner = testModelExecutionOwner({
    baseUrl,
    bearer: 'provider-secret',
    fetchImpl: fetch,
    pricing: GEPA_MODEL_BUDGET.pricing,
    callRef: `test-model-server:${baseUrl}`,
  })
  return {
    model: 'model',
    callRef: owner.callRef,
    call: owner.call,
    budget: GEPA_MODEL_BUDGET,
  }
}
