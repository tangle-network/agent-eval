import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '../run-record'
import { appendToCorpus, buildDatasetFromCorpus, type CorpusRecord, readCorpus } from './corpus'
import type { RlDatasetConfig } from './dataset'

// Pins the "datasets for free" engine: eval runs append graded trajectories to
// a durable corpus, and the corpus harvests into a publishable bundle. A
// regression here means the dataset silently stops accumulating (lost free
// exhaust) or harvests records with no trajectory (untrainable rows).

const DIR = join(tmpdir(), 'agent-eval-corpus-test')

function rec(
  runId: string,
  split: RunRecord['splitTag'],
  score: number,
  withText = true,
): CorpusRecord {
  const r: CorpusRecord = {
    runId,
    experimentId: 'exp',
    candidateId: 'cand',
    seed: 0,
    model: 'deepseek-v4-pro@2026-05-31',
    promptHash: `sha256:${runId}`,
    configHash: 'sha256:cfg',
    commitSha: 'abc1234',
    wallMs: 100,
    costUsd: 0.01,
    tokenUsage: { input: 100, output: 50 },
    splitTag: split,
    scenarioId: 'sA',
    outcome:
      split === 'holdout' ? { holdoutScore: score, raw: {} } : { searchScore: score, raw: {} },
  }
  if (withText) {
    r.prompt = `prompt-${runId}`
    r.completion = `completion-${runId}`
  }
  return r
}

const config: RlDatasetConfig = {
  name: 'tax-1040-rl',
  version: '0.1.0',
  domain: 'tax-1040',
  license: 'Tangle Commercial',
  createdAtIso: '2026-05-31T00:00:00Z',
  reward: { kind: 'deterministic', source: 'XPath line-match', description: 'objective' },
  intendedUse: 'SFT/GRPO',
  outOfScope: 'advice',
  limitations: 'sample',
}

describe('rl corpus — datasets-for-free capture', () => {
  let corpus: string
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
    corpus = join(DIR, 'corpus.jsonl')
  })

  it('accumulates across separate eval runs (the free-exhaust semantic)', () => {
    const run1 = appendToCorpus([rec('r1', 'search', 0.8), rec('r2', 'search', 0.4)], corpus)
    expect(run1).toEqual({ appended: 2, skipped: 0, total: 2 })
    // A later, independent eval run appends more — the corpus grows.
    const run2 = appendToCorpus([rec('r3', 'holdout', 1.0)], corpus)
    expect(run2).toEqual({ appended: 1, skipped: 0, total: 3 })
    expect(readCorpus(corpus)).toHaveLength(3)
  })

  it('dedups by runId so re-appending the same run is idempotent', () => {
    appendToCorpus([rec('r1', 'search', 0.8)], corpus)
    const again = appendToCorpus([rec('r1', 'search', 0.8), rec('r2', 'search', 0.5)], corpus)
    expect(again).toEqual({ appended: 1, skipped: 1, total: 2 })
    expect(readCorpus(corpus)).toHaveLength(2)
  })

  it('readCorpus returns [] for a corpus that does not exist yet', () => {
    expect(readCorpus(join(DIR, 'nope.jsonl'))).toEqual([])
  })

  it('harvests the corpus into a bundle, excluding records with no trajectory', async () => {
    appendToCorpus(
      [rec('r1', 'search', 0.8), rec('r2', 'holdout', 1.0), rec('r3', 'search', 0.6, false)],
      corpus,
    )
    const bundle = await buildDatasetFromCorpus(corpus, config)
    // r3 has no prompt/completion → excluded; r1+r2 packaged.
    expect(bundle.manifest.stats.records).toBe(2)
    expect(bundle.files['train.sft.jsonl']!.trim().split('\n')).toHaveLength(2)
  })

  it('filters harvest by minScore and split', async () => {
    appendToCorpus(
      [rec('lo', 'search', 0.3), rec('hi', 'search', 0.9), rec('ho', 'holdout', 0.95)],
      corpus,
    )
    const highOnly = await buildDatasetFromCorpus(corpus, config, { minScore: 0.8 })
    expect(highOnly.manifest.stats.records).toBe(2) // hi + ho
    const holdoutOnly = await buildDatasetFromCorpus(corpus, config, { splits: ['holdout'] })
    expect(holdoutOnly.manifest.stats.records).toBe(1) // ho
  })

  it('throws (no silent empty dataset) when nothing survives the filters', async () => {
    appendToCorpus([rec('r1', 'search', 0.2)], corpus)
    await expect(buildDatasetFromCorpus(corpus, config, { minScore: 0.9 })).rejects.toThrow(
      /empty dataset/,
    )
  })

  it('persists the trajectory text through a write/read round-trip', () => {
    appendToCorpus([rec('r1', 'search', 0.8)], corpus)
    const [back] = readCorpus(corpus)
    expect(back!.prompt).toBe('prompt-r1')
    expect(back!.completion).toBe('completion-r1')
  })
})
