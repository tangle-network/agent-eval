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

// Pins the structural guarantee: the primary training-data exporters take
// `RolloutLine[]`, whose reward is written once (by mint) with the realness
// gate applied. The deprecated `RunRecord[]` signatures are implemented over
// the records with the shared training-row eligibility rule, which DROPS a
// gamed run outright. Either way, a regression here means a gamed success is
// back in the training file at a positive reward.

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

describe('toGrpoRows — line path vs deprecated RunRecord path', () => {
  it('keeps a realness-gated rollout in its group at reward 0 on the LINE path', async () => {
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

  it('drops a realness-gated run outright on the RECORD path — never at a positive reward', async () => {
    const records = [
      rec({ runId: 'honest-1', scenarioId: 's', score: 0.4, candidateId: 'A' }),
      rec({ runId: 'honest-2', scenarioId: 's', score: 0.6, candidateId: 'B' }),
      rec({ runId: 'gamed', scenarioId: 's', score: 1, candidateId: 'C', gated: true }),
    ]
    const rows = await toGrpoRows(records, lookups)
    expect(rows[0]?.runIds).toEqual(['honest-1', 'honest-2'])
    expect(rows[0]?.rewards).toEqual([0.4, 0.6])
  })

  it('gates a custom rewardOf on the deprecated path', async () => {
    const honestA = rec({ runId: 'ha', scenarioId: 's', score: 0.5, candidateId: 'A' })
    const honestB = rec({ runId: 'hb', scenarioId: 's', score: 0.4, candidateId: 'B' })
    const gamed = rec({ runId: 'gamed', scenarioId: 's', score: 1, candidateId: 'C', gated: true })
    honestA.outcome.raw.bonus = 0.3
    honestB.outcome.raw.bonus = 0.2
    gamed.outcome.raw.bonus = 0.9
    const rows = await toGrpoRows([honestA, honestB, gamed], {
      ...lookups,
      rewardOf: (r) => r.outcome.raw.bonus ?? 0,
    })
    // The hook is honoured for honest runs and gated for the gamed one, which
    // the eligibility rule then removes entirely: 0.9 never ships.
    expect(rows[0]?.runIds).toEqual(['ha', 'hb'])
    expect(rows[0]?.rewards).toEqual([0.3, 0.2])
  })

  it('never turns an unscored run into a reward 0 — skipped by records, refused by mint', async () => {
    const records = [rec({ runId: 'unscored', scenarioId: 's' })]
    expect(await toGrpoRows(records, lookups)).toEqual([])
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

describe('toSftRows — line path vs deprecated RunRecord path', () => {
  it('emits matching conversational rows from lines and from records (ungated)', async () => {
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
    expect(fromLines.map((r) => r.meta?.runId)).toEqual(['honest'])
    expect(fromRecords.map((r) => r.meta?.runId)).toEqual(['honest'])
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
    // Named opt-in: the same rule the record path and rollout/exporters use.
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

  it('keeps the deprecated RunRecord-typed include/systemOf callbacks working', async () => {
    const records = [
      rec({ runId: 'good', scenarioId: 's', score: 0.95 }),
      rec({ runId: 'bad', scenarioId: 's', score: 0.2 }),
    ]
    const rows = await toSftRows(records, {
      ...lookups,
      systemOf: (r) => `system-for-${r.candidateId}`,
      include: (r) => (r.outcome.searchScore ?? 0) >= 0.5,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.messages[0]).toEqual({ role: 'system', content: 'system-for-A' })
  })

  it('omits the score key for an unlabeled LINE (a labeled gap, not a zero)', async () => {
    // Mint refuses unscored records, but unlabeled LINES exist (interchange
    // imports); the line path emits them with the score key absent.
    const base = fixtureRolloutLine()
    const unlabeled = fixtureRolloutLine({
      outcome: { ...base.outcome, reward: null, reward_source: 'run-record/unscored' },
    })
    const [row] = await toSftRows([unlabeled], lookups)
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
