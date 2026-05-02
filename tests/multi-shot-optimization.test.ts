import { describe, expect, it } from 'vitest'
import {
  runMultiShotOptimization,
  trialTraceFromMultiShotTrial,
  type MultiShotVariant,
  type MultiShotTrialResult,
} from '../src/index'
import type { RunRecord, RunSplitTag } from '../src/run-record'

interface Payload {
  quality: number
}

function variant(id: string, quality: number): MultiShotVariant<Payload> {
  return {
    id,
    label: id,
    generation: 0,
    payload: { quality },
  }
}

function runRecord(input: {
  runId: string
  variant: MultiShotVariant<Payload>
  scenarioId: string
  rep: number
  split: RunSplitTag
  seed: number
  trial: MultiShotTrialResult
}): RunRecord {
  const scoreKey = input.split === 'holdout' ? 'holdoutScore' : 'searchScore'
  return {
    runId: `${input.runId}-${input.variant.id}-${input.scenarioId}-${input.rep}-${input.split}`,
    experimentId: input.scenarioId,
    candidateId: input.variant.id,
    seed: input.seed,
    model: 'test-model@2026-01-01',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: input.trial.durationMs ?? 1,
    costUsd: input.trial.cost ?? 0,
    tokenUsage: { input: 10, output: 5 },
    outcome: {
      [scoreKey]: input.trial.score,
      raw: { score: input.trial.score },
    },
    splitTag: input.split,
  }
}

