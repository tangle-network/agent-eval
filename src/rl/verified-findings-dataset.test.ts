import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type GoldLabelEntry,
  loadVerifiedFindingsDataset,
  type NormalizedStep,
  type ReplayBatchCase,
} from './verified-findings-dataset'

// Pins the verified-labels join: a replay batch's executed verdicts must land
// on the exact gold step and trajectory they verified. A regression here means
// training rows carry the wrong label, the wrong context, or silently drop a
// case — the three failure modes that make an execution-verified dataset
// worthless.

const DIR = mkdtempSync(join(tmpdir(), 'agent-eval-verified-findings-test-'))

function makeCase(overrides: Partial<ReplayBatchCase> = {}): ReplayBatchCase {
  return {
    corpus: 'holdout-x',
    trajId: 'traj-1',
    image: 'bench/img:pr-1',
    cwd: '/home',
    cwdSource: 'run-config',
    k: 2,
    stepCount: 3,
    goldIncorrectSteps: [2, 3],
    recordedReturncodeAtK: 127,
    derivedImage: 'ctb-replay:abc-uid1000',
    signature: 'command not found',
    status: 'ok',
    error: null,
    prefixExecuted: 1,
    prefixDivergences: 0,
    prefixDivergencePct: 0,
    prefixReturncodeMismatches: 0,
    prefixUnknownExpectations: 0,
    armAExit: 127,
    armAReturncodeMatch: true,
    armASignatureMatch: true,
    replayed: true,
    fix: {
      attempted: true,
      sampledOut: false,
      command: 'apt-get install -y foo',
      llmError: null,
      armBExit: 0,
      failureVanished: true,
    },
    wallMs: 1200,
    ...overrides,
  }
}

function makeLabel(overrides: Partial<GoldLabelEntry> = {}): GoldLabelEntry {
  return {
    traj_id: 'traj-1',
    solved: false,
    step_count: 3,
    agent: 'mini-SWE-agent',
    model: 'OpenAI/GPT-5',
    task_name: 'fix-the-thing',
    difficulty: 'medium',
    incorrect_stages: [
      { stage_id: 1, incorrect_step_ids: [2] },
      { stage_id: 2, incorrect_step_ids: [3] },
    ],
    ...overrides,
  }
}

function makeSteps(): NormalizedStep[] {
  return [
    { step_id: 1, action: 'ls', observation: '<returncode>0</returncode>' },
    {
      step_id: 2,
      action: 'foo --run',
      observation: '<returncode>127</returncode>\nfoo: command not found',
    },
    { step_id: 3, action: 'echo done', observation: '<returncode>0</returncode>' },
  ]
}







describe('loadVerifiedFindingsDataset', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })
  })

  function writeFixture(options: { withLabelFor?: string[] } = {}) {
    const report = {
      generatedAt: '2026-08-02T00:00:00.000Z',
      cases: [
        makeCase(),
        makeCase({
          trajId: 'traj-2',
          k: 3,
          goldIncorrectSteps: [3],
          replayed: false,
          fix: null,
          armAReturncodeMatch: false,
          armASignatureMatch: false,
        }),
      ],
    }
    writeFileSync(join(DIR, 'batch-report.json'), JSON.stringify(report))
    const labelIds = options.withLabelFor ?? ['traj-1', 'traj-2']
    const labels = labelIds.map((id) =>
      makeLabel({ traj_id: id, incorrect_stages: [{ stage_id: 1, incorrect_step_ids: [2, 3] }] }),
    )
    writeFileSync(join(DIR, 'labels.json'), JSON.stringify(labels))
    for (const id of ['traj-1', 'traj-2']) {
      const dir = join(DIR, 'prepared', 'normalized', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'steps.json'), JSON.stringify(makeSteps()))
    }
  }

  function source() {
    return {
      batchReportPath: join(DIR, 'batch-report.json'),
      runId: 'run-fixture',
      corpora: {
        'holdout-x': { labelsPath: join(DIR, 'labels.json'), preparedDir: join(DIR, 'prepared') },
      },
    }
  }

  it('loads, joins, and orders rows deterministically with file provenance', () => {
    writeFixture()
    const dataset = loadVerifiedFindingsDataset(source())
    expect(dataset.rows.map((r) => r.trajId)).toEqual(['traj-1', 'traj-2'])
    expect(dataset.summary.rows).toBe(2)
    expect(dataset.summary.reproduced).toBe(1)
    expect(dataset.provenance.batchReportSha256).toMatch(/^[0-9a-f]{64}$/)
    const corpus = dataset.provenance.corpora['holdout-x']!
    expect(corpus.labelsSha256).toMatch(/^[0-9a-f]{64}$/)
    for (const row of dataset.rows) {
      expect(row.provenance.labelsSha256).toBe(corpus.labelsSha256)
      expect(row.provenance.stepsSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('throws when a case has no label entry', () => {
    writeFixture({ withLabelFor: ['traj-1'] })
    expect(() => loadVerifiedFindingsDataset(source())).toThrow(/traj-2: no label entry/)
  })

  it('throws when the corpus is not configured', () => {
    writeFixture()
    const bad = { ...source(), corpora: {} }
    expect(() => loadVerifiedFindingsDataset(bad)).toThrow(/no labels\/preparedDir was configured/)
  })

  it('throws when a trajectory steps file is missing', () => {
    writeFixture()
    rmSync(join(DIR, 'prepared', 'normalized', 'traj-2'), { recursive: true })
    expect(() => loadVerifiedFindingsDataset(source())).toThrow(
      /cannot read trajectory steps for traj-2/,
    )
  })

  it('throws when a per-case verdict records a divergence with no class', () => {
    writeFixture()
    for (const id of ['traj-1', 'traj-2']) {
      const dir = join(DIR, 'run', `holdout-x--${id}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'replay-verdict.json'),
        JSON.stringify({
          k: id === 'traj-1' ? 2 : 3,
          prefixExecuted: 1,
          recordedReturncode: 127,
          prefixDivergences: [{ step: 1, expectedReturncode: 0, actualExit: 127 }],
        }),
      )
    }
    expect(() => loadVerifiedFindingsDataset({ ...source(), runDir: join(DIR, 'run') })).toThrow(
      /step 1 has divergence kind 'undefined'; expected one of returncode-mismatch, unknown-expectation/,
    )
  })

  it('throws on duplicate label traj_ids', () => {
    writeFixture({ withLabelFor: ['traj-1', 'traj-1', 'traj-2'] })
    expect(() => loadVerifiedFindingsDataset(source())).toThrow(/duplicate traj_id 'traj-1'/)
  })
})
