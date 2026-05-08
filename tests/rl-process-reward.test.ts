import { describe, expect, it } from 'vitest'
import {
  extractStepRewards,
  prmTrainingPairs,
  runwiseStepRewardSummary,
} from '../src/rl/process-reward'
import type { StepScorer } from '../src/rl/process-reward'
import { InMemoryTraceStore } from '../src/trace/store'
import { TraceEmitter } from '../src/trace/emitter'

async function emitTraj(rewards: number[], runId?: string) {
  const store = new InMemoryTraceStore()
  const e = new TraceEmitter(store, { runId })
  await e.startRun({ scenarioId: 's', layer: 'app-runtime' })
  const handles: Array<{ end: () => Promise<void> }> = []
  for (let i = 0; i < rewards.length; i++) {
    const h = await e.tool({ name: `step-${i}`, toolName: `tool-${i}` })
    handles.push(h)
  }
  for (const h of handles.reverse()) await h.end()
  await e.endRun({ pass: true })
  return { store, runId: e.runId }
}

describe('extractStepRewards', () => {
  it('runs span scorers in order and skips non-applicable spans', async () => {
    const { store, runId } = await emitTraj([0.5, 0.7])
    const scorer: StepScorer = {
      appliesTo: ['tool'],
      score: () => ({
        reward: 0.6,
        determinism: 'deterministic',
        kind: 'tool',
        name: 'x',
        rationale: 'test',
      }),
    }
    const stepRewards = await extractStepRewards(store, runId, { scorers: [scorer] })
    expect(stepRewards).toHaveLength(2)
    expect(stepRewards[0]?.stepIndex).toBe(0)
    expect(stepRewards[1]?.stepIndex).toBe(1)
    expect(stepRewards.every((s) => s.reward === 0.6)).toBe(true)
  })

  it('honors preFilter to drop spans before scoring', async () => {
    const { store, runId } = await emitTraj([0.5, 0.7])
    const scorer: StepScorer = {
      appliesTo: ['tool'],
      score: () => ({ reward: 1, determinism: 'deterministic', kind: 'tool', name: 'x' }),
    }
    const stepRewards = await extractStepRewards(store, runId, {
      scorers: [scorer],
      preFilter: (span) => span.name !== 'step-0',
    })
    expect(stepRewards).toHaveLength(1)
    expect(stepRewards[0]?.name).toBe('step-1')
  })
})

describe('runwiseStepRewardSummary', () => {
  it('aggregates step rewards into a run-level diagnostic', () => {
    const out = runwiseStepRewardSummary([
      { spanId: 'a', runId: 'r', stepIndex: 0, kind: 'tool', name: 'a', reward: 0.9, determinism: 'deterministic' },
      { spanId: 'b', runId: 'r', stepIndex: 1, kind: 'tool', name: 'b', reward: 0.4, determinism: 'deterministic' },
      { spanId: 'c', runId: 'r', stepIndex: 2, kind: 'tool', name: 'c', reward: 0.3, determinism: 'deterministic' },
    ])
    expect(out.runId).toBe('r')
    expect(out.totalSteps).toBe(3)
    expect(out.failureFraction).toBeCloseTo(2 / 3, 5)
    expect(out.worstStepDelta).toBeCloseTo(-0.5, 5)
    expect(out.worstStepIndex).toBe(1)
    expect(out.meanReward).toBeCloseTo((0.9 + 0.4 + 0.3) / 3, 5)
  })

  it('returns zero-shaped report on empty input', () => {
    const out = runwiseStepRewardSummary([])
    expect(out.totalSteps).toBe(0)
    expect(out.worstStepIndex).toBeNull()
  })
})

describe('prmTrainingPairs', () => {
  it('pairs runs that share a prefix and diverge at a step with sufficient margin', () => {
    const stepRewards = new Map<string, Array<{
      spanId: string; runId: string; stepIndex: number; kind: 'tool';
      name: string; reward: number; determinism: 'deterministic'
    }>>()
    stepRewards.set('runA', [
      { spanId: 'a-0', runId: 'runA', stepIndex: 0, kind: 'tool', name: 'plan', reward: 0.7, determinism: 'deterministic' },
      { spanId: 'a-1', runId: 'runA', stepIndex: 1, kind: 'tool', name: 'edit', reward: 0.9, determinism: 'deterministic' },
    ])
    stepRewards.set('runB', [
      { spanId: 'b-0', runId: 'runB', stepIndex: 0, kind: 'tool', name: 'plan', reward: 0.7, determinism: 'deterministic' },
      { spanId: 'b-1', runId: 'runB', stepIndex: 1, kind: 'tool', name: 'edit', reward: 0.3, determinism: 'deterministic' },
    ])
    const triples = prmTrainingPairs(stepRewards, { minMargin: 0.2, minPrefixLength: 1 })
    expect(triples).toHaveLength(1)
    expect(triples[0]?.chosenSpanId).toBe('a-1')
    expect(triples[0]?.rejectedSpanId).toBe('b-1')
    expect(triples[0]?.marginScore).toBeCloseTo(0.6, 5)
  })

  it('drops pairs below minMargin', () => {
    const stepRewards = new Map<string, Array<{
      spanId: string; runId: string; stepIndex: number; kind: 'tool';
      name: string; reward: number; determinism: 'deterministic'
    }>>()
    stepRewards.set('a', [
      { spanId: 'a-0', runId: 'a', stepIndex: 0, kind: 'tool', name: 'x', reward: 0.55, determinism: 'deterministic' },
    ])
    stepRewards.set('b', [
      { spanId: 'b-0', runId: 'b', stepIndex: 0, kind: 'tool', name: 'x', reward: 0.5, determinism: 'deterministic' },
    ])
    const triples = prmTrainingPairs(stepRewards, { minMargin: 0.2, minPrefixLength: 0 })
    expect(triples).toHaveLength(0)
  })
})
