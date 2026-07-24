import { describe, expect, it } from 'vitest'
import { mintRolloutRows } from '../rollout/mint'
import { assertMinted, type MintedRolloutLine } from '../rollout/schema'
import type { RunRecord } from '../run-record'
import { InMemoryTraceStore } from '../trace/store'
import { extractPreferences } from './preferences'

// Pins the preference-extraction retype: the `RolloutLine[]` path and the
// deprecated `RunRecord[]` path run the same pairing code, and both order the
// pair on the GATED score. Ungated, a gamed run with an inflated score becomes
// the `chosen` side and DPO learns to prefer the gaming trajectory over its
// honest sibling — the exact inversion this test exists to catch.

function rec(args: {
  runId: string
  candidateId: string
  scenarioId: string
  seed: number
  score: number
  gated?: boolean
}): RunRecord {
  return {
    runId: args.runId,
    experimentId: 'exp',
    candidateId: args.candidateId,
    seed: args.seed,
    model: 'm@1',
    promptHash: `p-${args.candidateId}`,
    configHash: `c-${args.candidateId}`,
    commitSha: 'abcd',
    wallMs: 100,
    costUsd: 0.01,
    tokenUsage: { input: 1, output: 1 },
    splitTag: 'holdout',
    scenarioId: args.scenarioId,
    outcome: {
      holdoutScore: args.score,
      raw: {},
      ...(args.gated === true ? { realness: { score: 0, gated: true, reason: 'faked' } } : {}),
    },
  }
}

async function mint(records: RunRecord[]): Promise<MintedRolloutLine[]> {
  const { rows } = await mintRolloutRows(records, new InMemoryTraceStore())
  return rows
}

describe('extractPreferences — lines vs deprecated records', () => {
  const records = [
    rec({ runId: 'a-0', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.5 }),
    rec({ runId: 'b-0', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.8 }),
  ]

  it('produces the same report from lines and from records (ungated)', async () => {
    const fromLines = extractPreferences(await mint(records), {})
    const fromRecords = extractPreferences(records, {})
    expect(fromLines.pairs).toEqual(fromRecords.pairs)
    expect(fromRecords.pairs).toHaveLength(1)
    expect(fromRecords.pairs[0]?.chosenVariantId).toBe('b')
    expect(fromRecords.pairs[0]?.seed).toBe(0)
  })

  it('sinks a realness-gated run to `rejected` on BOTH paths', async () => {
    const gamed = [
      rec({ runId: 'honest', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.6 }),
      rec({ runId: 'gamed', candidateId: 'b', scenarioId: 's', seed: 0, score: 1, gated: true }),
    ]
    const fromLines = extractPreferences(await mint(gamed), {})
    const fromRecords = extractPreferences(gamed, {})
    expect(fromLines.pairs).toEqual(fromRecords.pairs)
    expect(fromRecords.pairs[0]?.chosenRunId).toBe('honest')
    expect(fromRecords.pairs[0]?.rejectedRunId).toBe('gamed')
    expect(fromRecords.pairs[0]?.scores).toEqual({ chosen: 0.6, rejected: 0 })
  })

  it('gates a custom rewardOf, so a gamed run cannot become the CHOSEN side', () => {
    // The hole this pins: `rewardOf` used to be called and its number used
    // verbatim, so a caller driving preferences off a raw signal handed DPO a
    // pair whose chosen completion came from the run the gate had flagged.
    // Identical to the same-named hook on `toGrpoRows`, which already gated.
    const gamed = [
      rec({ runId: 'honest', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.9 }),
      rec({ runId: 'gamed', candidateId: 'b', scenarioId: 's', seed: 0, score: 1, gated: true }),
    ]
    const report = extractPreferences(gamed, {
      rewardOf: (r) => r.outcome.holdoutScore ?? null,
    })
    expect(report.pairs[0]?.chosenRunId).toBe('honest')
    expect(report.pairs[0]?.rejectedRunId).toBe('gamed')
    expect(report.pairs[0]?.scores).toEqual({ chosen: 0.9, rejected: 0 })
  })

  it('keeps a custom rewardOf working on an ungated run (the gate is on top, not instead)', () => {
    const runs = [
      rec({ runId: 'lo', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.9 }),
      rec({ runId: 'hi', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.1 }),
    ]
    runs[0]!.outcome.raw.bonus = 0.1
    runs[1]!.outcome.raw.bonus = 0.9
    const report = extractPreferences(runs, {
      rewardOf: (r) => (r.outcome.raw.bonus as number | undefined) ?? null,
    })
    // Ordered by the custom signal, not the headline score.
    expect(report.pairs[0]?.chosenRunId).toBe('hi')
    expect(report.pairs[0]?.scores).toEqual({ chosen: 0.9, rejected: 0.1 })
  })

  it('drops a run whose custom rewardOf returns null or a non-finite number', () => {
    const runs = [
      rec({ runId: 'ok', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.9 }),
      rec({ runId: 'nan', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.1 }),
    ]
    const report = extractPreferences(runs, {
      rewardOf: (r) => (r.runId === 'nan' ? Number.NaN : 0.9),
    })
    expect(report.pairs).toHaveLength(0)
    expect(report.cellsSingleton).toBe(1)
  })

  it('reports lines it cannot pair because they carry no candidate_id', async () => {
    const lines = (await mint(records)).map((line, i) =>
      // Rebuilt object → the brand is re-earned through `assertMinted`, the
      // same path any caller reconstructing a line has to take.
      i === 0 ? assertMinted({ ...line, candidate_id: null }) : line,
    )
    const report = extractPreferences(lines, {})
    expect(report.linesWithoutCandidateId).toBe(1)
    expect(report.pairs).toHaveLength(0)
  })

  it('filters lines by rollout split, not by RunRecord splitTag', async () => {
    const searchRuns = records.map((r) => ({ ...r, splitTag: 'search' as const }))
    const lines = await mint(searchRuns)
    expect(extractPreferences(lines, {}).pairs).toHaveLength(0) // default split: holdout
    expect(extractPreferences(lines, { split: 'search' }).pairs).toHaveLength(1)
  })
})
