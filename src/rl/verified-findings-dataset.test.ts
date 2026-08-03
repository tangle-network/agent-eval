import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildVerifiedFindingRow,
  type GoldLabelEntry,
  loadVerifiedFindingsDataset,
  type NormalizedStep,
  type ReplayBatchCase,
  summarizeVerifiedFindings,
  VERIFIED_FINDING_SCHEMA,
  type VerifiedFindingRow,
  verifiedFindingsToJsonl,
} from './verified-findings-dataset'

// Pins the verified-labels join: a replay batch's executed verdicts must land
// on the exact gold step and trajectory they verified. A regression here means
// training rows carry the wrong label, the wrong context, or silently drop a
// case — the three failure modes that make an execution-verified dataset
// worthless.

const DIR = join(tmpdir(), 'agent-eval-verified-findings-test')

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

function baseArgs() {
  return {
    batchCase: makeCase(),
    label: makeLabel(),
    steps: makeSteps(),
    runId: 'run-test',
    batchGeneratedAt: '2026-08-02T00:00:00.000Z',
    batchReportSha256: 'r'.repeat(64),
    labelsPath: '/labels.json',
    labelsSha256: 'l'.repeat(64),
    stepsPath: '/steps.json',
    stepsSha256: 's'.repeat(64),
  }
}

