import { describe, expect, it } from 'vitest'
import { mintRolloutRows } from '../rollout/mint'
import { assertMinted, type MintedRolloutLine } from '../rollout/schema'
import type { RunRecord } from '../run-record'
import { InMemoryTraceStore } from '../trace/store'
import { extractPreferences, toTRLFormat } from './preferences'

// Preferences are ordered only from validated minted rewards. Ungated, a gamed
// run with an inflated score becomes the chosen side and DPO learns to prefer
// the gaming trajectory over its honest sibling.

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
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 1, output: 1 },
    terminalOutcome: 'succeeded',
    splitTag: 'search',
    scenarioId: args.scenarioId,
    outcome: {
      searchScore: args.score,
      raw: {},
      ...(args.gated === true ? { realness: { score: 0, gated: true, reason: 'faked' } } : {}),
    },
  }
}

async function mint(records: RunRecord[]): Promise<MintedRolloutLine[]> {
  const { rows } = await mintRolloutRows(records, new InMemoryTraceStore())
  return rows
}

describe('extractPreferences', () => {
  const records = [
    rec({ runId: 'a-0', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.5 }),
    rec({ runId: 'b-0', candidateId: 'b', scenarioId: 's', seed: 0, score: 0.8 }),
  ]

  it('produces a preference from matching scored lines', async () => {
    const report = extractPreferences(await mint(records))
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]?.chosenVariantId).toBe('b')
    expect(report.pairs[0]?.seed).toBe(0)
  })

  it('sinks a realness-gated line to `rejected`', async () => {
    const gamed = [
      rec({ runId: 'honest', candidateId: 'a', scenarioId: 's', seed: 0, score: 0.6 }),
      rec({ runId: 'gamed', candidateId: 'b', scenarioId: 's', seed: 0, score: 1, gated: true }),
    ]
    const fromLines = extractPreferences(await mint(gamed), {})
    expect(fromLines.pairs[0]?.chosenRunId).toBe('honest')
    expect(fromLines.pairs[0]?.rejectedRunId).toBe('gamed')
    expect(fromLines.pairs[0]?.scores).toEqual({ chosen: 0.6, rejected: 0 })
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

  it('pairs only the search split by default and gates holdout behind the named opt-in', async () => {
    const holdoutRuns = records.map((r) => ({
      ...r,
      splitTag: 'holdout' as const,
      outcome: { holdoutScore: r.outcome.searchScore, raw: {} },
    }))
    const lines = await mint(holdoutRuns)
    expect(extractPreferences(lines, {}).pairs).toHaveLength(0) // default split: search
    expect(() => extractPreferences(lines, { split: 'holdout' })).toThrow(
      /allowHeldOutTrainingData: true/,
    )
    expect(
      extractPreferences(lines, { split: 'holdout', allowHeldOutTrainingData: true }).pairs,
    ).toHaveLength(1)
    expect(() => extractPreferences(lines, { split: 'dev' })).toThrow(/evaluation-only/)
  })

  it('toTRLFormat rows carry completion TEXT, never prompt hashes', async () => {
    // TRL's DPODataset contract: chosen/rejected are the two completions. A
    // trainer fed hashes would optimize the policy toward emitting hex digests.
    const lines = await mint(records)
    const { pairs } = extractPreferences(lines)
    const lookups = {
      promptOf: () => 'shared prompt text',
      completionOf: (runId: string) => `completion-of-${runId}`,
    }
    const rows = await toTRLFormat(pairs, lookups, { lines })
    expect(rows).toEqual([
      {
        prompt: 'shared prompt text',
        chosen: 'completion-of-b-0',
        rejected: 'completion-of-a-0',
      },
    ])
    // The prompt hashes the triple carries (`p-a` / `p-b`) appear nowhere.
    expect(JSON.stringify(rows)).not.toContain('p-a')
    expect(JSON.stringify(rows)).not.toContain('p-b')
  })

  it('toTRLFormat fails loud when the two sides resolve to different prompts', async () => {
    const lines = await mint(records)
    const { pairs } = extractPreferences(lines)
    const lookups = {
      promptOf: (runId: string) => `prompt-of-${runId}`, // lookup bug: differs per side
      completionOf: (runId: string) => `completion-of-${runId}`,
    }
    await expect(toTRLFormat(pairs, lookups, { lines })).rejects.toThrow(
      /resolves to different prompts/,
    )
  })
})
