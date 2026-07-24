import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createExternalTextEvaluator,
  describeExternalScenario,
  externalTextOptimizationMethod,
} from '../../src/campaign/external-text-optimization'
import type { OptimizationMethodInput } from '../../src/campaign/presets/compare-optimization-methods'
import { createRunCostLedger, inMemoryCampaignStorage } from '../../src/campaign/storage'
import type { Scenario } from '../../src/campaign/types'

interface TestScenario extends Scenario {
  prompt: string
}

describe('external text optimization', () => {
  it('adapts a third-party optimizer with bounded evaluation, cost, and source provenance', async () => {
    const train: TestScenario = { id: 'train', kind: 'qa', prompt: 'visible train' }
    const selection: TestScenario = {
      id: 'selection',
      kind: 'qa',
      prompt: 'visible selection',
    }
    const input = optimizationInput([train], [selection])
    const observed: { train?: unknown; selection?: unknown } = {}
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'upstream-search',
      source: {
        kind: 'package',
        package: 'upstream-search',
        version: '3.2.1',
        sourceUrl: 'https://example.com/upstream-search',
        revision: 'abc123',
      },
      objective: 'Improve the answer policy.',
      evaluationId: 'qa',
      maxEvaluations: 2,
      maxOptimizerCostUsd: 0.01,
      describeScenario: ({ prompt }) => ({ prompt }),
      run: async (context) => {
        observed.train = context.trainSet
        observed.selection = context.selectionSet
        const paid = await context.cost.runPaidCall({
          actor: context.name,
          model: 'upstream-model',
          maximumCharge: { externallyEnforcedMaximumUsd: 0.01 },
          execute: async () => 'candidate',
          receipt: () => ({
            model: 'upstream-model',
            inputTokens: 4,
            cachedTokens: 2,
            cacheWriteTokens: 1,
            outputTokens: 3,
            reasoningTokens: 2,
            actualCostUsd: 0.01,
          }),
        })
        if (!paid.succeeded) throw paid.error
        await context.evaluate({ candidate: paid.value, exampleId: 'selection' })
        return {
          bestCandidate: paid.value,
          resumed: false,
          costAccounting: { kind: 'metered' },
        }
      },
    })

    const result = await method.optimize(input)

    expect(observed).toEqual({
      train: [{ id: 'train', data: { prompt: 'visible train' } }],
      selection: [{ id: 'selection', data: { prompt: 'visible selection' } }],
    })
    expect(result.winnerSurface).toBe('candidate')
    expect(result.cost).toEqual({
      totalCostUsd: 0.01,
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(result.provenance).toMatchObject({
      source: {
        kind: 'package',
        evidence: 'declared',
        package: 'upstream-search',
        version: '3.2.1',
        revision: 'abc123',
      },
      runId: expect.any(String),
      resumed: false,
      evaluationCount: 1,
      tokenUsage: {
        inputTokens: 7,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        outputTokens: 3,
        reasoningTokens: 2,
        totalTokens: 10,
        calls: 1,
      },
    })
    expect(input.costLedger.summary({ phase: 'external.optimizer' })).toMatchObject({
      totalCalls: 1,
      totalCostUsd: 0.01,
      accountingComplete: true,
    })
  })

  it('enforces the method-wide cost limit before optimizer work executes', async () => {
    const storage = inMemoryCampaignStorage()
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const input = {
      ...optimizationInput([scenario], [], { runDir: 'method-cost-limit', storage }),
      costLedger: createRunCostLedger({
        storage,
        runDir: 'method-cost-limit/cost',
        costCeilingUsd: 0,
      }),
    }
    let executed = false
    let rejected = false
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'method-cost-limit',
      source: { kind: 'package', package: 'method-cost-limit', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 1,
      run: async (context) => {
        const paid = await context.cost.runPaidCall({
          actor: context.name,
          model: 'model',
          maximumCharge: { externallyEnforcedMaximumUsd: 0.5 },
          execute: async () => {
            executed = true
            return 'candidate'
          },
          receipt: () => ({
            model: 'model',
            inputTokens: 1,
            outputTokens: 1,
            actualCostUsd: 0.5,
          }),
        })
        if (!paid.succeeded) {
          rejected = true
          return {
            bestCandidate: 'baseline',
            resumed: false,
            costAccounting: { kind: 'no-paid-work' },
          }
        }
        return {
          bestCandidate: paid.value,
          resumed: false,
          costAccounting: { kind: 'metered' },
        }
      },
    })

    const result = await method.optimize(input)
    expect(result.winnerSurface).toBe('baseline')
    expect(result.cost).toEqual({
      totalCostUsd: 0,
      accountingComplete: true,
      incompleteReasons: [],
    })
    expect(rejected).toBe(true)
    expect(executed).toBe(false)
    expect(input.costLedger.summary()).toMatchObject({
      totalCalls: 0,
      pendingCalls: 0,
      totalCostUsd: 0,
    })
  })

  it('enforces the optimizer sub-limit before debiting the method cost account', async () => {
    const storage = inMemoryCampaignStorage()
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const input = {
      ...optimizationInput([scenario], [], { runDir: 'optimizer-cost-limit', storage }),
      costLedger: createRunCostLedger({
        storage,
        runDir: 'optimizer-cost-limit/cost',
        costCeilingUsd: 1,
      }),
    }
    let executed = false
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'optimizer-cost-limit',
      source: { kind: 'package', package: 'optimizer-cost-limit', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 0,
      run: async (context) => {
        const paid = await context.cost.runPaidCall({
          actor: context.name,
          model: 'model',
          maximumCharge: { externallyEnforcedMaximumUsd: 0.5 },
          execute: async () => {
            executed = true
            return 'candidate'
          },
          receipt: () => ({
            model: 'model',
            inputTokens: 1,
            outputTokens: 1,
            actualCostUsd: 0.5,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return {
          bestCandidate: paid.value,
          resumed: false,
          costAccounting: { kind: 'metered' },
        }
      },
    })

    await expect(method.optimize(input)).rejects.toThrow('would exceed ceiling 0')
    expect(executed).toBe(false)
    expect(input.costLedger.summary()).toMatchObject({
      totalCalls: 0,
      pendingCalls: 0,
      totalCostUsd: 0,
    })
  })

  it('stops a third-party optimizer at its evaluation limit', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'bounded-search',
      source: { kind: 'package', package: 'bounded-search', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 0,
      run: async (context) => {
        await context.evaluate({ candidate: 'first', exampleId: 'train' })
        await context.evaluate({ candidate: 'second', exampleId: 'train' })
        return {
          bestCandidate: 'second',
          resumed: false,
          costAccounting: { kind: 'no-paid-work' },
        }
      },
    })

    await expect(method.optimize(optimizationInput([scenario], []))).rejects.toThrow(
      'bounded-search: maxEvaluations limit reached',
    )
  })

  it('resumes one compatible state directory with cumulative evaluation use', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'external-text-resume-'))
    const storage = inMemoryCampaignStorage()
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const input = optimizationInput([scenario], [], { runDir, storage })
    const observed: Array<{
      runId: string
      stateDir: string
      artifactDir: string
      restoreRequested: boolean
    }> = []
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'resumable-search',
      source: { kind: 'package', package: 'resumable-search', version: '4.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 2,
      maxOptimizerCostUsd: 0,
      resume: 'if-compatible',
      run: async (context) => {
        observed.push({
          runId: context.runId,
          stateDir: context.stateDir,
          artifactDir: context.artifactDir,
          restoreRequested: context.restoreRequested,
        })
        await context.evaluate({ candidate: 'candidate', exampleId: 'train' })
        return {
          bestCandidate: 'candidate',
          resumed: context.restoreRequested,
          costAccounting: { kind: 'no-paid-work' },
        }
      },
    })

    try {
      const first = await method.optimize(input)
      const second = await method.optimize(input)

      expect(observed).toHaveLength(2)
      expect(observed[0]).toMatchObject({ restoreRequested: false })
      expect(observed[1]).toMatchObject({ restoreRequested: true })
      expect(observed[1]!.runId).toBe(observed[0]!.runId)
      expect(observed[1]!.stateDir).toBe(observed[0]!.stateDir)
      expect(observed[1]!.artifactDir).not.toBe(observed[0]!.artifactDir)
      expect(first.provenance?.evaluationCount).toBe(1)
      expect(second.provenance).toMatchObject({
        runId: observed[0]!.runId,
        resumed: true,
        evaluationCount: 2,
      })
      await expect(method.optimize(input)).rejects.toThrow(
        'resumable-search: maxEvaluations limit reached',
      )
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it.each([
    'if-compatible',
    'required',
  ] as const)('resumes compatible partial state with %s mode and durably completes it', async (resume) => {
    const runDir = mkdtempSync(join(tmpdir(), `external-text-partial-${resume}-`))
    const storage = inMemoryCampaignStorage()
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const input = optimizationInput([scenario], [], { runDir, storage })
    let stateDir = ''
    const base = {
      name: 'partial-resume',
      source: { kind: 'package' as const, package: 'partial-resume', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 2,
      maxOptimizerCostUsd: 0,
    }
    const interrupted = externalTextOptimizationMethod<TestScenario, { text: string }>({
      ...base,
      resume: 'if-compatible',
      run: async (context) => {
        stateDir = context.stateDir
        expect(context.restoreRequested).toBe(false)
        storage.write(`${context.stateDir}/checkpoint.json`, '{"candidate":"candidate"}\n')
        await context.evaluate({ candidate: 'candidate', exampleId: 'train' })
        throw new Error('simulated interruption')
      },
    })
    const resumed = externalTextOptimizationMethod<TestScenario, { text: string }>({
      ...base,
      resume,
      run: async (context) => {
        expect(context.restoreRequested).toBe(true)
        expect(context.stateDir).toBe(stateDir)
        expect(storage.read(`${context.stateDir}/checkpoint.json`)).toContain('candidate')
        await context.evaluate({ candidate: 'candidate', exampleId: 'train' })
        return {
          bestCandidate: 'candidate',
          resumed: true,
          costAccounting: { kind: 'no-paid-work' },
        }
      },
    })

    try {
      await expect(interrupted.optimize(input)).rejects.toThrow('simulated interruption')
      const result = await resumed.optimize(input)
      const events = storage
        .read(`${stateDir}/run-manifest.jsonl`)!
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { status: string })

      expect(result.provenance).toMatchObject({
        resumed: true,
        evaluationCount: 2,
      })
      expect(events.map(({ status }) => status)).toEqual(['partial', 'partial', 'completed'])
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('starts with fresh state and budget when the dispatch identity changes', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'external-text-dispatch-identity-'))
    const storage = inMemoryCampaignStorage()
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const base = {
      name: 'dispatch-identity',
      source: { kind: 'package' as const, package: 'dispatch-identity', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 0,
      resume: 'if-compatible' as const,
    }
    let firstStateDir = ''
    const interrupted = externalTextOptimizationMethod<TestScenario, { text: string }>({
      ...base,
      run: async (context) => {
        firstStateDir = context.stateDir
        expect(context.restoreRequested).toBe(false)
        storage.write(`${context.stateDir}/checkpoint.json`, '{"candidate":"candidate"}\n')
        await context.evaluate({ candidate: 'candidate', exampleId: 'train' })
        throw new Error('simulated interruption')
      },
    })
    const fresh = externalTextOptimizationMethod<TestScenario, { text: string }>({
      ...base,
      run: async (context) => {
        expect(context.restoreRequested).toBe(false)
        expect(context.stateDir).not.toBe(firstStateDir)
        expect(storage.read(`${context.stateDir}/checkpoint.json`)).toBeUndefined()
        await context.evaluate({ candidate: 'candidate', exampleId: 'train' })
        return {
          bestCandidate: 'candidate',
          resumed: false,
          costAccounting: { kind: 'no-paid-work' },
        }
      },
    })

    try {
      await expect(
        interrupted.optimize(
          optimizationInput([scenario], [], {
            runDir,
            storage,
            dispatchRef: 'execution-a',
          }),
        ),
      ).rejects.toThrow('simulated interruption')
      const result = await fresh.optimize(
        optimizationInput([scenario], [], {
          runDir,
          storage,
          dispatchRef: 'execution-b',
        }),
      )

      expect(result.provenance).toMatchObject({
        resumed: false,
        evaluationCount: 1,
      })
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('rejects persisted state whose manifest does not match the compatible run', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'external-text-mismatched-manifest-'))
    const storage = inMemoryCampaignStorage()
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const input = optimizationInput([scenario], [], { runDir, storage })
    let stateDir = ''
    let calls = 0
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'mismatched-manifest',
      source: { kind: 'package', package: 'mismatched-manifest', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 0,
      resume: 'if-compatible',
      run: async (context) => {
        calls += 1
        stateDir = context.stateDir
        return {
          bestCandidate: 'candidate',
          resumed: context.restoreRequested,
          costAccounting: { kind: 'no-paid-work' },
        }
      },
    })

    try {
      await method.optimize(input)
      storage.write(
        `${stateDir}/run-manifest.jsonl`,
        `${JSON.stringify({
          runId: 'different-run',
          attemptId: 'different-attempt',
          status: 'partial',
        })}\n`,
      )

      await expect(method.optimize(input)).rejects.toThrow(
        'run-manifest.jsonl does not match the compatible run',
      )
      expect(calls).toBe(1)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('refuses required resume before a compatible run exists', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'external-text-required-'))
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const input = optimizationInput([scenario], [], {
      runDir,
      storage: inMemoryCampaignStorage(),
    })
    let called = false
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'required-resume',
      source: { kind: 'package', package: 'required-resume', version: '2.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 0,
      resume: 'required',
      run: async () => {
        called = true
        return {
          bestCandidate: 'candidate',
          resumed: true,
          costAccounting: { kind: 'no-paid-work' },
        }
      },
    })

    try {
      await expect(method.optimize(input)).rejects.toThrow('no compatible run state is available')
      expect(called).toBe(false)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('rejects a run that returns before its evaluations finish', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const input: OptimizationMethodInput<TestScenario, { text: string }> = {
      ...optimizationInput([scenario], []),
      dispatchWithSurface: async (surface) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { text: String(surface) }
      },
    }
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'detached-evaluation',
      source: { kind: 'package', package: 'detached-evaluation', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 0,
      run: async (context) => {
        void context.evaluate({ candidate: 'candidate', exampleId: 'train' })
        return {
          bestCandidate: 'candidate',
          resumed: false,
          costAccounting: { kind: 'no-paid-work' },
        }
      },
    })

    await expect(method.optimize(input)).rejects.toThrow(
      'run() completed with 1 outstanding evaluation',
    )
  })

  it('rejects a run that returns before its paid calls finish', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'detached-paid-call',
      source: { kind: 'package', package: 'detached-paid-call', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 1,
      run: async (context) => {
        void context.cost.runPaidCall({
          actor: context.name,
          model: 'model',
          maximumCharge: { externallyEnforcedMaximumUsd: 1 },
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20))
            return 'candidate'
          },
          receipt: () => ({
            model: 'model',
            inputTokens: 1,
            outputTokens: 1,
            actualCostUsd: 0.01,
          }),
        })
        return {
          bestCandidate: 'candidate',
          resumed: false,
          costAccounting: { kind: 'metered' },
        }
      },
    })

    await expect(method.optimize(optimizationInput([scenario], []))).rejects.toThrow(
      'run() completed with 1 outstanding paid call',
    )
  })

  it('marks unobserved external spend incomplete and rejects false accounting claims', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const external = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'external-spend',
      source: { kind: 'package', package: 'external-spend', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 0,
      run: async () => ({
        bestCandidate: 'candidate',
        resumed: false,
        costAccounting: { kind: 'external', reason: 'provider bills outside this process' },
      }),
    })
    const falseMetered = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'false-metered',
      source: { kind: 'package', package: 'false-metered', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 1,
      run: async () => ({
        bestCandidate: 'candidate',
        resumed: false,
        costAccounting: { kind: 'metered' },
      }),
    })

    const result = await external.optimize(optimizationInput([scenario], []))
    expect(result.cost).toEqual({
      totalCostUsd: 0,
      accountingComplete: false,
      incompleteReasons: [
        'optimizer: external spend is not observed: provider bills outside this process',
      ],
    })
    await expect(falseMetered.optimize(optimizationInput([scenario], []))).rejects.toThrow(
      'metered optimizer recorded no paid calls',
    )
  })

  it('aborts a cooperative optimizer at its timeout', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const method = externalTextOptimizationMethod<TestScenario, { text: string }>({
      name: 'timed-search',
      source: { kind: 'package', package: 'timed-search', version: '1.0.0' },
      objective: 'Improve the answer.',
      evaluationId: 'qa',
      maxEvaluations: 1,
      maxOptimizerCostUsd: 0,
      timeoutMs: 20,
      run: (context) =>
        new Promise<never>((_, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          })
        }),
    })

    await expect(method.optimize(optimizationInput([scenario], []))).rejects.toThrow(
      'timed-search: optimizer exceeded 20ms',
    )
  })

  it('rejects oversized serialized scenario context', () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    expect(() =>
      describeExternalScenario(scenario, 'test optimizer', 10, () => ({
        prompt: 'x'.repeat(100),
      })),
    ).toThrow("test optimizer scenario 'train' exceeds maxEvidenceChars")
  })

  it('rejects oversized serialized evaluation evidence', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({ storage, runDir: 'run/cost' })
    const input: OptimizationMethodInput<TestScenario, { text: string }> = {
      baselineSurface: 'baseline',
      trainScenarios: [scenario],
      selectionScenarios: [],
      dispatchWithSurface: async () => ({ text: 'x'.repeat(1_000) }),
      judges: [
        {
          name: 'quality',
          dimensions: [{ key: 'quality', description: 'quality' }],
          score: () => ({ dimensions: { quality: 1 }, composite: 1 }),
        },
      ],
      runDir: 'run',
      seed: 42,
      runOptions: { storage, expectUsage: 'off' },
      costLedger,
    }
    const evaluate = createExternalTextEvaluator({
      input,
      label: 'test optimizer',
      runDir: 'run',
      compatibleRunId: 'test-evaluation',
      costPhase: 'test',
      costLedger,
      scenarioById: new Map([[scenario.id, scenario]]),
      maxCandidateChars: 10_000,
      maxEvidenceChars: 200,
      describeArtifact: (artifact) => artifact,
    })

    await expect(evaluate({ candidate: 'candidate', exampleId: scenario.id })).rejects.toThrow(
      "test optimizer evaluation evidence for 'train' exceeds maxEvidenceChars",
    )
  })

  it('retries a candidate after transient evaluation evidence failure', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({ storage, runDir: 'retry/cost' })
    let descriptions = 0
    const input: OptimizationMethodInput<TestScenario, { text: string }> = {
      ...optimizationInput([scenario], [], { runDir: 'retry', storage }),
      costLedger,
    }
    const evaluate = createExternalTextEvaluator({
      input,
      label: 'retry optimizer',
      runDir: 'retry',
      compatibleRunId: 'retry-evaluation',
      costPhase: 'retry',
      costLedger,
      scenarioById: new Map([[scenario.id, scenario]]),
      maxCandidateChars: 10_000,
      maxEvidenceChars: 200,
      describeArtifact: () => {
        descriptions += 1
        return { text: descriptions === 1 ? 'x'.repeat(1_000) : 'ok' }
      },
    })

    await expect(evaluate({ candidate: 'candidate', exampleId: scenario.id })).rejects.toThrow(
      'evaluation evidence',
    )
    await expect(
      evaluate({ candidate: 'candidate', exampleId: scenario.id }),
    ).resolves.toMatchObject({ score: 1 })
    expect(descriptions).toBe(2)
  })

  it('does not reuse a score after the evaluation identity changes', async () => {
    const scenario: TestScenario = { id: 'train', kind: 'qa', prompt: 'test' }
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({ storage, runDir: 'identity/cost' })
    let score = 0
    let dispatches = 0
    const input: OptimizationMethodInput<TestScenario, { text: string }> = {
      ...optimizationInput([scenario], [], { runDir: 'identity', storage }),
      dispatchWithSurface: async () => {
        dispatches += 1
        return { text: 'candidate' }
      },
      judges: [
        {
          name: 'changing-evaluation',
          dimensions: [{ key: 'quality', description: 'quality' }],
          score: () => ({ dimensions: { quality: score }, composite: score }),
        },
      ],
      costLedger,
    }
    const create = (compatibleRunId: string) =>
      createExternalTextEvaluator({
        input,
        label: 'identity optimizer',
        runDir: 'identity',
        compatibleRunId,
        costPhase: 'identity',
        costLedger,
        scenarioById: new Map([[scenario.id, scenario]]),
        maxCandidateChars: 10_000,
        maxEvidenceChars: 1_000,
      })

    await expect(
      create('evaluation-a')({ candidate: 'candidate', exampleId: scenario.id }),
    ).resolves.toMatchObject({ score: 0 })
    score = 1
    await expect(
      create('evaluation-b')({ candidate: 'candidate', exampleId: scenario.id }),
    ).resolves.toMatchObject({ score: 1 })
    expect(dispatches).toBe(2)
  })
})

function optimizationInput(
  trainScenarios: readonly TestScenario[],
  selectionScenarios: readonly TestScenario[],
  options: {
    runDir?: string
    storage?: ReturnType<typeof inMemoryCampaignStorage>
    dispatchRef?: string
  } = {},
): OptimizationMethodInput<TestScenario, { text: string }> {
  const storage = options.storage ?? inMemoryCampaignStorage()
  const runDir = options.runDir ?? 'run'
  return {
    baselineSurface: 'baseline',
    trainScenarios,
    selectionScenarios,
    dispatchWithSurface: async (surface) => ({ text: String(surface) }),
    judges: [
      {
        name: 'quality',
        dimensions: [{ key: 'quality', description: 'quality' }],
        score: ({ artifact }) => ({
          dimensions: { quality: artifact.text === 'candidate' ? 1 : 0 },
          composite: artifact.text === 'candidate' ? 1 : 0,
        }),
      },
    ],
    runDir,
    seed: 42,
    runOptions: { storage, expectUsage: 'off', dispatchRef: options.dispatchRef },
    costLedger: createRunCostLedger({ storage, runDir: `${runDir}/cost` }),
  }
}
