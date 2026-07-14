import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPrimeIntellectEnvironmentPackage,
  PrimeIntellectBridgeError,
  type PrimeIntellectScenario,
  primeIntellectRowsFromRunRecords,
  writePrimeIntellectEnvironmentPackage,
} from '../src/primeintellect'
import type { RunRecord } from '../src/run-record'

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
    runId: '11111111-2222-3333-4444-555555555555',
    experimentId: 'exp-primeintellect',
    candidateId: 'baseline',
    seed: 7,
    model: 'gpt-4o-2024-11-20',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'cafebabe',
    wallMs: 1234,
    costUsd: 0.01,
    tokenUsage: { input: 10, output: 20 },
    outcome: { searchScore: 0.75, raw: { pass: 1 } },
    splitTag: 'search',
    scenarioId: 'scenario-1',
  }
  return { ...base, ...overrides, outcome: overrides.outcome ?? base.outcome }
}

const scenario: PrimeIntellectScenario = {
  id: 'scenario-1',
  prompt: 'What is the refund policy?',
  answer: 'Refunds are available within 30 days.',
  requiredSubstrings: ['refunds', '30 days'],
  split: 'train',
  info: { source: 'agent-knowledge' },
}

describe('PrimeIntellect bridge', () => {
  it('turns validated RunRecords plus scenarios into Verifiers dataset rows', () => {
    const rows = primeIntellectRowsFromRunRecords({
      records: [run()],
      scenarios: [scenario],
    })

    expect(rows).toEqual([
      {
        id: 'scenario-1:11111111-2222-3333-4444-555555555555',
        prompt: [{ role: 'user', content: 'What is the refund policy?' }],
        answer: 'Refunds are available within 30 days.',
        required_substrings: ['refunds', '30 days'],
        split: 'train',
        info: {
          source: 'agent-knowledge',
          tangle: {
            candidate_id: 'baseline',
            commit_sha: 'cafebabe',
            cost_usd: 0.01,
            experiment_id: 'exp-primeintellect',
            failure_mode: null,
            model: 'gpt-4o-2024-11-20',
            run_id: '11111111-2222-3333-4444-555555555555',
            scenario_id: 'scenario-1',
            score: 0.75,
            split: 'train',
            wall_ms: 1234,
          },
        },
      },
    ])
  })

  it('fails loudly when an environment row cannot be scored', () => {
    expect(() =>
      primeIntellectRowsFromRunRecords({
        records: [run()],
        scenarios: [{ id: 'scenario-1', prompt: 'Unscored prompt' }],
      }),
    ).toThrow(PrimeIntellectBridgeError)
  })

  it('builds a PrimeIntellect Verifiers package with dataset and run-record artifacts', () => {
    const record = run()
    const rows = primeIntellectRowsFromRunRecords({ records: [record], scenarios: [scenario] })
    const pkg = buildPrimeIntellectEnvironmentPackage({
      name: 'tangle-refund-policy',
      rows,
      runRecords: [record],
      systemPrompt: 'Answer using the supplied policy.',
    })

    expect(pkg.manifest).toEqual({
      schemaVersion: 1,
      name: 'tangle-refund-policy',
      moduleName: 'tangle_refund_policy',
      version: '0.1.0',
      rowCount: 1,
      runRecordCount: 1,
      artifactKinds: ['environment', 'dataset', 'run_records'],
    })
    expect(pkg.files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'data/dataset.jsonl',
      'data/run_records.jsonl',
      'pyproject.toml',
      'tangle-primeintellect-manifest.json',
      'tangle_refund_policy.py',
    ])
    expect(pkg.files.find((file) => file.path === 'pyproject.toml')?.content).toContain(
      '"verifiers>=0.2.0,<0.3.0"',
    )
    expect(pkg.files.find((file) => file.path === 'tangle_refund_policy.py')?.content).toContain(
      'def load_environment(',
    )
    expect(pkg.files.find((file) => file.path === 'data/dataset.jsonl')?.content).toContain(
      '"required_substrings":["refunds","30 days"]',
    )
  })

  it('writes the generated package to disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-eval-primeintellect-'))
    try {
      const record = run()
      const rows = primeIntellectRowsFromRunRecords({ records: [record], scenarios: [scenario] })
      await writePrimeIntellectEnvironmentPackage(root, {
        name: 'tangle-refund-policy',
        rows,
        runRecords: [record],
      })

      const manifest = JSON.parse(
        await readFile(join(root, 'tangle-primeintellect-manifest.json'), 'utf8'),
      )
      const dataset = await readFile(join(root, 'data/dataset.jsonl'), 'utf8')

      expect(manifest.rowCount).toBe(1)
      expect(dataset.split('\n').filter(Boolean)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
