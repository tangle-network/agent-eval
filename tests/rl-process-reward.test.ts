import { describe, expect, it } from 'vitest'
import { toPrmRows } from '../src/rl/exporters'
import type { PrmTrainingTriple, StepReward, StepScorer } from '../src/rl/process-reward'
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

async function stepRewardsOf(
  store: InMemoryTraceStore,
  scorer: StepScorer,
  runIds: string[],
  options: { contextAttributes?: readonly string[] } = {},
) {
  const byRun = new Map<string, StepReward[]>()
  for (const runId of runIds) {
    byRun.set(runId, await extractStepRewards(store, runId, { scorers: [scorer], ...options }))
  }
  return byRun
}

const POLICY_MODEL = 'policy-model@2026-01-01'

/** Record one run whose spans the body opens and closes in any order, on a ticking clock. */
async function episode(
  store: InMemoryTraceStore,
  runId: string,
  scenarioId: string | undefined,
  body: (emitter: TraceEmitter) => Promise<void>,
): Promise<void> {
  let clock = 0
  const emitter = new TraceEmitter(store, { runId, now: () => ++clock })
  await emitter.startRun(
    scenarioId === undefined ? { layer: 'app-runtime' } : { scenarioId, layer: 'app-runtime' },
  )
  await body(emitter)
  await emitter.endRun({ pass: true })
}

async function llmStep(
  emitter: TraceEmitter,
  name: string,
  messages: Message[],
  output: string,
  attributes?: Record<string, unknown>,
): Promise<void> {
  const span = await emitter.llm({
    name,
    model: POLICY_MODEL,
    messages,
    ...(attributes === undefined ? {} : { attributes }),
  })
  await span.end({ output })
}

/** Rewards every span of the listed kinds from a table keyed by run id and span name. */
function tableScorer(
  kinds: StepScorer['appliesTo'],
  rewards: Record<string, Record<string, number>>,
  contextDigest?: string,
): StepScorer {
  return {
    appliesTo: kinds,
    score: (span) => {
      const reward = rewards[span.runId]?.[span.name]
      if (reward === undefined) return null
      return {
        kind: span.kind,
        name: span.name,
        reward,
        determinism: 'deterministic',
        ...(contextDigest === undefined ? {} : { contextDigest }),
      }
    },
  }
}

