import { describe, expect, it } from 'vitest'
import { fixtureRolloutLine } from '../rollout/fixtures'
import { mintRolloutRows } from '../rollout/mint'
import {
  assertMinted,
  type MintedRolloutLine,
  type RolloutLine,
  type RolloutStep,
} from '../rollout/schema'
import type { RunRecord } from '../run-record'
import { InMemoryTraceStore } from '../trace/store'
import { toGrpoRows, toPrmRows, toSftRows } from './exporters'
import type { PrmTrainingTriple } from './process-reward'

// Training-data exporters accept only validated minted lines. A regression here
// means a gamed success can return to a training file at a positive reward.

function rec(args: {
  runId: string
  scenarioId: string
  score?: number
  candidateId?: string
  gated?: boolean
}): RunRecord {
  return {
    runId: args.runId,
    experimentId: 'exp',
    candidateId: args.candidateId ?? 'A',
    seed: 0,
    model: 'm@1',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abcd',
    wallMs: 1,
    costUsd: 0,
    costProvenance: { kind: 'observed', usd: 0 },
    tokenUsage: { input: 0, output: 0 },
    terminalOutcome: 'succeeded',
    splitTag: 'search',
    scenarioId: args.scenarioId,
    outcome: {
      ...(args.score === undefined ? {} : { searchScore: args.score }),
      raw: {},
      ...(args.gated === true ? { realness: { score: 0, gated: true, reason: 'faked' } } : {}),
    },
  }
}

const lookups = {
  promptOf: () => 'shared prompt',
  completionOf: (id: string) => `completion-${id}`,
}

async function mint(records: RunRecord[]): Promise<MintedRolloutLine[]> {
  const { rows } = await mintRolloutRows(records, new InMemoryTraceStore())
  return rows
}

describe('toGrpoRows', () => {
  it('keeps a realness-gated rollout in its group at reward 0', async () => {
    const records = [
      rec({ runId: 'honest', scenarioId: 's', score: 0.4, candidateId: 'A' }),
      rec({ runId: 'gamed', scenarioId: 's', score: 1, candidateId: 'B', gated: true }),
    ]
    const rows = await toGrpoRows(await mint(records), lookups)
    // The gamed rollout stays in the group (its absence would move the
    // baseline too) but claims 0, not the 1.0 it reported.
    expect(rows[0]?.runIds).toEqual(['honest', 'gamed'])
    expect(rows[0]?.rewards).toEqual([0.4, 0])
  })

  it('refuses to mint an unscored run as reward 0', async () => {
    const records = [rec({ runId: 'unscored', scenarioId: 's' })]
    await expect(mint(records)).rejects.toThrow(/task score is missing/)
  })

  it('emits no row for a single-completion scenario on the LINE path (no relative baseline)', async () => {
    // GRPO's advantage is relative to the group mean; a group of one is
    // degenerate. Mirrors the record path's `scored.length < 2` rule.
    const alone = [rec({ runId: 'solo', scenarioId: 's-solo', score: 0.7 })]
    expect(await toGrpoRows(await mint(alone), lookups)).toEqual([])
  })

  it('rejects a LINE group whose run ids resolve to different prompt text', async () => {
    const lines = await mint([
      rec({ runId: 'a', scenarioId: 's', score: 0.7 }),
      rec({ runId: 'b', scenarioId: 's', score: 0.6, candidateId: 'B' }),
    ])

    await expect(
      toGrpoRows(lines, {
        ...lookups,
        promptOf: (runId) => `prompt-${runId}`,
      }),
    ).rejects.toThrow(/resolves to different prompt text/)
  })
})

describe('toSftRows', () => {
  it('emits conversational rows from clean scored lines', async () => {
    const records = [
      rec({ runId: 'a', scenarioId: 's', score: 0.9 }),
      rec({ runId: 'b', scenarioId: 's', score: 0.3, candidateId: 'B' }),
    ]
    const rows = await toSftRows(await mint(records), lookups)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.meta).toEqual({
      runId: 'a',
      candidateId: 'A',
      scenarioId: 's',
      score: 0.9,
      model: 'm@1',
    })
  })

  it('drops a realness-gated run entirely', async () => {
    const records = [
      rec({ runId: 'honest', scenarioId: 's', score: 0.9 }),
      rec({ runId: 'gamed', scenarioId: 's', score: 1, candidateId: 'B', gated: true }),
    ]
    const rows = await toSftRows(await mint(records), lookups)
    expect(rows.map((r) => r.meta?.runId)).toEqual(['honest'])
  })

  it('keeps holdout lines out of SFT output unless the named opt-in or an explicit splitFilter says so', async () => {
    const search = rec({ runId: 'train-me', scenarioId: 's', score: 0.9 })
    const holdout: RunRecord = {
      ...rec({ runId: 'held-out', scenarioId: 's2', candidateId: 'B' }),
      splitTag: 'holdout',
      outcome: { holdoutScore: 0.8, raw: {} },
    }
    const lines = await mint([search, holdout])
    // Default: trainable splits only — holdout must not ship in train.sft.jsonl.
    expect((await toSftRows(lines, lookups)).map((r) => r.meta?.runId)).toEqual(['train-me'])
    // Named opt-in: the same rule the rollout exporters use.
    expect(
      (await toSftRows(lines, { ...lookups, allowHeldOutTrainingData: true })).map(
        (r) => r.meta?.runId,
      ),
    ).toEqual(['train-me', 'held-out'])
    // Explicit selection replaces the default rule (e.g. a holdout eval bundle).
    expect(
      (await toSftRows(lines, { ...lookups, splitFilter: ['holdout'] })).map((r) => r.meta?.runId),
    ).toEqual(['held-out'])
  })

  it('applies line-typed include and system callbacks', async () => {
    const records = [
      rec({ runId: 'good', scenarioId: 's', score: 0.95 }),
      rec({ runId: 'bad', scenarioId: 's', score: 0.2 }),
    ]
    const rows = await toSftRows(await mint(records), {
      ...lookups,
      systemOf: (line) => `system-for-${line.candidate_id}`,
      include: (line) => (line.outcome.reward ?? 0) >= 0.5,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.messages[0]).toEqual({ role: 'system', content: 'system-for-A' })
  })

  it('excludes an unlabeled line rather than treating it as a zero', async () => {
    // Unlabeled lines can arrive through interchange imports even though mint
    // refuses unscored records.
    const base = fixtureRolloutLine()
    const unlabeled = fixtureRolloutLine({
      outcome: { ...base.outcome, reward: null, reward_source: 'run-record/unscored' },
    })
    expect(await toSftRows([unlabeled], lookups)).toEqual([])
  })
})

