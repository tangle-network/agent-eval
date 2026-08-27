import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../run-record'
import { buildRlDataset, datasheetToMarkdown, type RlDatasetConfig } from './dataset'
import type { GrpoLookups, SftLookups } from './exporters'

// Pins the dataset-as-product packaging: the graded RunRecords a campaign
// produces must turn into a publishable bundle (trainer JSONL + a datasheet)
// with correct provenance + reward stats. A regression here ships a dataset
// with a wrong reward distribution, a missing holdout count, or no datasheet —
// i.e. an unsellable / non-credible artifact.

function rec(
  runId: string,
  scenario: string,
  splitTag: RunRecord['splitTag'],
  score: number,
  model = 'deepseek-v4-pro@2026-05-01',
): RunRecord {
  return {
    runId,
    experimentId: scenario,
    candidateId: scenario,
    seed: 0,
    model,
    promptHash: `sha256:${scenario}`,
    configHash: 'sha256:cfg',
    commitSha: 'abc1234',
    wallMs: 100,
    costUsd: 0.01,
    tokenUsage: { input: 100, output: 50 },
    splitTag,
    scenarioId: scenario,
    outcome: { searchScore: score, raw: {} },
  }
}

const records: RunRecord[] = [
  rec('r1', 'sA', 'search', 0.8),
  rec('r2', 'sA', 'search', 0.4),
  rec('r3', 'sB', 'holdout', 1.0),
  rec('r4', 'sB', 'holdout', 0.6),
]

const lookups: GrpoLookups & SftLookups = {
  promptOf: (id) => `prompt-for-${id}`,
  completionOf: (id) => `completion-for-${id}`,
}

const config: RlDatasetConfig = {
  name: 'legal-mna-rl',
  version: '0.1.0',
  domain: 'legal-m&a',
  license: 'Tangle Commercial',
  createdAtIso: '2026-05-31T00:00:00Z',
  reward: {
    kind: 'deterministic',
    source: 'requirements-rubric',
    description: 'fraction of required filings enumerated',
  },
  intendedUse: 'RL/SFT on M&A advisory tasks',
  outOfScope: 'medical or personal financial advice',
  limitations: 'synthetic personas; US-jurisdiction-weighted',
  qualityGates: { contaminationProbe: 'passed', dedup: true, verifiableRewardFilter: true },
}

describe('buildRlDataset — dataset-as-product packaging', () => {
  it('packages grpo + sft + manifest + datasheet from graded records', async () => {
    const b = await buildRlDataset(records, lookups, config)
    expect(Object.keys(b.files).sort()).toEqual([
      'DATASHEET.md',
      'manifest.json',
      'train.grpo.jsonl',
      'train.sft.jsonl',
    ])
    // GRPO groups by scenario (sA, sB) → 2 rows; SFT is one row per record → 4.
    expect(b.manifest.rowCounts.grpo).toBe(2)
    expect(b.manifest.rowCounts.sft).toBe(4)
    const grpoLines = b.files['train.grpo.jsonl']!.trim().split('\n')
    expect(grpoLines).toHaveLength(2)
    const row = JSON.parse(grpoLines[0]!)
    expect(row).toHaveProperty('prompt')
    expect(row.completions).toHaveLength(row.rewards.length) // GRPO invariant
    expect(row.completions).toHaveLength(2) // 2 runs on sA
  })

  it('computes provenance + reward statistics from the records', async () => {
    const { manifest } = await buildRlDataset(records, lookups, config)
    expect(manifest.stats.records).toBe(4)
    expect(manifest.stats.splits.search).toBe(2)
    expect(manifest.stats.splits.holdout).toBe(2)
    expect(manifest.stats.models).toEqual(['deepseek-v4-pro@2026-05-01'])
    expect(manifest.stats.reward.n).toBe(4)
    expect(manifest.stats.reward.mean).toBeCloseTo((0.8 + 0.4 + 1.0 + 0.6) / 4, 5)
    expect(manifest.stats.reward.min).toBe(0.4)
    expect(manifest.stats.reward.max).toBe(1.0)
    expect(manifest.stats.totalTokens).toEqual({ input: 400, output: 200 })
    expect(manifest.stats.totalCostUsd).toBeCloseTo(0.04, 5)
  })

  it('renders a datasheet carrying the buyer-facing facts', async () => {
    const { manifest } = await buildRlDataset(records, lookups, config)
    const md = datasheetToMarkdown(manifest)
    expect(md).toContain('Tangle Commercial') // license
    expect(md).toContain('deterministic') // reward kind
    expect(md).toContain('✅') // decidable-reward credibility marker
    expect(md).toContain('Records (trajectories):** 4')
    expect(md).toContain('`holdout`: 2') // declared holdout
    expect(md).toContain('renderers') // tokenization guidance
  })

  it('refuses to package an empty corpus (no silent empty dataset)', async () => {
    await expect(buildRlDataset([], lookups, config)).rejects.toThrow(/empty dataset/)
  })

  it("format 'dpo' requires preference triples (fail loud)", async () => {
    const dpoConfig: RlDatasetConfig = { ...config, formats: ['dpo'] }
    await expect(buildRlDataset(records, lookups, dpoConfig)).rejects.toThrow(/preferences/)
  })
})