describe('a step’s context is what was observable when it started', () => {
  const question = user('What is the refund window?')
  const planned = [question, assistant('Check the policy.')]

  it('pairs two runs that share a prefix inside a root span that ends differently', async () => {
    const store = new InMemoryTraceStore()
    for (const [runId, answer, rootFails] of [
      ['rooted-1', 'Refunds are accepted within 30 days.', false],
      ['rooted-2', 'Refunds are not accepted.', true],
    ] as const) {
      await episode(store, runId, 'refund-policy', async (e) => {
        const root = await e.span({ kind: 'agent', name: 'episode' })
        await llmStep(e, 'plan', [question], 'Check the policy.')
        await llmStep(e, 'answer', planned, answer)
        if (rootFails) await root.fail('the user rejected the answer')
        else await root.end()
      })
    }
    const scorer = tableScorer(['llm'], {
      'rooted-1': { answer: 0.9 },
      'rooted-2': { answer: 0.1 },
    })

    const { triples } = prmTrainingPairs(await stepRewardsOf(store, scorer, ['rooted-1', 'rooted-2']))

    expect(triples).toHaveLength(1)
    expect(triples[0]).toMatchObject({ prefixRunId: 'rooted-1', rejectedRunId: 'rooted-2' })
  })

  it('pairs two runs whose parallel tool call ends with different results after the step starts', async () => {
    const store = new InMemoryTraceStore()
    for (const [runId, fetched, answer] of [
      ['parallel-1', 'Refunds: 30 days.', 'Refunds are accepted within 30 days.'],
      ['parallel-2', 'Refunds: none.', 'Refunds are not accepted.'],
    ] as const) {
      await episode(store, runId, 'refund-policy', async (e) => {
        await llmStep(e, 'plan', [question], 'Check the policy.')
        const fetch = await e.tool({ name: 'fetch', toolName: 'fetch', args: { page: 'refunds' } })
        const step = await e.llm({ name: 'answer', model: POLICY_MODEL, messages: planned })
        await fetch.end({ result: fetched })
        await step.end({ output: answer })
      })
    }
    const scorer = tableScorer(['llm'], {
      'parallel-1': { answer: 0.9 },
      'parallel-2': { answer: 0.1 },
    })

    const { triples } = prmTrainingPairs(
      await stepRewardsOf(store, scorer, ['parallel-1', 'parallel-2']),
    )

    expect(triples).toHaveLength(1)
  })

  it('does not pair two runs whose tool call ended with different results before the step', async () => {
    const store = new InMemoryTraceStore()
    for (const [runId, fetched, answer] of [
      ['ended-1', 'Refunds: 30 days.', 'Refunds are accepted within 30 days.'],
      ['ended-2', 'Refunds: none.', 'Refunds are not accepted.'],
    ] as const) {
      await episode(store, runId, 'refund-policy', async (e) => {
        await llmStep(e, 'plan', [question], 'Check the policy.')
        const fetch = await e.tool({ name: 'fetch', toolName: 'fetch', args: { page: 'refunds' } })
        await fetch.end({ result: fetched })
        await llmStep(e, 'answer', planned, answer)
      })
    }
    const scorer = tableScorer(['llm'], { 'ended-1': { answer: 0.9 }, 'ended-2': { answer: 0.1 } })

    const paired = prmTrainingPairs(await stepRewardsOf(store, scorer, ['ended-1', 'ended-2']))

    expect(paired.triples).toEqual([])
    expect(paired.singleRunContexts).toBe(2)
  })

  it('counts only the attributes the caller names as context', async () => {
    const store = new InMemoryTraceStore()
    for (const [runId, answer] of [
      ['traced-1', 'Refunds are accepted within 30 days.'],
      ['traced-2', 'Refunds are not accepted.'],
    ] as const) {
      await episode(store, runId, 'refund-policy', async (e) => {
        await llmStep(e, 'plan', [question], 'Check the policy.', {
          requestId: `req-${runId}`,
          phase: 'plan',
        })
        await llmStep(e, 'answer', planned, answer)
      })
    }
    const scorer = tableScorer(['llm'], { 'traced-1': { answer: 0.9 }, 'traced-2': { answer: 0.1 } })
    const runIds = ['traced-1', 'traced-2']

    const strict = prmTrainingPairs(await stepRewardsOf(store, scorer, runIds))
    const named = prmTrainingPairs(
      await stepRewardsOf(store, scorer, runIds, { contextAttributes: ['phase'] }),
    )

    // A per-run request id in a span's attributes keeps every later context apart.
    expect(strict.triples).toEqual([])
    expect(named.triples).toHaveLength(1)
  })

  it('gives a run with no scenario id no context, so unrelated tool-first runs never pair', async () => {
    const store = new InMemoryTraceStore()
    for (const [runId, query] of [
      ['anonymous-1', 'refund window'],
      ['anonymous-2', 'shipping times'],
    ] as const) {
      await episode(store, runId, undefined, async (e) => {
        const search = await e.tool({ name: 'search', toolName: 'search', args: { query } })
        await search.end({ result: [] })
      })
    }
    const scorer = tableScorer(['tool'], {
      'anonymous-1': { search: 0.9 },
      'anonymous-2': { search: 0.1 },
    })

    const paired = prmTrainingPairs(
      await stepRewardsOf(store, scorer, ['anonymous-1', 'anonymous-2']),
    )

    expect(paired.triples).toEqual([])
    expect(paired.stepsWithoutContextDigest).toBe(2)
  })

  it('gives a span whose arguments refer to themselves no digest instead of throwing', async () => {
    const store = new InMemoryTraceStore()
    const cyclic: Record<string, unknown> = { path: 'policy.md' }
    cyclic.self = cyclic
    const shared = { path: 'policy.md' }
    for (const [runId, args] of [
      ['cyclic', cyclic],
      ['shared', { first: shared, second: shared }],
    ] as const) {
      await episode(store, runId, 'refund-policy', async (e) => {
        const read = await e.tool({ name: 'read', toolName: 'read', args })
        await read.end({ result: 'Refunds: 30 days.' })
        await llmStep(e, 'answer', [question], 'Refunds are accepted within 30 days.')
      })
    }
    const scorer = tableScorer(['tool', 'llm'], {
      cyclic: { read: 0.5, answer: 0.5 },
      shared: { read: 0.5, answer: 0.5 },
    })

    const byRun = await stepRewardsOf(store, scorer, ['cyclic', 'shared'])

    const [read, answer] = byRun.get('cyclic') ?? []
    expect(read?.actionDigest).toBeUndefined()
    expect(answer?.contextDigest).toBeUndefined()
    // A value reached twice without a cycle still encodes.
    const [sharedRead, sharedAnswer] = byRun.get('shared') ?? []
    expect(sharedRead?.actionDigest).toMatch(/^sha256:/)
    expect(sharedAnswer?.contextDigest).toMatch(/^sha256:/)
  })
})