describe('runMultiShotOptimization', () => {
  it('optimizes variable-length traces and passes ASI through reflection trials', async () => {
    let sawReflectionTrace = false

    const result = await runMultiShotOptimization<Payload>({
      runId: 'ms-reflect',
      target: 'agent-system-prompt',
      seedVariants: [variant('baseline', 0.2)],
      searchScenarioIds: ['one-shot', 'three-shot'],
      reps: 1,
      generations: 2,
      populationSize: 2,
      scoreConcurrency: 2,
      runner: {
        run: ({ variant, scenarioId }) => ({
          trace: {
            scenarioId,
            turns: Array.from({ length: scenarioId === 'one-shot' ? 1 : 3 }, (_, i) => ({
              role: i % 2 === 0 ? 'user' : 'assistant',
              content: `${scenarioId}:${variant.payload.quality}:${i}`,
            })),
            output: `quality=${variant.payload.quality}`,
          },
          costUsd: 0.01,
          durationMs: 10,
        }),
      },
      scorer: {
        score: ({ variant }) => ({
          score: variant.payload.quality,
          ok: true,
          asi: variant.payload.quality >= 0.8
            ? []
            : [{
                expectationId: 'complete-task',
                message: 'Task was incomplete across the conversation.',
                severity: 'error',
                responsibleSurface: 'system',
                suggestion: 'Require the agent to finish all requested steps before reporting success.',
              }],
        }),
      },
      mutateAdapter: {
        mutate: async ({ parent, bottomTrials, childCount, generation }) => {
          const trace = trialTraceFromMultiShotTrial(bottomTrials[0]!)
          sawReflectionTrace = trace.expectations.some((e) => e.id === 'complete-task' && !e.matched)
          return Array.from({ length: childCount }, (_, i) => ({
            id: `${parent.id}-fixed-${i}`,
            label: 'fixed',
            generation,
            payload: { quality: 0.9 },
            rationale: trace.expectations[0]?.phrase,
          }))
        },
      },
      scalarWeights: { score: 1, cost: 0 },
      earlyStopOnNoImprovement: false,
    })

    expect(sawReflectionTrace).toBe(true)
    expect(result.searchBestVariant.id).toContain('fixed')
    expect(result.promotedVariant.id).toBe(result.searchBestVariant.id)
    expect(result.searchBestAggregate.meanScore).toBe(0.9)

    const firstTrial = result.evolution.generations[0]!.trials[0] as MultiShotTrialResult
    expect(firstTrial.trace?.turns).toHaveLength(1)
    expect(firstTrial.metrics?.asi).toBe(1)
    expect(firstTrial.metrics?.['surface.system']).toBe(1)
  })

  it('evaluates a promoted candidate through paired holdout gating', async () => {
    const result = await runMultiShotOptimization<Payload>({
      runId: 'ms-gate',
      target: 'research-agent',
      seedVariants: [variant('baseline', 0.45)],
      searchScenarioIds: ['search-a', 'search-b', 'search-c'],
      reps: 1,
      generations: 2,
      populationSize: 2,
      scoreConcurrency: 1,
      runner: {
        run: ({ variant, scenarioId }) => ({
          trace: {
            scenarioId,
            transcript: `${scenarioId} completed at ${variant.payload.quality}`,
          },
          costUsd: 0.02,
          durationMs: 20,
        }),
      },
      scorer: {
        score: ({ variant }) => ({
          score: variant.payload.quality,
          ok: true,
        }),
      },
      mutateAdapter: {
        mutate: async ({ parent, childCount, generation }) => Array.from({ length: childCount }, (_, i) => ({
          id: `${parent.id}-candidate-${i}`,
          label: 'candidate',
          generation,
          payload: { quality: 0.9 },
        })),
      },
      scalarWeights: { score: 1, cost: 0 },
      earlyStopOnNoImprovement: false,
      gate: {
        searchScenarioIds: ['search-a', 'search-b', 'search-c'],
        holdoutScenarioIds: ['holdout-a', 'holdout-b', 'holdout-c', 'holdout-d'],
        reps: 1,
        gate: {
          baselineKey: 'baseline',
          minProductiveRuns: 3,
          pairedDeltaThreshold: 0,
          overfitGapThreshold: 1,
          seed: 11,
        },
        toRunRecord: ({ variant, scenarioId, rep, split, seed, trial }) => runRecord({
          runId: 'ms-gate',
          variant,
          scenarioId,
          rep,
          split,
          seed,
          trial,
        }),
      },
    })

    expect(result.gate?.decision.promote).toBe(true)
    expect(result.promotedVariant.id).toBe(result.searchBestVariant.id)
    expect(result.gate?.candidateRuns.some((r) => r.splitTag === 'holdout')).toBe(true)
    expect(result.gate?.baselineRuns).toHaveLength(result.gate?.candidateRuns.length)
    expect(result.gate?.decision.evidence.medianPairedDelta).toBeGreaterThan(0)
  })

  it('keeps the baseline promoted when the holdout gate rejects the search winner', async () => {
    const result = await runMultiShotOptimization<Payload>({
      runId: 'ms-reject',
      target: 'research-agent',
      seedVariants: [variant('baseline', 0.45)],
      searchScenarioIds: ['search-a', 'search-b', 'search-c'],
      reps: 1,
      generations: 2,
      populationSize: 2,
      scoreConcurrency: 1,
      runner: {
        run: ({ variant, scenarioId }) => ({
          trace: { scenarioId, transcript: `${variant.id}:${scenarioId}` },
        }),
      },
      scorer: {
        score: ({ variant, scenarioId }) => ({
          score: scenarioId.startsWith('holdout') && variant.id !== 'baseline' ? 0.2 : variant.payload.quality,
          ok: true,
        }),
      },
      mutateAdapter: {
        mutate: async ({ parent, childCount, generation }) => Array.from({ length: childCount }, (_, i) => ({
          id: `${parent.id}-overfit-${i}`,
          label: 'overfit',
          generation,
          payload: { quality: 0.9 },
        })),
      },
      scalarWeights: { score: 1, cost: 0 },
      earlyStopOnNoImprovement: false,
      gate: {
        holdoutScenarioIds: ['holdout-a', 'holdout-b', 'holdout-c', 'holdout-d'],
        gate: {
          baselineKey: 'baseline',
          minProductiveRuns: 3,
          pairedDeltaThreshold: 0,
          overfitGapThreshold: 1,
          seed: 13,
        },
        toRunRecord: ({ variant, scenarioId, rep, split, seed, trial }) => runRecord({
          runId: 'ms-reject',
          variant,
          scenarioId,
          rep,
          split,
          seed,
          trial,
        }),
      },
    })

    expect(result.searchBestVariant.id).toContain('overfit')
    expect(result.gate?.decision.promote).toBe(false)
    expect(result.gate?.decision.rejectionCode).toBe('negative_delta')
    expect(result.promotedVariant.id).toBe('baseline')
    expect(result.promotedAggregate.variantId).toBe('baseline')
  })

  it('turns runner failures into failed trials with critical ASI', async () => {
    const result = await runMultiShotOptimization<Payload>({
      runId: 'ms-error',
      target: 'tool-policy',
      seedVariants: [variant('baseline', 0.5)],
      searchScenarioIds: ['broken'],
      reps: 1,
      generations: 1,
      populationSize: 1,
      scoreConcurrency: 1,
      runner: {
        run: () => {
          throw new Error('tool crashed')
        },
      },
      scorer: {
        score: () => ({ score: 1, ok: true }),
      },
      mutateAdapter: {
        mutate: async () => [],
      },
    })

    const trial = result.evolution.generations[0]!.trials[0] as MultiShotTrialResult
    expect(trial.ok).toBe(false)
    expect(trial.score).toBe(0)
    expect(trial.error).toBe('tool crashed')
    expect(trial.metrics?.error).toBe(1)
    expect(trial.asi?.[0]?.severity).toBe('critical')
  })

  it('rejects ambiguous release configurations before running trials', async () => {
    await expect(runMultiShotOptimization<Payload>({
      runId: 'bad-config',
      target: 'agent',
      seedVariants: [variant('baseline', 0.5), variant('baseline', 0.6)],
      searchScenarioIds: ['s1'],
      reps: 1,
      generations: 1,
      populationSize: 2,
      runner: { run: ({ scenarioId }) => ({ trace: { scenarioId } }) },
      scorer: { score: () => ({ score: 1 }) },
      mutateAdapter: { mutate: async () => [] },
    })).rejects.toThrow(/duplicate seedVariants.id/)
  })
})