describe('buildVerifiedFindingRow', () => {
  it('joins case, label, and trajectory into a fully provenanced row', () => {
    const row = buildVerifiedFindingRow(baseArgs())
    expect(row.schema).toBe(VERIFIED_FINDING_SCHEMA)
    expect(row.caseId).toBe('run-test/holdout-x/traj-1')
    expect(row.gold.stepK).toBe(2)
    expect(row.gold.actionAtK).toBe('foo --run')
    expect(row.gold.labelIncorrectSteps).toEqual([2, 3])
    expect(row.trajectory.window).toEqual({ start: 1, end: 2 })
    expect(row.trajectory.steps.map((s) => s.stepId)).toEqual([1, 2])
    expect(row.verification.reproduced).toBe(true)
    expect(row.fix.outcome).toBe('flipped')
    expect(row.fix.armBExit).toBe(0)
    expect(row.provenance.labelsSha256).toBe('l'.repeat(64))
    expect(row.provenance.image).toBe('bench/img:pr-1')
  })

  it('excludes post-k steps so the trainer never sees the future', () => {
    const row = buildVerifiedFindingRow(baseArgs())
    expect(row.trajectory.steps.some((s) => s.stepId > 2)).toBe(false)
  })

  it('truncates long observations and records the original length', () => {
    const args = baseArgs()
    args.steps[0]!.observation = 'x'.repeat(500)
    const row = buildVerifiedFindingRow({ ...args, maxObservationChars: 100 })
    const step = row.trajectory.steps[0]!
    expect(step.observation).toHaveLength(100)
    expect(step.observationTruncated).toBe(true)
    expect(step.observationChars).toBe(500)
    expect(row.gold.actionAtK).toBe('foo --run')
  })

  it('maps fix records to outcomes: generation failure', () => {
    const args = baseArgs()
    args.batchCase = makeCase({
      fix: {
        attempted: true,
        sampledOut: false,
        command: null,
        llmError: 'aborted',
        armBExit: null,
        failureVanished: null,
      },
    })
    expect(buildVerifiedFindingRow(args).fix.outcome).toBe('generation-failed')
  })

  it('maps fix records to outcomes: not flipped', () => {
    const args = baseArgs()
    args.batchCase = makeCase({
      fix: {
        attempted: true,
        sampledOut: false,
        command: 'try',
        llmError: null,
        armBExit: 127,
        failureVanished: false,
      },
    })
    expect(buildVerifiedFindingRow(args).fix.outcome).toBe('not-flipped')
  })

  it('marks non-replayed cases without a fix record as not-attempted', () => {
    const args = baseArgs()
    args.batchCase = makeCase({
      replayed: false,
      armAReturncodeMatch: false,
      armASignatureMatch: false,
      fix: null,
    })
    const row = buildVerifiedFindingRow(args)
    expect(row.verification.reproduced).toBe(false)
    expect(row.fix.outcome).toBe('not-attempted')
  })

  it('throws when a replayed case is missing its fix record', () => {
    const args = baseArgs()
    args.batchCase = makeCase({ fix: null })
    expect(() => buildVerifiedFindingRow(args)).toThrow(/replayed case has no fix record/)
  })

  it('throws when a fix command has no arm B verdict', () => {
    const args = baseArgs()
    args.batchCase = makeCase({
      fix: {
        attempted: true,
        sampledOut: false,
        command: 'try',
        llmError: null,
        armBExit: null,
        failureVanished: null,
      },
    })
    expect(() => buildVerifiedFindingRow(args)).toThrow(/failureVanished missing/)
  })

  it('throws when the label step count disagrees with the case', () => {
    const args = baseArgs()
    args.label = makeLabel({ step_count: 5 })
    expect(() => buildVerifiedFindingRow(args)).toThrow(/step_count 5 != case stepCount 3/)
  })

  it('throws when the trajectory is missing steps', () => {
    const args = baseArgs()
    args.steps = args.steps.slice(0, 2)
    expect(() => buildVerifiedFindingRow(args)).toThrow(/has 2 steps, case expects 3/)
  })

  it('throws when the gold step is not in the label incorrect steps', () => {
    const args = baseArgs()
    args.label = makeLabel({ incorrect_stages: [{ stage_id: 1, incorrect_step_ids: [3] }] })
    expect(() => buildVerifiedFindingRow(args)).toThrow(/absent from the label's incorrect steps/)
  })

  it('throws when k is not among the case gold steps', () => {
    const args = baseArgs()
    args.batchCase = makeCase({ k: 1, goldIncorrectSteps: [2, 3] })
    expect(() => buildVerifiedFindingRow(args)).toThrow(/k=1 is not in goldIncorrectSteps/)
  })

  it('cross-checks the per-case verdict detail against the report', () => {
    const args = baseArgs()
    const detail = {
      k: 3,
      prefixExecuted: 1,
      recordedReturncode: 127,
      signatureBasis: 'returncode-only',
      prefixDivergences: [],
      armACommand: 'foo --run',
      runIds: { original: 'o-1', armA: 'a-1' },
    }
    expect(() => buildVerifiedFindingRow({ ...args, detail })).toThrow(/verdict k=3 != report k=2/)
    const row = buildVerifiedFindingRow({ ...args, detail: { ...detail, k: 2 } })
    expect(row.provenance.originalRunId).toBe('o-1')
    expect(row.verification.armACommand).toBe('foo --run')
  })
})

describe('summarizeVerifiedFindings + jsonl', () => {
  it('counts verdicts by corpus and serializes one row per line', () => {
    const flipped = buildVerifiedFindingRow(baseArgs())
    const args = baseArgs()
    args.batchCase = makeCase({
      trajId: 'traj-1',
      corpus: 'holdout-x',
      replayed: false,
      fix: null,
      armASignatureMatch: false,
    })
    const notReplayed = buildVerifiedFindingRow(args)
    const summary = summarizeVerifiedFindings([flipped, notReplayed])
    expect(summary.rows).toBe(2)
    expect(summary.reproduced).toBe(1)
    expect(summary.signatureStrict).toBe(1)
    expect(summary.fix.flipped).toBe(1)
    expect(summary.fix['not-attempted']).toBe(1)
    expect(summary.byCorpus['holdout-x']).toEqual({ rows: 2, reproduced: 1, fixFlipped: 1 })

    const jsonl = verifiedFindingsToJsonl([flipped, notReplayed])
    const lines = jsonl.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect((JSON.parse(lines[0]!) as VerifiedFindingRow).caseId).toBe(flipped.caseId)
  })
})

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

  it('throws on duplicate label traj_ids', () => {
    writeFixture({ withLabelFor: ['traj-1', 'traj-1', 'traj-2'] })
    expect(() => loadVerifiedFindingsDataset(source())).toThrow(/duplicate traj_id 'traj-1'/)
  })
})
