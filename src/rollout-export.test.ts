import { describe, expect, it } from 'vitest'
import { mintRolloutRows, rolloutReward, toJsonl, toRewardRows, toSftRows } from './rollout-export'
import type { RunRecord } from './run-record'
import type { LlmSpan, ToolSpan } from './trace/schema'
import { InMemoryTraceStore } from './trace/store'

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
  it('joins RunRecord identity with trace steps and the final conversation', async () => {
    const { rows, missingTraces } = await mintRolloutRows([record()], await seededStore())
    expect(missingTraces).toEqual([])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.format).toBe('tangle.rollout.v1')
    expect(row.candidateId).toBe('stripe-steer@v0')
    expect(row.splitTag).toBe('holdout')
    expect(row.totalTokens).toBe(1000)
    expect(row.steps.map((s) => s.kind)).toEqual(['llm', 'tool'])
    // conversation = final llm span messages + its output as assistant turn
    expect(row.conversation.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
  })

  it('reports records with no spans in missingTraces instead of dropping them silently', async () => {
    const { rows, missingTraces } = await mintRolloutRows(
      [record(), record({ runId: 'run-untraced' })],
      await seededStore(),
    )
    expect(rows).toHaveLength(1)
    expect(missingTraces).toEqual(['run-untraced'])
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
    expect(rows[0]!.steps.map((s) => s.name)).toEqual(['t0', 't1', 't8', 't9'])
  })
})

describe('exports', () => {
  it('toSftRows keeps only clean successes (gated rows never qualify)', async () => {
    const store = await seededStore()
    const gatedStore = await seededStore('run-gated')
    for (const span of await gatedStore.spans({ runId: 'run-gated' })) await store.appendSpan(span)
    const { rows } = await mintRolloutRows(
      [
        record(),
        record({
          runId: 'run-gated',
          outcome: { holdoutScore: 1, raw: {}, realness: { score: 1, gated: true } },
        }),
      ],
      store,
    )
    const sft = toSftRows(rows)
    expect(sft).toHaveLength(1)
    expect(sft[0]!.metadata.runId).toBe('run-1')
    expect(sft[0]!.messages.at(-1)!.role).toBe('assistant')
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
  })

  it('toJsonl emits one object per line with a trailing newline', () => {
    const out = toJsonl([{ a: 1 }, { b: 2 }])
    expect(out).toBe('{"a":1}\n{"b":2}\n')
    expect(toJsonl([])).toBe('')
  })
})
