import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../run-record'
import type { LlmSpan, ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { toRewardRows, toSftRows } from './exporters'
import { mintRolloutRows, rolloutReward } from './mint'
import { validateRolloutLine } from './schema'

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    experimentId: 'exp-1',
    candidateId: 'stripe-steer@v0',
    seed: 7,
    model: 'glm-5.2@2026-05-01',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: 1000,
    costUsd: 0.12,
    tokenUsage: { input: 900, output: 100 },
    outcome: { holdoutScore: 1, raw: {} },
    splitTag: 'holdout',
    scenarioId: 'stripe-checkout-session',
    ...overrides,
  }
}

async function seededStore(runId = 'run-1'): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore()
  const llm: LlmSpan = {
    spanId: 's1',
    runId,
    kind: 'llm',
    name: 'coder',
    startedAt: 0,
    endedAt: 500,
    model: 'glm-5.2@2026-05-01',
    messages: [
      { role: 'system', content: 'You are a Stripe integrator. key=sk_live_SECRET' },
      { role: 'user', content: 'Create a checkout session.' },
    ],
    output: 'Done: created via ui_mode=embedded_page.',
  }
  const tool: ToolSpan = {
    spanId: 's2',
    parentSpanId: 's1',
    runId,
    kind: 'tool',
    name: 'bash',
    startedAt: 100,
    endedAt: 200,
    toolName: 'bash',
    args: { cmd: 'curl -H "Authorization: Bearer sk_live_SECRET" …' },
    result: { status: 200 },
  }
  await store.appendSpan(llm)
  await store.appendSpan(tool)
  return store
}

describe('rolloutReward', () => {
  it('prefers holdoutScore and passes through when un-gated', () => {
    expect(rolloutReward(record())).toEqual({ reward: 1, gated: false })
  })

  it('forces reward to 0 when realness-gated, regardless of score', () => {
    const gated = record({
      outcome: { holdoutScore: 1, raw: {}, realness: { score: 0.9, gated: true } },
    })
    expect(rolloutReward(gated)).toEqual({ reward: 0, gated: true })
  })
})

describe('mintRolloutRows', () => {
  it('joins RunRecord identity with trace steps into a valid tangle.rollout.v1 line', async () => {
    const { rows, missingTraces } = await mintRolloutRows([record()], await seededStore())
    expect(missingTraces).toEqual([])
    expect(rows).toHaveLength(1)
    const line = rows[0]!
    expect(validateRolloutLine(line)).toEqual([])
    expect(line.schema).toBe('tangle.rollout.v1')
    expect(line.run_id).toBe('run-1')
    expect(line.experiment_id).toBe('exp-1')
    expect(line.candidate_id).toBe('stripe-steer@v0')
    expect(line.role).toBe('agent')
    expect(line.task).toEqual({
      suite: 'exp-1',
      instance_id: 'stripe-checkout-session',
      split: 'holdout',
      seed: 7,
      rep: 0,
    })
    expect(line.policy.model).toBe('glm-5.2@2026-05-01')
    expect(line.policy.profile_commit).toBe('deadbeef')
    expect(line.policy.prompt_hash).toBe('p'.repeat(64))
    expect(line.outcome.reward).toBe(1)
    expect(line.outcome.reward_source).toBe('run-record/holdout-score')
    expect(line.outcome.realness_gated).toBe(false)
    expect(line.cost).toEqual({
      usd: 0.12,
      tokens_in: 900,
      tokens_out: 100,
      tokens_reasoning: null,
      cache_read: null,
      cache_write: null,
      wall_s: 1,
    })
    expect(line.steps!.map((s) => s.kind)).toEqual(['llm', 'tool'])
    // conversation = final llm span messages + its output as assistant turn
    expect(line.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(line.provenance.capture).toBe('mint')
  })

  it('emits records with no spans as labeled gap lines AND lists them in missingTraces', async () => {
    const { rows, missingTraces } = await mintRolloutRows(
      [record(), record({ runId: 'run-untraced' })],
      await seededStore(),
    )
    expect(rows).toHaveLength(2)
    expect(missingTraces).toEqual(['run-untraced'])
    const gap = rows[1]!
    expect(validateRolloutLine(gap)).toEqual([])
    expect(gap.messages).toEqual([])
    expect(gap.provenance.gap).toMatch(/no trace spans/)
  })

  it('reports an uncaptured cost as null, never a fake zero', async () => {
    const { rows } = await mintRolloutRows(
      [record({ costUsd: 0, costProvenance: { kind: 'uncaptured', usd: null } })],
      await seededStore(),
    )
    expect(rows[0]!.cost.usd).toBeNull()
  })

  it('applies the scrubber to every exported string', async () => {
    const scrub = (t: string): string => t.replaceAll(/sk_live_[A-Za-z0-9]+/g, '[redacted]')
    const { rows } = await mintRolloutRows([record()], await seededStore(), { scrub })
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain('sk_live_SECRET')
    expect(serialized).toContain('[redacted]')
  })

  it('caps steps head+tail under maxSteps', async () => {
    const store = new InMemoryTraceStore()
    for (let i = 0; i < 10; i++) {
      await store.appendSpan({
        spanId: `s${i}`,
        runId: 'run-1',
        kind: 'tool',
        name: `t${i}`,
        startedAt: i,
        endedAt: i + 1,
        toolName: `t${i}`,
        args: {},
      } as ToolSpan)
    }
    const { rows } = await mintRolloutRows([record()], store, { maxSteps: 4 })
    expect(rows[0]!.steps!.map((s) => s.name)).toEqual(['t0', 't1', 't8', 't9'])
  })
})

describe('minted lines through the exporters', () => {
  it('toSftRows keeps only clean successes (gated runs never qualify)', async () => {
    const store = await seededStore()
    const gatedStore = await seededStore('run-gated')
    for (const span of await gatedStore.spans({ runId: 'run-gated' })) await store.appendSpan(span)
    const { rows } = await mintRolloutRows(
      [
        record({ splitTag: 'search' }),
        record({
          runId: 'run-gated',
          splitTag: 'search',
          outcome: { holdoutScore: 1, raw: {}, realness: { score: 1, gated: true } },
        }),
      ],
      store,
    )
    const sft = toSftRows(rows)
    expect(sft).toHaveLength(1)
    expect(sft[0]!.metadata.run_id).toBe('run-1')
    expect(sft[0]!.messages.at(-1)!.role).toBe('assistant')
  })

  it('holdout-split minted lines never reach SFT even at reward 1', async () => {
    const { rows } = await mintRolloutRows([record()], await seededStore())
    expect(rows[0]!.task.split).toBe('holdout')
    expect(toSftRows(rows)).toHaveLength(0)
  })

  it('toRewardRows keeps failures as signal with their scalar reward', async () => {
    const { rows } = await mintRolloutRows(
      [record({ outcome: { holdoutScore: 0, raw: {} } })],
      await seededStore(),
    )
    const reward = toRewardRows(rows)
    expect(reward).toHaveLength(1)
    expect(reward[0]!.reward).toBe(0)
    expect(reward[0]!.prompt).toBe('Create a checkout session.')
    expect(reward[0]!.steps).toHaveLength(2)
  })
})
