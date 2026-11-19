import { describe, expect, it } from 'vitest'
import { toPrmRows } from '../src/rl/exporters'
import type { StepReward, StepScorer } from '../src/rl/process-reward'
import {
  extractStepRewards,
  prmTrainingPairs,
  runwiseStepRewardSummary,
} from '../src/rl/process-reward'
import { mintRolloutRows } from '../src/rollout/mint'
import type { RunRecord } from '../src/run-record'
import { TraceEmitter } from '../src/trace/emitter'
import type { Message, Span } from '../src/trace/schema'
import { InMemoryTraceStore } from '../src/trace/store'

// ── A recorded run, end to end: emitter → store → step rewards → pairs → rows ──

type RecordedStep =
  | { kind: 'llm'; name: string; messages: Message[]; output?: string }
  | { kind: 'tool'; name: string; args: unknown; result: unknown }

const user = (content: string): Message => ({ role: 'user', content })
const assistant = (content: string): Message => ({ role: 'assistant', content })

/** Record one run through the real emitter; each span closes before the next opens. */
async function recordRun(
  store: InMemoryTraceStore,
  runId: string,
  scenarioId: string,
  steps: RecordedStep[],
): Promise<void> {
  let clock = 0
  const emitter = new TraceEmitter(store, { runId, now: () => ++clock })
  await emitter.startRun({ scenarioId, layer: 'app-runtime' })
  for (const step of steps) {
    if (step.kind === 'llm') {
      const span = await emitter.llm({
        name: step.name,
        model: 'policy-model@2026-01-01',
        messages: step.messages,
      })
      await span.end(step.output === undefined ? {} : { output: step.output })
    } else {
      const span = await emitter.tool({ name: step.name, toolName: step.name, args: step.args })
      await span.end({ result: step.result })
    }
  }
  await emitter.endRun({ pass: true })
}

/** Rewards llm spans from a table keyed by run id and span name. */
function rewardTable(rewards: Record<string, Record<string, number>>): StepScorer {
  return {
    appliesTo: ['llm'],
    score: async (span) => {
      const reward = rewards[span.runId]?.[span.name]
      return reward === undefined
        ? null
        : { kind: span.kind, name: span.name, reward, determinism: 'deterministic' }
    },
  }
}

function runRecord(runId: string, scenarioId: string, score: number): RunRecord {
  return {
    runId,
    experimentId: 'prm-pairs',
    candidateId: 'A',
    seed: 0,
    model: 'policy-model@2026-01-01',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abcd',
    wallMs: 1,
    costUsd: 0,
    costProvenance: { kind: 'observed', usd: 0 },
    tokenUsage: { input: 0, output: 0 },
    terminalOutcome: 'succeeded',
    splitTag: 'search',
    scenarioId,
    outcome: { searchScore: score, raw: {} },
  }
}

async function orderedSpans(store: InMemoryTraceStore, runId: string): Promise<Span[]> {
  return [...(await store.spans({ runId }))].sort((a, b) => a.startedAt - b.startedAt)
}

function spanText(span: Span | undefined): string {
  if (span?.kind === 'llm') return span.output ?? ''
  if (span?.kind === 'tool') return JSON.stringify(span.result)
  throw new Error(`no text for span ${span?.spanId}`)
}

/** Text lookups a caller writes over its own trace store. */
function storeLookups(store: InMemoryTraceStore) {
  return {
    promptOf: async (runId: string) => {
      const first = (await orderedSpans(store, runId)).find((s) => s.kind === 'llm')
      return first?.kind === 'llm' ? (first.messages[0]?.content ?? '') : ''
    },
    stepTextOf: async (runId: string, spanId: string) =>
      spanText((await orderedSpans(store, runId)).find((s) => s.spanId === spanId)),
    prefixOf: async (runId: string, prefixStepIndex: number) =>
      (await orderedSpans(store, runId)).slice(0, prefixStepIndex + 1).map((s) => s.spanId),
  }
}

/** Fully captured lines, so the PRM exporter's completeness refusals pass. */
async function mintFullyCaptured(store: InMemoryTraceStore, records: RunRecord[]) {
  const { rows } = await mintRolloutRows(records, store, {
    messagesOf: async (runId) => {
      const llm = (await orderedSpans(store, runId)).filter((s) => s.kind === 'llm')
      const first = llm[0]
      const last = llm[llm.length - 1]
      if (first?.kind !== 'llm' || last?.kind !== 'llm') return undefined
      return [
        { role: 'user', content: first.messages[0]?.content ?? '' },
        { role: 'assistant', content: last.output ?? '' },
      ]
    },
  })
  return rows
}

async function stepRewardsOf(store: InMemoryTraceStore, scorer: StepScorer, runIds: string[]) {
  const byRun = new Map<string, StepReward[]>()
  for (const runId of runIds) {
    byRun.set(runId, await extractStepRewards(store, runId, { scorers: [scorer] }))
  }
  return byRun
}