// ── PRM ──────────────────────────────────────────────────────────────────

const STEP: RolloutStep = { kind: 'tool', name: 'compile', status: 'ok' }

function prmLine(overrides: Partial<RolloutLine> & { run_id: string }): MintedRolloutLine {
  return fixtureRolloutLine({ steps: [STEP, STEP, STEP], ...overrides })
}

const prmTriple: PrmTrainingTriple = {
  prefixRunId: 'chosen-run',
  prefixStepIndex: 1,
  chosenSpanId: 'chosen-step',
  chosenReward: 0.9,
  rejectedSpanId: 'rejected-step',
  rejectedReward: 0.3,
  rejectedRunId: 'rejected-run',
  marginScore: 0.6,
}

const prmLookups = {
  promptOf: (id: string) => `p:${id}`,
  stepTextOf: (rid: string, sid: string) => `step:${rid}/${sid}`,
}

describe('toPrmRows — fail loud on a trajectory that was never fully captured', () => {
  const ok = [prmLine({ run_id: 'chosen-run' }), prmLine({ run_id: 'rejected-run' })]

  it('exports when every referenced line carries complete steps', async () => {
    const rows = await toPrmRows([prmTriple], prmLookups, { lines: ok })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.chosenStep).toBe('step:chosen-run/chosen-step')
  })

  it('throws when a line carries no steps', async () => {
    const lines = [prmLine({ run_id: 'chosen-run', steps: [] }), ok[1]!]
    await expect(toPrmRows([prmTriple], prmLookups, { lines })).rejects.toThrow(/carries no steps/)
  })

  it('throws on a gap line (no trajectory was captured at all)', async () => {
    const lines = [
      prmLine({
        run_id: 'chosen-run',
        provenance: {
          captured_at: '2026-07-23T00:00:00.000Z',
          capture: 'mint',
          gap: 'no trace spans recorded for this runId',
        },
      }),
      ok[1]!,
    ]
    await expect(toPrmRows([prmTriple], prmLookups, { lines })).rejects.toThrow(/is a gap line/)
  })

  it('throws when the steps may have been capped by mint (silent middle drop)', async () => {
    await expect(
      toPrmRows([prmTriple], prmLookups, { lines: ok, mintedWithMaxSteps: 3 }),
    ).rejects.toThrow(/at the mint cap of 3/)
    // One under the cap is provably intact.
    await expect(
      toPrmRows([prmTriple], prmLookups, { lines: ok, mintedWithMaxSteps: 4 }),
    ).resolves.toHaveLength(1)
  })

  it('throws on a truncated trajectory', async () => {
    const truncated = prmLine({ run_id: 'chosen-run' })
    const lines = [
      assertMinted({ ...truncated, outcome: { ...truncated.outcome, is_truncated: true } }),
      ok[1]!,
    ]
    await expect(toPrmRows([prmTriple], prmLookups, { lines })).rejects.toThrow(/marked truncated/)
  })

  it('throws when a referenced run has no line (gate status unknown)', async () => {
    await expect(toPrmRows([prmTriple], prmLookups, { lines: [ok[0]!] })).rejects.toThrow(
      /no rollout line supplied for run rejected-run/,
    )
  })

  it('drops a triple whose evidence is realness-gated', async () => {
    const gamed = prmLine({ run_id: 'chosen-run' })
    // reward 0 alongside `realness_gated: true`: the fixture's reward of 1 is
    // now an invalid line, and `assertMinted` says so rather than letting the
    // impossible combination sit in a test as if it were reachable.
    const lines = [
      assertMinted({
        ...gamed,
        outcome: { ...gamed.outcome, reward: 0, realness_gated: true },
      }),
      ok[1]!,
    ]
    expect(await toPrmRows([prmTriple], prmLookups, { lines })).toEqual([])
  })

  it('refuses to export without a line context — it cannot see the gate there', async () => {
    // The two-argument form used to emit rows with NO gate applied: a
    // `PrmTrainingTriple` carries a bare `chosenReward` number and no way to
    // learn that the step it came from belongs to a run that faked its success,
    // so a process-reward model was trained to prefer the gaming move at the
    // exact step the gaming happened. The overload is gone (TypeScript callers
    // now fail to compile); the cast models the JavaScript caller the runtime
    // throw exists for.
    const untyped = toPrmRows as unknown as (
      triples: PrmTrainingTriple[],
      lookups: typeof prmLookups,
    ) => Promise<unknown>
    await expect(untyped([prmTriple], prmLookups)).rejects.toThrow(/a PrmLineContext is required/)
  })
})
