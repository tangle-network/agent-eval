import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import type { RunRecord } from '../run-record'
import type { LlmSpan, ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { toRewardRows, toSftRows } from './exporters'
import { mintRolloutRows } from './mint'
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
    costProvenance: { kind: 'observed', usd: 0.12 },
    tokenUsage: { input: 900, output: 100 },
    terminalOutcome: 'succeeded',
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

describe('mintRolloutRows', () => {
  it('rejects an execution-only record instead of minting a zero reward', async () => {
    const unscored = record({ outcome: { raw: {} } })
    await expect(mintRolloutRows([unscored], await seededStore())).rejects.toThrow(
      /run-1: task score is missing/,
    )
  })

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
      [record({ costUsd: null, costProvenance: { kind: 'uncaptured', usd: null } })],
      await seededStore(),
    )
    expect(rows[0]!.cost.usd).toBeNull()
  })

  it('maps root terminal outcomes without inventing completion', async () => {
    const store = await seededStore()
    const failedStore = await seededStore('run-failed')
    const incompleteStore = await seededStore('run-incomplete')
    for (const span of await failedStore.spans({ runId: 'run-failed' })) {
      await store.appendSpan(span)
    }
    for (const span of await incompleteStore.spans({ runId: 'run-incomplete' })) {
      await store.appendSpan(span)
    }

    const { rows } = await mintRolloutRows(
      [
        record({ terminalOutcome: 'unknown' }),
        record({
          runId: 'run-failed',
          terminalOutcome: 'failed',
          terminalFailureReason: 'worker exited 1',
        }),
        record({
          runId: 'run-incomplete',
          terminalOutcome: 'incomplete',
          terminalFailureReason: 'time limit',
        }),
      ],
      store,
    )

    expect(rows[0]!.outcome).toMatchObject({
      is_completed: false,
      is_truncated: false,
      error: null,
    })
    expect(rows[1]!.outcome).toMatchObject({
      is_completed: true,
      is_truncated: false,
      error: 'worker exited 1',
    })
    expect(rows[2]!.outcome).toMatchObject({
      is_completed: false,
      is_truncated: true,
      error: 'time limit',
    })
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

/**
 * Records serialized before agent-eval 0.126, replayed through the mint door.
 *
 * `costProvenance`, `terminalOutcome` and `scenarioId` were OPTIONAL up to
 * 0.125 and became REQUIRED in 0.126 without a single byte on disk changing.
 * A caller who persisted a ledger under 0.125 therefore holds records the
 * TYPE claims are complete and the BYTES are not — which is why every case
 * below builds its record by deleting a key from a well-formed one and
 * casting. That cast is not a test convenience; it is the exact shape of what
 * `mintRolloutRows` is handed in production, and it typechecks on the caller's
 * side for the same reason.
 */
describe('the mint door on records older than the type', () => {
  /** Drop `paths` (dot-notated) from a copy of `rec`, keeping the RunRecord type. */
  const without = (rec: RunRecord, ...paths: string[]): RunRecord => {
    const copy = structuredClone(rec) as unknown as Record<string, unknown>
    for (const path of paths) {
      const keys = path.split('.')
      let target = copy
      for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
      delete target[keys[keys.length - 1]!]
    }
    return copy as unknown as RunRecord
  }

  const mintError = async (rec: RunRecord): Promise<unknown> =>
    mintRolloutRows([rec], await seededStore()).then(
      () => undefined,
      (e: unknown) => e,
    )

  it('refuses a record with no costProvenance by name, not with a TypeError', async () => {
    // `costUsd: 0` verbatim: the documented 0.125 sentinel for "no bill captured".
    const err = await mintError(without(record({ costUsd: 0 }), 'costProvenance'))
    expect(err).toBeInstanceOf(ValidationError)
    expect(err).not.toBeInstanceOf(TypeError)
    expect((err as Error).message).toContain('run-1')
    expect((err as Error).message).toMatch(/costProvenance is missing/)
  })

  it('names the release the field arrived in and the exact backfill, costUsd included', async () => {
    const err = await mintError(without(record({ costUsd: 0 }), 'costProvenance'))
    const message = (err as Error).message
    expect(message).toMatch(/0\.126/)
    expect(message).toMatch(/\{ kind: 'uncaptured', usd: null \}/)
    // Backfilling provenance alone leaves a record `validateRunRecord` rejects:
    // an uncaptured cost requires `costUsd: null`, not the legacy 0.
    expect(message).toMatch(/costUsd: null/)
  })

  it('never mints cost.usd 0 out of a bill nobody captured', async () => {
    // Restoring `record.costProvenance?.kind` — the 0.125 spelling — would let
    // this record mint with `cost.usd: 0`, publishing the sentinel as a
    // measured dollar amount into a training dataset. Refusing is the fix;
    // running again with a false number is not.
    const stale = without(record({ costUsd: 0 }), 'costProvenance')
    await expect(mintRolloutRows([stale], await seededStore())).rejects.toBeInstanceOf(
      ValidationError,
    )

    // Backfilled the way the refusal instructs, the same run mints an honest gap.
    const { rows } = await mintRolloutRows(
      [record({ costUsd: null, costProvenance: { kind: 'uncaptured', usd: null } })],
      await seededStore(),
    )
    expect(rows[0]!.cost.usd).toBeNull()
    expect(rows[0]!.cost.usd).not.toBe(0)
  })

  it('refuses a record with no terminalOutcome instead of asserting is_completed', async () => {
    // Published 0.133.3 mints this record: `terminalOutcome` is compared with
    // `===` rather than dereferenced, so an absent value silently yields
    // `is_completed: false, is_truncated: false, error: null` — three claims
    // about how a run ended, made from no evidence. Safe by accident is not safe.
    const err = await mintError(without(record(), 'terminalOutcome'))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toMatch(/terminalOutcome is missing/)
    // 'unknown' is a real terminal value; a producer with no root-run evidence
    // writes it deliberately. The refusal has to say so, or the caller guesses.
    expect((err as Error).message).toMatch(/unknown/)
  })

  it('refuses a record with no tokenUsage rather than counting 0 tokens', async () => {
    const err = await mintError(without(record(), 'tokenUsage'))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toMatch(/tokenUsage is missing/)
  })

  it('refuses a record with no outcome, ahead of the task-score guard', async () => {
    // `requireTaskScore` reads `record.outcome.searchScore` on its way to the
    // answer, so an absent `outcome` is a TypeError inside the guard that
    // exists to produce a clean refusal. Field presence is checked first.
    const err = await mintError(without(record(), 'outcome'))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toMatch(/outcome is missing/)
  })

  it('refuses a record with no outcome.raw instead of minting an empty metrics bag', async () => {
    // `{ ...record.outcome.raw }` spreads `undefined` without complaint, so this
    // one mints today with `metrics: {}` — "the run reported no metrics", which
    // is a different claim from "this record predates the field".
    const err = await mintError(without(record(), 'outcome.raw'))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toMatch(/outcome\.raw is missing/)
  })

  it('refuses a record with no scenarioId, naming the record and not the line', async () => {
    const err = await mintError(without(record(), 'scenarioId'))
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toMatch(/scenarioId is missing/)
    // The schema already rejects the built line's empty `task.instance_id`, but
    // it names the LINE. The caller has to fix the RECORD.
    expect((err as Error).message).toMatch(/instance_id/)
  })

  it('names every missing field in one refusal, so a stale store is fixed in one pass', async () => {
    const err = await mintError(
      without(record({ costUsd: 0 }), 'costProvenance', 'terminalOutcome', 'tokenUsage'),
    )
    const message = (err as Error).message
    expect(message).toMatch(/costProvenance is missing/)
    expect(message).toMatch(/terminalOutcome is missing/)
    expect(message).toMatch(/tokenUsage is missing/)
  })

  it('refuses on the untraced path too — the guard sits on the only door', async () => {
    // `mintRolloutRows` builds gap lines through a second call to `mintLine`.
    // A guard on one branch is a guard a caller can route around.
    const untraced = without(record({ runId: 'run-untraced', costUsd: 0 }), 'costProvenance')
    await expect(mintRolloutRows([untraced], await seededStore())).rejects.toThrow(
      /costProvenance is missing/,
    )
  })

  it('still mints a well-formed record — the guard refuses gaps, not records', async () => {
    const { rows } = await mintRolloutRows([record()], await seededStore())
    expect(rows).toHaveLength(1)
    expect(validateRolloutLine(rows[0]!)).toEqual([])
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

  it('toSftRows excludes failed and unknown-terminal trajectories', async () => {
    const store = await seededStore()
    const failedStore = await seededStore('run-failed')
    const unknownStore = await seededStore('run-unknown')
    for (const span of await failedStore.spans({ runId: 'run-failed' })) {
      await store.appendSpan(span)
    }
    for (const span of await unknownStore.spans({ runId: 'run-unknown' })) {
      await store.appendSpan(span)
    }
    const { rows } = await mintRolloutRows(
      [
        record({ splitTag: 'search' }),
        record({
          runId: 'run-failed',
          splitTag: 'search',
          terminalOutcome: 'failed',
          terminalFailureReason: 'worker exited 1',
        }),
        record({ runId: 'run-unknown', splitTag: 'search', terminalOutcome: 'unknown' }),
      ],
      store,
    )

    expect(toSftRows(rows).map((row) => row.metadata.run_id)).toEqual(['run-1'])
    expect(toRewardRows(rows).map((row) => row.metadata.run_id)).toEqual(['run-1'])
  })

  it('holdout-split minted lines never reach SFT even at reward 1', async () => {
    const { rows } = await mintRolloutRows([record()], await seededStore())
    expect(rows[0]!.task.split).toBe('holdout')
    expect(toSftRows(rows)).toHaveLength(0)
  })

  it('toRewardRows excludes non-positive quality by default', async () => {
    const { rows } = await mintRolloutRows(
      [record({ outcome: { holdoutScore: 0, raw: {} } })],
      await seededStore(),
    )
    const reward = toRewardRows(rows)
    expect(reward).toEqual([])
  })
})