describe('process-reward pairs from recorded runs', () => {
  it('builds no PRM row from two runs of different scenarios whose steps share kind and name', async () => {
    const store = new InMemoryTraceStore()
    const refund = user('What is the refund window?')
    const shipping = user('How long does shipping take?')
    await recordRun(store, 'refund-run', 'refund-policy', [
      { kind: 'llm', name: 'plan', messages: [refund], output: 'Read the refund policy.' },
      {
        kind: 'llm',
        name: 'answer',
        messages: [refund, assistant('Read the refund policy.')],
        output: 'Refunds are accepted within 30 days.',
      },
    ])
    await recordRun(store, 'shipping-run', 'shipping-times', [
      { kind: 'llm', name: 'plan', messages: [shipping], output: 'Read the carrier table.' },
      {
        kind: 'llm',
        name: 'answer',
        messages: [shipping, assistant('Read the carrier table.')],
        output: 'Orders ship in two days.',
      },
    ])
    const scorer = rewardTable({
      'refund-run': { plan: 0.5, answer: 0.9 },
      'shipping-run': { plan: 0.5, answer: 0.2 },
    })

    const byRun = await stepRewardsOf(store, scorer, ['refund-run', 'shipping-run'])
    const triples = prmTrainingPairs(byRun, { minMargin: 0.2 })
    const lines = await mintFullyCaptured(store, [
      runRecord('refund-run', 'refund-policy', 0.9),
      runRecord('shipping-run', 'shipping-times', 0.2),
    ])
    const rows = await toPrmRows(triples, storeLookups(store), { lines })

    expect(rows).toEqual([])
  })

  it('pairs the two answers of one scenario after an identical recorded prefix', async () => {
    const store = new InMemoryTraceStore()
    const question = user('What is the refund window?')
    const prefix: RecordedStep[] = [
      { kind: 'llm', name: 'plan', messages: [question], output: 'Search the policy.' },
      {
        kind: 'tool',
        name: 'search',
        args: { query: 'refund window' },
        result: { hits: ['Refunds within 30 days of delivery.'] },
      },
    ]
    const answerInput = [
      question,
      assistant('Search the policy.'),
      user('Search returned: Refunds within 30 days of delivery.'),
    ]
    await recordRun(store, 'rollout-1', 'refund-policy', [
      ...prefix,
      {
        kind: 'llm',
        name: 'answer',
        messages: answerInput,
        output: 'Refunds are accepted within 30 days of delivery.',
      },
    ])
    await recordRun(store, 'rollout-2', 'refund-policy', [
      ...prefix,
      { kind: 'llm', name: 'answer', messages: answerInput, output: 'Refunds are not accepted.' },
    ])
    const scorer = rewardTable({
      'rollout-1': { plan: 0.5, answer: 0.9 },
      'rollout-2': { plan: 0.5, answer: 0.1 },
    })

    const byRun = await stepRewardsOf(store, scorer, ['rollout-1', 'rollout-2'])
    const triples = prmTrainingPairs(byRun, { minMargin: 0.2 })
    const lines = await mintFullyCaptured(store, [
      runRecord('rollout-1', 'refund-policy', 0.9),
      runRecord('rollout-2', 'refund-policy', 0.1),
    ])
    const rows = await toPrmRows(triples, storeLookups(store), { lines })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      prompt: 'What is the refund window?',
      chosenStep: 'Refunds are accepted within 30 days of delivery.',
      rejectedStep: 'Refunds are not accepted.',
      chosenReward: 0.9,
      rejectedReward: 0.1,
    })
  })
})

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
      {
        spanId: 'a',
        runId: 'r',
        stepIndex: 0,
        kind: 'tool',
        name: 'a',
        reward: 0.9,
        determinism: 'deterministic',
      },
      {
        spanId: 'b',
        runId: 'r',
        stepIndex: 1,
        kind: 'tool',
        name: 'b',
        reward: 0.4,
        determinism: 'deterministic',
      },
      {
        spanId: 'c',
        runId: 'r',
        stepIndex: 2,
        kind: 'tool',
        name: 'c',
        reward: 0.3,
        determinism: 'deterministic',
      },
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
    const stepRewards = new Map<
      string,
      Array<{
        spanId: string
        runId: string
        stepIndex: number
        kind: 'tool'
        name: string
        reward: number
        determinism: 'deterministic'
      }>
    >()
    stepRewards.set('runA', [
      {
        spanId: 'a-0',
        runId: 'runA',
        stepIndex: 0,
        kind: 'tool',
        name: 'plan',
        reward: 0.7,
        determinism: 'deterministic',
      },
      {
        spanId: 'a-1',
        runId: 'runA',
        stepIndex: 1,
        kind: 'tool',
        name: 'edit',
        reward: 0.9,
        determinism: 'deterministic',
      },
    ])
    stepRewards.set('runB', [
      {
        spanId: 'b-0',
        runId: 'runB',
        stepIndex: 0,
        kind: 'tool',
        name: 'plan',
        reward: 0.7,
        determinism: 'deterministic',
      },
      {
        spanId: 'b-1',
        runId: 'runB',
        stepIndex: 1,
        kind: 'tool',
        name: 'edit',
        reward: 0.3,
        determinism: 'deterministic',
      },
    ])
    const triples = prmTrainingPairs(stepRewards, { minMargin: 0.2, minPrefixLength: 1 })
    expect(triples).toHaveLength(1)
    expect(triples[0]?.chosenSpanId).toBe('a-1')
    expect(triples[0]?.rejectedSpanId).toBe('b-1')
    expect(triples[0]?.marginScore).toBeCloseTo(0.6, 5)
  })

  it('drops pairs below minMargin', () => {
    const stepRewards = new Map<
      string,
      Array<{
        spanId: string
        runId: string
        stepIndex: number
        kind: 'tool'
        name: string
        reward: number
        determinism: 'deterministic'
      }>
    >()
    stepRewards.set('a', [
      {
        spanId: 'a-0',
        runId: 'a',
        stepIndex: 0,
        kind: 'tool',
        name: 'x',
        reward: 0.55,
        determinism: 'deterministic',
      },
    ])
    stepRewards.set('b', [
      {
        spanId: 'b-0',
        runId: 'b',
        stepIndex: 0,
        kind: 'tool',
        name: 'x',
        reward: 0.5,
        determinism: 'deterministic',
      },
    ])
    const triples = prmTrainingPairs(stepRewards, { minMargin: 0.2, minPrefixLength: 0 })
    expect(triples).toHaveLength(0)
  })
})