describe('one triple per pair of actions, decided on mean reward', () => {
  const question = user('What is the refund window?')

  async function answers(store: InMemoryTraceStore, outputs: Record<string, string>) {
    for (const [runId, output] of Object.entries(outputs)) {
      await episode(store, runId, 'refund-policy', (e) => llmStep(e, 'answer', [question], output))
    }
  }

  it('emits nothing when the means are closer than the margin', async () => {
    const store = new InMemoryTraceStore()
    await answers(store, { 'x-1': 'Thirty days.', 'x-2': 'Thirty days.', 'y-1': 'No refunds.' })
    const scorer = tableScorer(['llm'], {
      'x-1': { answer: 0.9 },
      'x-2': { answer: 0.3 },
      'y-1': { answer: 0.5 },
    })

    const paired = prmTrainingPairs(await stepRewardsOf(store, scorer, ['x-1', 'x-2', 'y-1']))

    // X averages 0.6 and Y 0.5: one per-step pair says X > Y and another Y > X.
    expect(paired.triples).toEqual([])
    expect(paired.actionPairsBelowMargin).toBe(1)
  })

  it('emits one triple carrying each action’s mean and the steps behind it', async () => {
    const store = new InMemoryTraceStore()
    await answers(store, { 'x-2': 'Thirty days.', 'x-1': 'Thirty days.', 'y-1': 'No refunds.' })
    const scorer = tableScorer(['llm'], {
      'x-1': { answer: 0.9 },
      'x-2': { answer: 0.7 },
      'y-1': { answer: 0.3 },
    })

    const { triples } = prmTrainingPairs(await stepRewardsOf(store, scorer, ['x-2', 'x-1', 'y-1']))

    expect(triples).toHaveLength(1)
    expect(triples[0]).toMatchObject({
      prefixRunId: 'x-1',
      rejectedRunId: 'y-1',
      chosenStepCount: 2,
      rejectedStepCount: 1,
      chosenRunIds: ['x-1', 'x-2'],
      rejectedRunIds: ['y-1'],
    })
    expect(triples[0]?.chosenReward).toBeCloseTo(0.8, 10)
    expect(triples[0]?.marginScore).toBeCloseTo(0.5, 10)
  })

  it('builds no PRM row when a run behind a mean is realness-gated, even one not shown', async () => {
    const store = new InMemoryTraceStore()
    await answers(store, { 'x-1': 'Thirty days.', 'x-2': 'Thirty days.', 'y-1': 'No refunds.' })
    const scorer = tableScorer(['llm'], {
      'x-1': { answer: 0.9 },
      'x-2': { answer: 0.7 },
      'y-1': { answer: 0.3 },
    })
    const gamed: RunRecord = {
      ...runRecord('x-2', 'refund-policy', 0.7),
      outcome: { searchScore: 0.7, raw: {}, realness: { score: 0, gated: true } },
    }
    const lines = await mintFullyCaptured(store, [
      runRecord('x-1', 'refund-policy', 0.9),
      gamed,
      runRecord('y-1', 'refund-policy', 0.3),
    ])

    const { triples } = prmTrainingPairs(await stepRewardsOf(store, scorer, ['x-1', 'x-2', 'y-1']))
    const rows = await toPrmRows(triples, storeLookups(store), { lines })

    // x-2's gamed 0.7 is half of X's mean, though the row would show x-1's step.
    expect(rows).toEqual([])
  })

  it('counts a pair of actions that only one run took', async () => {
    // A caller's checkpoint identity puts two steps of one run in one context.
    const store = new InMemoryTraceStore()
    await episode(store, 'forked', 'refund-policy', async (e) => {
      await llmStep(e, 'first', [question], 'Thirty days.')
      await llmStep(e, 'second', [question], 'No refunds.')
    })
    await episode(store, 'other', 'refund-policy', (e) =>
      llmStep(e, 'first', [question], 'Ask support.'),
    )
    const scorer = tableScorer(
      ['llm'],
      { forked: { first: 0.9, second: 0.1 }, other: { first: 0.5 } },
      'checkpoint:refund-policy/turn-0',
    )

    const paired = prmTrainingPairs(await stepRewardsOf(store, scorer, ['forked', 'other']))

    // 'Thirty days.' vs 'No refunds.' has no second run; each against 'Ask support.' does.
    expect(paired.actionPairsInOneRun).toBe(1)
    expect(paired.triples).toHaveLength(2)
  })
})

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
    const paired = prmTrainingPairs(byRun, { minMargin: 0.2 })
    const lines = await mintFullyCaptured(store, [
      runRecord('refund-run', 'refund-policy', 0.9),
      runRecord('shipping-run', 'shipping-times', 0.2),
    ])
    const rows = await toPrmRows(paired.triples, storeLookups(store), { lines })

    expect(rows).toEqual([])
    // Every step was fully recorded; no context was reached by two runs.
    expect(paired).toMatchObject({
      stepsWithoutContextDigest: 0,
      stepsWithoutActionDigest: 0,
      singleRunContexts: 4,
      sameActionContexts: 0,
    })
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
    const paired = prmTrainingPairs(byRun, { minMargin: 0.2 })
    const lines = await mintFullyCaptured(store, [
      runRecord('rollout-1', 'refund-policy', 0.9),
      runRecord('rollout-2', 'refund-policy', 0.1),
    ])
    const rows = await toPrmRows(paired.triples, storeLookups(store), { lines })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      prompt: 'What is the refund window?',
      // The unscored search call is part of the prefix: `stepIndex` counts every span.
      prefixStepText: ['Search the policy.', '{"hits":["Refunds within 30 days of delivery."]}'],
      chosenStep: 'Refunds are accepted within 30 days of delivery.',
      rejectedStep: 'Refunds are not accepted.',
      chosenReward: 0.9,
      rejectedReward: 0.1,
      meta: { prefixRunId: 'rollout-1', rejectedRunId: 'rollout-2', prefixStepIndex: 1 },
    })
    expect(rows[0]?.meta?.contextDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    const answers = [...byRun.values()].map((steps) => steps.find((s) => s.name === 'answer'))
    expect(rows[0]?.meta?.contextDigest).toBe(answers[0]?.contextDigest)
    expect(answers[1]?.contextDigest).toBe(answers[0]?.contextDigest)
    // Both plans: the same context and the same action, which is no preference.
    expect(paired.sameActionContexts).toBe(1)
    // The exporter refuses the same triple once it no longer names its context.
    const { contextDigest: _, ...undigested } = paired.triples[0]!
    await expect(
      toPrmRows([undigested as PrmTrainingTriple], storeLookups(store), { lines }),
    ).rejects.toThrow(/no context digest/)
  })

  it('reports the steps it could not pair instead of pairing them', async () => {
    const store = new InMemoryTraceStore()
    const question = user('What is the refund window?')
    const answer = (output: string): RecordedStep => ({
      kind: 'llm',
      name: 'answer',
      messages: [question],
      output,
    })
    // Same context, same action, different rewards: scorer noise.
    await recordRun(store, 'same-1', 'refund-policy', [answer('Thirty days.')])
    await recordRun(store, 'same-2', 'refund-policy', [answer('Thirty days.')])
    // An earlier llm span whose output was not recorded: later contexts are unknown.
    for (const runId of ['lost-1', 'lost-2']) {
      await recordRun(store, runId, 'refund-policy', [
        { kind: 'llm', name: 'plan', messages: [question] },
        answer(runId === 'lost-1' ? 'Thirty days.' : 'No refunds.'),
      ])
    }
    // Arguments observed but not captured: the call is not a recorded action.
    const blind = new TraceEmitter(store, { runId: 'blind', now: () => 1 })
    await blind.startRun({ scenarioId: 'refund-policy' })
    await (
      await blind.tool({ name: 'search', toolName: 'search', args: {}, argsCaptured: false })
    ).end({ result: [] })
    // Spans of a run the store never recorded: no scenario, so no context.
    const orphan = new TraceEmitter(store, { runId: 'orphan', now: () => 1 })
    await (await orphan.llm({ name: 'answer', model: 'm', messages: [question] })).end({
      output: 'Thirty days.',
    })
    const scorer: StepScorer = {
      appliesTo: ['llm', 'tool'],
      score: (span) => ({
        kind: span.kind,
        name: span.name,
        reward: span.runId.endsWith('1') ? 0.9 : 0.1,
        determinism: 'deterministic',
      }),
    }

    const runIds = ['same-1', 'same-2', 'lost-1', 'lost-2', 'blind', 'orphan']
    const paired = prmTrainingPairs(await stepRewardsOf(store, scorer, runIds))

    expect(paired.triples).toEqual([])
    expect(paired).toMatchObject({
      // the two answers after an unrecorded plan, and the orphan's answer
      stepsWithoutContextDigest: 3,
      // the two plans with no recorded output, and the uncaptured tool call
      stepsWithoutActionDigest: 3,
      // 'same-1' and 'same-2' gave the same answer in one context
      sameActionContexts: 1,
      singleRunContexts: 0,
    })
  })

  it('pairs on a context digest the scorer supplies', async () => {
    // A caller that forked both runs from one checkpoint knows they share a
    // context even though the traces record different plans.
    const store = new InMemoryTraceStore()
    for (const [runId, plan] of [
      ['fork-a', 'Search the policy.'],
      ['fork-b', 'Ask a colleague.'],
    ] as const) {
      await recordRun(store, runId, 'refund-policy', [
        { kind: 'llm', name: 'plan', messages: [user('Refund window?')], output: plan },
      ])
    }
    const scorer: StepScorer = {
      appliesTo: ['llm'],
      score: (span) => ({
        kind: span.kind,
        name: span.name,
        reward: span.runId === 'fork-a' ? 0.8 : 0.3,
        determinism: 'probabilistic',
        contextDigest: 'checkpoint:refund-policy/turn-0',
      }),
    }

    const { triples } = prmTrainingPairs(await stepRewardsOf(store, scorer, ['fork-a', 'fork-b']))

    expect(triples).toHaveLength(1)
    expect(triples[0]).toMatchObject({
      contextDigest: 'checkpoint:refund-policy/turn-0',
      prefixRunId: 'fork-a',
      rejectedRunId: 'fork-b',
      prefixStepIndex: -1,
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
    // The dropped span still holds its position.
    expect(stepRewards[0]?.stepIndex).toBe(1)
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
