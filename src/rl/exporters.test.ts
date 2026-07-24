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

// Pins the structural guarantee: training-data exporters take `RolloutLine[]`,
// whose reward is written once (by mint) with the realness gate applied. The
// deprecated `RunRecord[]` signatures mint internally and delegate, so they must
// produce IDENTICAL rows for an honest run — and must now zero (GRPO) or drop
// (SFT) a run the authenticity gate flagged as gamed. A regression here means a
// gamed success is back in the training file at full reward.

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
    tokenUsage: { input: 0, output: 0 },
    splitTag: 'holdout',
    scenarioId: args.scenarioId,
    outcome: {
      ...(args.score === undefined ? {} : { holdoutScore: args.score }),
      raw: {},
      ...(args.gated === true ? { realness: { score: 0, gated: true, reason: 'faked' } } : {}),
    },
  }
}

const lookups = {
  promptOf: (id: string) => `prompt-${id}`,
  completionOf: (id: string) => `completion-${id}`,
}

async function mint(records: RunRecord[]): Promise<MintedRolloutLine[]> {
  const { rows } = await mintRolloutRows(records, new InMemoryTraceStore())
  return rows
}

describe('toGrpoRows — line-based primary API vs deprecated RunRecord path', () => {
  it('produces the same rows from lines and from records (ungated)', async () => {
    const records = [
      rec({ runId: 'a-1', scenarioId: 's1', score: 0.7, candidateId: 'A' }),
      rec({ runId: 'b-1', scenarioId: 's1', score: 0.5, candidateId: 'B' }),
      rec({ runId: 'a-2', scenarioId: 's2', score: 0.9, candidateId: 'A' }),
    ]
    const fromLines = await toGrpoRows(await mint(records), lookups)
    const fromRecords = await toGrpoRows(records, lookups)
    expect(fromLines).toEqual(fromRecords)
    expect(fromLines).toHaveLength(2)
    expect(fromLines.find((r) => r.meta?.scenarioId === 's1')?.rewards).toEqual([0.7, 0.5])
  })

  it('zeroes a realness-gated run on BOTH paths (anti-Goodhart gate)', async () => {
    const records = [
      rec({ runId: 'honest', scenarioId: 's', score: 0.4, candidateId: 'A' }),
      rec({ runId: 'gamed', scenarioId: 's', score: 1, candidateId: 'B', gated: true }),
    ]
    const fromLines = await toGrpoRows(await mint(records), lookups)
    const fromRecords = await toGrpoRows(records, lookups)
    expect(fromLines).toEqual(fromRecords)
    // The gamed run stays in the group (its absence would move the baseline too)
    // but claims 0, not the 1.0 it reported.
    expect(fromRecords[0]?.runIds).toEqual(['honest', 'gamed'])
    expect(fromRecords[0]?.rewards).toEqual([0.4, 0])
  })

  it('gates a custom rewardOf on the deprecated path', async () => {
    const gamed = rec({ runId: 'gamed', scenarioId: 's', score: 1, gated: true })
    gamed.outcome.raw.bonus = 0.9
    const rows = await toGrpoRows([gamed], {
      ...lookups,
      rewardOf: (r) => r.outcome.raw.bonus ?? 0,
    })
    expect(rows[0]?.rewards).toEqual([0])
  })

  it('drops an unscored run instead of exporting it at reward 0', async () => {
    const records = [rec({ runId: 'unscored', scenarioId: 's' })]
    expect(await toGrpoRows(await mint(records), lookups)).toEqual([])
    expect(await toGrpoRows(records, lookups)).toEqual([])
  })
})

describe('toSftRows — line-based primary API vs deprecated RunRecord path', () => {
  it('produces the same rows from lines and from records (ungated)', async () => {
    const records = [
      rec({ runId: 'a', scenarioId: 's', score: 0.9 }),
      rec({ runId: 'b', scenarioId: 's', score: 0.3, candidateId: 'B' }),
    ]
    const fromLines = await toSftRows(await mint(records), lookups)
    const fromRecords = await toSftRows(records, lookups)
    expect(fromLines).toEqual(fromRecords)
    expect(fromRecords).toHaveLength(2)
    expect(fromRecords[0]?.meta).toEqual({
      runId: 'a',
      candidateId: 'A',
      scenarioId: 's',
      score: 0.9,
      model: 'm@1',
    })
  })

  it('drops a realness-gated run entirely on BOTH paths (never imitate a gamed trajectory)', async () => {
    const records = [
      rec({ runId: 'honest', scenarioId: 's', score: 0.9 }),
      rec({ runId: 'gamed', scenarioId: 's', score: 1, candidateId: 'B', gated: true }),
    ]
    const fromLines = await toSftRows(await mint(records), lookups)
    const fromRecords = await toSftRows(records, lookups)
    expect(fromLines).toEqual(fromRecords)
    expect(fromRecords.map((r) => r.meta?.runId)).toEqual(['honest'])
  })

  it('keeps the deprecated RunRecord-typed include/systemOf callbacks working', async () => {
    const records = [
      rec({ runId: 'good', scenarioId: 's', score: 0.95 }),
      rec({ runId: 'bad', scenarioId: 's', score: 0.2 }),
    ]
    const rows = await toSftRows(records, {
      ...lookups,
      systemOf: (r) => `system-for-${r.candidateId}`,
      include: (r) => (r.outcome.holdoutScore ?? 0) >= 0.5,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.messages[0]).toEqual({ role: 'system', content: 'system-for-A' })
  })

  it('omits the score key for an unscored run (a labeled gap, not a zero)', async () => {
    const records = [rec({ runId: 'unscored', scenarioId: 's' })]
    const [row] = await toSftRows(await mint(records), lookups)
    expect(row?.meta?.score).toBeUndefined()
    expect(JSON.stringify(row)).not.toContain('"score"')
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
