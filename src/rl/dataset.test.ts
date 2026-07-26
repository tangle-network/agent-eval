import { describe, expect, it } from 'vitest'
import { fixtureRolloutLine } from '../rollout/fixtures'
import { mintRolloutRows } from '../rollout/mint'
import type { MintedRolloutLine } from '../rollout/schema'
import type { RunRecord } from '../run-record'
import { InMemoryTraceStore } from '../trace/store'
import {
  buildRlDataset,
  datasheetToMarkdown,
  type RlDatasetConfig,
  validateDatasetFormats,
} from './dataset'
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
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 100, output: 50 },
    terminalOutcome: 'succeeded',
    splitTag,
    scenarioId: scenario,
    outcome:
      splitTag === 'holdout' ? { holdoutScore: score, raw: {} } : { searchScore: score, raw: {} },
  }
}

const records: RunRecord[] = [
  rec('r1', 'sA', 'search', 0.8),
  rec('r2', 'sA', 'search', 0.4),
  rec('r3', 'sB', 'holdout', 1.0),
  rec('r4', 'sB', 'holdout', 0.6),
]

const lookups: GrpoLookups & SftLookups = {
  promptOf: (id) => (id === 'r1' || id === 'r2' ? 'prompt-for-sA' : 'prompt-for-sB'),
  completionOf: (id) => `completion-for-${id}`,
}

async function mint(input: RunRecord[]): Promise<MintedRolloutLine[]> {
  return (await mintRolloutRows(input, new InMemoryTraceStore())).rows
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
  formats: ['grpo', 'sft'],
  qualityGates: { contaminationProbe: 'passed', dedup: true, verifiableRewardFilter: true },
}

