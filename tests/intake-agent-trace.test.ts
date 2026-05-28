import { describe, expect, it } from 'vitest'
import { analyzeRuns } from '../src/contract/analyze-runs'
import {
  type AgentTraceRecord,
  parseAgentTrace,
  partitionRunsByAuthoringModel,
} from '../src/contract/intake/agent-trace'
import type { RunRecord } from '../src/run-record'

const SHA_OPUS = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
const SHA_GPT = 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1'

/** The spec's own example record (github.com/cursor/agent-trace §6.2),
 *  extended with a second file authored by a different model. */
const SPEC_EXAMPLE: AgentTraceRecord = {
  version: '0.1.0',
  id: '550e8400-e29b-41d4-a716-446655440000',
  timestamp: '2026-01-23T14:30:00Z',
  vcs: { type: 'git', revision: SHA_OPUS },
  tool: { name: 'cursor', version: '2.4.0' },
  files: [
    {
      path: 'src/utils/parser.ts',
      conversations: [
        {
          url: 'https://api.cursor.com/v1/conversations/12345',
          contributor: { type: 'ai', model_id: 'anthropic/claude-opus-4-5-20251101' },
          ranges: [{ start_line: 42, end_line: 67, content_hash: 'murmur3:9f2e8a1b' }],
        },
      ],
    },
    {
      path: 'src/utils/helpers.ts',
      conversations: [
        {
          contributor: { type: 'ai', model_id: 'openai/gpt-4o' },
          ranges: [{ start_line: 1, end_line: 10 }],
        },
      ],
    },
  ],
}

function run(id: string, commitSha: string, score: number): RunRecord {
  return {
    runId: id,
    experimentId: 'exp',
    candidateId: 'cand',
    seed: 0,
    model: 'harness@v',
    promptHash: 'sha256:p',
    configHash: 'sha256:c',
    commitSha,
    wallMs: 10,
    costUsd: 0.01,
    tokenUsage: { input: 100, output: 50 },
    outcome: { holdoutScore: score, raw: {} },
    splitTag: 'holdout',
  }
}

describe('parseAgentTrace — code-provenance index keyed by commit SHA', () => {
  it('extracts the authoring models, tool, and aggregates per revision', () => {
    const index = parseAgentTrace([SPEC_EXAMPLE])
    const p = index.get(SHA_OPUS)
    expect(p).toBeDefined()
    expect(p!.aiModels).toEqual(['anthropic/claude-opus-4-5-20251101', 'openai/gpt-4o'])
    expect(p!.tools).toEqual(['cursor'])
    expect(p!.fileCount).toBe(2)
    expect(p!.conversationCount).toBe(2)
    expect(p!.lineCount).toBe(26 + 10) // parser 42..67 inclusive + helpers 1..10
    expect(p!.humanInvolved).toBe(false)
  })

  it('honors a per-range contributor override and flags human involvement', () => {
    const index = parseAgentTrace([
      {
        version: '0.1.0',
        id: 'x',
        timestamp: '2026-01-23T14:30:00Z',
        vcs: { type: 'git', revision: SHA_GPT },
        files: [
          {
            path: 'a.ts',
            conversations: [
              {
                contributor: { type: 'ai', model_id: 'openai/gpt-4o' },
                ranges: [
                  { start_line: 1, end_line: 5 },
                  // handoff: this range was actually a human edit
                  { start_line: 6, end_line: 9, contributor: { type: 'human' } },
                ],
              },
            ],
          },
        ],
      },
    ])
    const p = index.get(SHA_GPT)!
    expect(p.aiModels).toEqual(['openai/gpt-4o'])
    expect(p.humanInvolved).toBe(true)
  })

  it('skips records with no vcs.revision (no join key, nothing to correlate)', () => {
    const index = parseAgentTrace([
      { version: '0.1.0', id: 'y', timestamp: '2026-01-23T14:30:00Z', files: [] },
    ])
    expect(index.size).toBe(0)
  })
})

describe('partitionRunsByAuthoringModel — provenance × run-quality join', () => {
  it('groups runs by every AI model that authored code in their commit', () => {
    const index = parseAgentTrace([SPEC_EXAMPLE])
    const runs = [run('r1', SHA_OPUS, 0.9), run('r2', SHA_OPUS, 0.1), run('r3', 'deadbeef', 0.5)]
    const { byModel, unattributed } = partitionRunsByAuthoringModel(runs, index)

    // SHA_OPUS was co-authored by two models → both cohorts contain r1+r2.
    expect(byModel.get('anthropic/claude-opus-4-5-20251101')!.map((r) => r.runId)).toEqual([
      'r1',
      'r2',
    ])
    expect(byModel.get('openai/gpt-4o')!.map((r) => r.runId)).toEqual(['r1', 'r2'])
    // r3's commit has no provenance → unattributed, never silently bucketed.
    expect(unattributed.map((r) => r.runId)).toEqual(['r3'])
  })

  it('feeds a cohort straight into analyzeRuns (the differentiated question)', async () => {
    const index = parseAgentTrace([SPEC_EXAMPLE])
    const runs = Array.from({ length: 12 }, (_, i) => run(`r${i}`, SHA_OPUS, i < 4 ? 0.2 : 0.85))
    const { byModel } = partitionRunsByAuthoringModel(runs, index)

    const cohort = byModel.get('openai/gpt-4o')!
    const report = await analyzeRuns({ runs: cohort })
    // A real InsightReport on the "code authored by gpt-4o" cohort.
    expect(report.composite.n).toBe(12)
    expect(report.composite.mean).toBeGreaterThan(0)
    expect(report.composite.mean).toBeLessThanOrEqual(1)
  })
})