describe('buildRlDataset — dataset-as-product packaging', () => {
  it('packages grpo + sft + manifest + datasheet from graded rollout lines', async () => {
    const b = await buildRlDataset(await mint(records), lookups, config)
    expect(Object.keys(b.files).sort()).toEqual([
      'DATASHEET.md',
      'manifest.json',
      'train.grpo.jsonl',
      'train.sft.jsonl',
    ])
    // Training rows exclude the held-out sB records by default.
    expect(b.manifest.rowCounts.grpo).toBe(1)
    expect(b.manifest.rowCounts.sft).toBe(2)
    const grpoLines = b.files['train.grpo.jsonl']!.trim().split('\n')
    expect(grpoLines).toHaveLength(1)
    const row = JSON.parse(grpoLines[0]!)
    expect(row).toHaveProperty('prompt')
    expect(row.completions).toHaveLength(row.rewards.length) // GRPO invariant
    expect(row.completions).toHaveLength(2) // 2 runs on sA
  })

  it('includes held-out rows only through the named override', async () => {
    const b = await buildRlDataset(
      await mint(records),
      { ...lookups, allowHeldOutTrainingData: true },
      config,
    )
    expect(b.manifest.rowCounts.grpo).toBe(2)
    expect(b.manifest.rowCounts.sft).toBe(4)
  })

  it('computes provenance + reward statistics from the lines', async () => {
    const { manifest } = await buildRlDataset(await mint(records), lookups, config)
    expect(manifest.stats.records).toBe(4)
    expect(manifest.stats.scoredRecords).toBe(4)
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
    const { manifest } = await buildRlDataset(await mint(records), lookups, config)
    const md = datasheetToMarkdown(manifest)
    expect(md).toContain('Tangle Commercial') // license
    expect(md).toContain('deterministic') // reward kind
    expect(md).toContain('decidable, not judge noise')
    expect(md).toContain('Records (trajectories):** 4')
    expect(md).toContain('`holdout`: 2') // declared holdout
    expect(md).toContain('renderers') // tokenization guidance
  })

  it('refuses to package an empty corpus (no silent empty dataset)', async () => {
    await expect(buildRlDataset([], lookups, config)).rejects.toThrow(/empty dataset/)
  })

  it('rejects unknown formats at runtime', async () => {
    const runtimeConfig = {
      ...config,
      formats: ['bogus'],
    } as unknown as RlDatasetConfig

    await expect(buildRlDataset(await mint(records), lookups, runtimeConfig)).rejects.toThrow(
      /unsupported format "bogus"; expected exactly one of: grpo, sft, dpo/,
    )
  })

  it('rejects duplicate formats at runtime', async () => {
    const runtimeConfig = {
      ...config,
      formats: ['sft', 'sft'],
    } as unknown as RlDatasetConfig

    await expect(buildRlDataset(await mint(records), lookups, runtimeConfig)).rejects.toThrow(
      /duplicate format "sft"; each format may be requested once/,
    )
  })

  it('rejects an empty runtime format list', () => {
    expect(() => validateDatasetFormats([])).toThrow(
      /formats must contain at least one of: grpo, sft, dpo/,
    )
  })

  it('emits a trainer file when formats use the default', async () => {
    const defaultConfig: RlDatasetConfig = { ...config }
    delete defaultConfig.formats

    const bundle = await buildRlDataset(await mint(records), lookups, defaultConfig)
    const trainerFiles = Object.keys(bundle.files).filter(
      (name) => name.startsWith('train.') && name.endsWith('.jsonl'),
    )

    expect(bundle.manifest.formats).toEqual(['sft'])
    expect(trainerFiles).toEqual(['train.sft.jsonl'])
  })

  it('refuses a requested format when no trainable rows can be produced', async () => {
    const base = fixtureRolloutLine()
    const unscored = fixtureRolloutLine({
      outcome: { ...base.outcome, reward: null, reward_source: 'import/unscored' },
    })

    await expect(
      buildRlDataset([unscored], lookups, { ...config, formats: ['sft'] }),
    ).rejects.toThrow(/'sft' format produced no trainable rows/)
  })

  it("format 'dpo' requires preference triples (fail loud)", async () => {
    const dpoConfig: RlDatasetConfig = { ...config, formats: ['dpo'] }
    await expect(buildRlDataset(await mint(records), lookups, dpoConfig)).rejects.toThrow(
      /preferences/,
    )
  })

  // The datasheet ships INSIDE the bundle a buyer inspects. If a gamed run were
  // counted at its claimed score, the published reward distribution would
  // describe data the rows do not contain.
  it('scores a realness-gated run 0 in the datasheet and keeps it out of every trainer row', async () => {
    const gamed = rec('r5', 'sC', 'search', 1.0)
    gamed.outcome.realness = { score: 0, gated: true, reason: 'faked the harness' }
    const b = await buildRlDataset(await mint([...records, gamed]), lookups, config)
    // The datasheet counts it at its GATED value: 0, never the claimed 1.0.
    expect(b.manifest.stats.reward.max).toBe(1.0) // r3 (honest) still tops out at 1.0
    expect(b.manifest.stats.reward.n).toBe(5)
    expect(b.manifest.stats.reward.mean).toBeCloseTo((0.8 + 0.4 + 1.0 + 0.6 + 0) / 5, 5)
    // Trainable SFT rows: the two clean search runs; holdout still needs its
    // named override.
    expect(b.manifest.rowCounts.sft).toBe(2)
    const grpo = b.files['train.grpo.jsonl']!.trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    // The gamed run's scenario has no relative baseline, so no GRPO row is
    // emitted for it.
    expect(grpo.some((r) => r.meta.scenarioId === 'sC')).toBe(false)
    expect(JSON.stringify(b.files)).not.toContain('completion-for-r5')
  })

  it('declares every rollout split and uncaptured cost', async () => {
    const b = await buildRlDataset(await mint(records), lookups, config)
    expect(b.manifest.stats.splits).toEqual({ search: 2, dev: 0, holdout: 2, canary: 0 })
    expect(b.manifest.stats.rolloutsWithoutCost).toBe(0)
  })
})
