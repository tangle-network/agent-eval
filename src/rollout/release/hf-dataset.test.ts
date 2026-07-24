import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureRolloutLine, malformedRolloutLine } from '../fixtures'
import { writeRolloutLedger } from '../ledger'
import type { RolloutLine } from '../schema'
import { FORMAT_FILES } from './card'
import { buildHfDataset, parseRolloutReleaseArgs, planPushCommand } from './hf-dataset'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hf-release-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function pilotLines(): RolloutLine[] {
  const base = fixtureRolloutLine()
  return [
    fixtureRolloutLine({
      role: 'worker',
      run_id: '/home/drew/runs/gen3#1',
      messages: [
        { role: 'system', content: 'cwd /home/drew/code/repo' },
        { role: 'user', content: 'HF_TOKEN=hf_abcdef123456 leaked here, hit router.tangle.tools' },
        { role: 'assistant', content: 'done' },
      ],
    }),
    fixtureRolloutLine({ rollout_id: 'supervisor-1', role: 'supervisor', parent_rollout_id: null }),
    fixtureRolloutLine({
      rollout_id: 'proposer-1',
      role: 'proposer',
      outcome: {
        ...base.outcome,
        reward: 0.5,
        reward_source: 'swe-arena-official-judge/candidate-resolved-fraction',
      },
    }),
    fixtureRolloutLine({ rollout_id: 'holdout-1', task: { ...base.task, split: 'holdout' } }),
    fixtureRolloutLine({
      rollout_id: 'gap-1',
      messages: [],
      outcome: { ...base.outcome, reward: 0 },
      provenance: {
        captured_at: '2026-07-23T00:00:00.000Z',
        capture: 'backfill',
        gap: 'store unavailable',
      },
    }),
  ]
}

async function writePilotLedger(): Promise<string> {
  const dir = await makeTempDir()
  const path = join(dir, 'ledger.jsonl')
  await writeRolloutLedger(path, pilotLines())
  return path
}

async function readJsonl(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

describe('buildHfDataset', () => {
  it('builds all formats with fail-closed filters and a scrub report', async () => {
    const ledger = await writePilotLedger()
    const out = join(await makeTempDir(), 'dataset')
    const summary = await buildHfDataset([ledger], {
      out,
      formats: ['sft', 'verifiers', 'rft', 'raw'],
      includeProposers: false,
    })

    expect(summary.read).toBe(5)
    // holdout + proposer dropped: worker, supervisor, gap remain.
    expect(summary.kept).toBe(3)
    expect(summary.scrub.excluded).toEqual({ proposers: 1, nonTrain: 1 })
    expect(summary.formatCounts).toEqual({ sft: 2, verifiers: 2, rft: 2, raw: 3 })

    const raw = (await readJsonl(join(out, 'raw/train.jsonl'))) as RolloutLine[]
    expect(raw).toHaveLength(3)
    expect(raw.map((line) => line.task.split)).toEqual(['search', 'search', 'search'])
    expect(raw.some((line) => line.role === 'proposer')).toBe(false)
    expect(raw[0]!.run_id).toBe('$WORK/runs/gen3#1')
    expect(raw[0]!.messages[1]!.content).toBe(
      'HF_TOKEN=[REDACTED:env] leaked here, hit router.internal.example',
    )

    const sft = (await readJsonl(join(out, 'sft/train.jsonl'))) as Array<{ messages: unknown[] }>
    expect(sft).toHaveLength(2)
    for (const example of sft) expect(Object.keys(example)).toEqual(['messages', 'metadata'])

    const verifiers = (await readJsonl(join(out, 'verifiers/train.jsonl'))) as Array<{
      prompt: unknown[]
      completion: unknown[]
    }>
    expect(verifiers).toHaveLength(2)
    for (const output of verifiers) expect(output.prompt.length).toBeGreaterThan(0)

    const rft = (await readJsonl(join(out, 'rft/train.jsonl'))) as Array<{
      reference: { split: string }
    }>
    expect(rft).toHaveLength(2)
    for (const item of rft) expect(item.reference.split).toBe('search')

    const report = JSON.parse(await readFile(join(out, 'scrub-report.json'), 'utf8'))
    expect(report.files[ledger]['home-path']).toBe(summary.scrub.totals['home-path'])
    expect(report.totals['env-secret']).toBe(1)
    expect(report.totals['infra-host']).toBe(1)

    const card = await readFile(join(out, 'README.md'), 'utf8')
    expect(card).toContain('Total lines: 3')
    expect(card).toContain('license: unknown')
  })

  it('includes proposer lines only with the flag', async () => {
    const ledger = await writePilotLedger()
    const out = join(await makeTempDir(), 'dataset')
    const summary = await buildHfDataset([ledger], {
      out,
      formats: ['raw'],
      includeProposers: true,
    })
    expect(summary.kept).toBe(4)
    expect(summary.scrub.excluded.proposers).toBe(0)
    const raw = (await readJsonl(join(out, 'raw/train.jsonl'))) as RolloutLine[]
    expect(raw.some((line) => line.role === 'proposer')).toBe(true)
  })

  it('is deterministic: two builds from the same ledger are byte-identical', async () => {
    const ledger = await writePilotLedger()
    const outA = join(await makeTempDir(), 'a')
    const outB = join(await makeTempDir(), 'b')
    const options = {
      formats: ['sft', 'verifiers', 'rft', 'raw'] as const,
      includeProposers: false,
    }
    await buildHfDataset([ledger], {
      out: outA,
      formats: [...options.formats],
      includeProposers: options.includeProposers,
    })
    await buildHfDataset([ledger], {
      out: outB,
      formats: [...options.formats],
      includeProposers: options.includeProposers,
    })
    for (const file of [
      'raw/train.jsonl',
      'sft/train.jsonl',
      'verifiers/train.jsonl',
      'rft/train.jsonl',
      'scrub-report.json',
      'README.md',
    ]) {
      expect(await readFile(join(outA, file), 'utf8')).toBe(
        await readFile(join(outB, file), 'utf8'),
      )
    }
  })

  it('never ships a positive reward for a realness-gated run, in any config', async () => {
    const base = fixtureRolloutLine()
    const gamed = fixtureRolloutLine({
      rollout_id: 'gamed-1',
      outcome: { ...base.outcome, reward: 0, realness_gated: true },
    })
    const dir = await makeTempDir()
    const ledger = join(dir, 'gated.jsonl')
    await writeRolloutLedger(ledger, [base, gamed])
    const out = join(dir, 'dataset')
    const summary = await buildHfDataset([ledger], {
      out,
      formats: ['sft', 'verifiers', 'rft', 'raw'],
      includeProposers: false,
    })

    // Every emitted row that belongs to the gamed run, read back off disk.
    const gatedRewards: Record<string, Array<number | null>> = {}
    for (const format of ['sft', 'verifiers', 'rft', 'raw'] as const) {
      const rows = await readJsonl(join(out, FORMAT_FILES[format]))
      gatedRewards[format] = rows
        .filter((row) => JSON.stringify(row).includes('gamed-1'))
        .map((row) => {
          const r = row as {
            reward?: number | null
            metadata?: { reward: number }
            reference?: { reward: number | null }
            outcome?: { reward: number | null }
          }
          if (format === 'sft') return r.metadata?.reward ?? null
          if (format === 'verifiers') return r.reward ?? null
          if (format === 'rft') return r.reference?.reward ?? null
          return r.outcome?.reward ?? null
        })
    }
    expect(gatedRewards.sft).toEqual([])
    expect(gatedRewards.verifiers).toEqual([0])
    expect(gatedRewards.rft).toEqual([0])
    expect(gatedRewards.raw).toEqual([0])
    for (const rewards of Object.values(gatedRewards)) {
      for (const reward of rewards) expect(reward === null || reward <= 0).toBe(true)
    }

    // The flag travels with every shipped gated row — reward 0 alone would be
    // indistinguishable from an honest failure.
    const verifiers = (await readJsonl(join(out, FORMAT_FILES.verifiers))) as Array<{
      info: { rollout_id: string; realness_gated: boolean }
    }>
    expect(verifiers.find((r) => r.info.rollout_id === 'gamed-1')?.info.realness_gated).toBe(true)
    expect(verifiers.find((r) => r.info.rollout_id !== 'gamed-1')?.info.realness_gated).toBe(false)
    const rft = (await readJsonl(join(out, FORMAT_FILES.rft))) as Array<{
      reference: { rollout_id: string; realness_gated: boolean }
    }>
    expect(rft.find((r) => r.reference.rollout_id === 'gamed-1')?.reference.realness_gated).toBe(
      true,
    )
    const raw = (await readJsonl(join(out, FORMAT_FILES.raw))) as RolloutLine[]
    expect(raw.find((l) => l.rollout_id === 'gamed-1')?.outcome.realness_gated).toBe(true)

    // The card's stated counts equal the counts actually on disk.
    expect(summary.gate).toEqual({
      gatedLines: 1,
      byFormat: {
        sft: { input: 1, emitted: 0, excluded: 1, maxEmittedReward: null },
        verifiers: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 },
        rft: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 },
        raw: { input: 1, emitted: 1, excluded: 0, maxEmittedReward: 0 },
      },
    })
    const card = await readFile(join(out, 'README.md'), 'utf8')
    expect(card).toContain('**1 of 2 lines in this release are gated.**')
    expect(card).toContain('| sft | EXCLUDED — an SFT row is an imitation target | 0 | 1 | — |')
    expect(card).toContain('| verifiers | INCLUDED, reward forced to 0, flagged | 1 | 0 | 0 |')
    expect(card).toContain('| rft | INCLUDED, reward forced to 0, flagged | 1 | 0 | 0 |')
    expect(card).toContain('| raw | INCLUDED verbatim, flagged | 1 | 0 | 0 |')
    for (const format of ['sft', 'verifiers', 'rft', 'raw'] as const) {
      const counts = summary.gate.byFormat[format]!
      expect(card).toContain(`| ${format} | `)
      expect(counts.emitted).toBe(gatedRewards[format]!.length)
    }
  })

  it('refuses to write any file when a source ledger pairs a gated run with a reward', async () => {
    const dir = await makeTempDir()
    const ledger = join(dir, 'poisoned.jsonl')
    const poisoned = malformedRolloutLine({ rollout_id: 'poison-1' })
    poisoned.outcome = { ...poisoned.outcome, reward: 0.95, realness_gated: true }
    await writeFile(ledger, `${JSON.stringify(poisoned)}\n`)
    const out = join(dir, 'dataset')
    await expect(
      buildHfDataset([ledger], {
        out,
        formats: ['sft', 'verifiers', 'rft', 'raw'],
        includeProposers: false,
      }),
    ).rejects.toThrow('may not carry a positive reward')
    await expect(readFile(join(out, 'raw/train.jsonl'), 'utf8')).rejects.toThrow('ENOENT')
  })

  it('rejects empty inputs and empty formats', async () => {
    const out = join(await makeTempDir(), 'dataset')
    await expect(
      buildHfDataset([], { out, formats: ['raw'], includeProposers: false }),
    ).rejects.toThrow('no input ledgers')
    const ledger = await writePilotLedger()
    await expect(
      buildHfDataset([ledger], { out, formats: [], includeProposers: false }),
    ).rejects.toThrow('no formats')
  })
})

describe('CLI arg parsing', () => {
  it('parses the documented one-command shape', () => {
    const args = parseRolloutReleaseArgs([
      'a.jsonl',
      'b.jsonl',
      '--out',
      '/tmp/x',
      '--formats',
      'sft,raw',
      '--include-proposers',
    ])
    expect(args).toEqual({
      inputs: ['a.jsonl', 'b.jsonl'],
      out: '/tmp/x',
      formats: ['sft', 'raw'],
      includeProposers: true,
      push: null,
    })
  })

  it('defaults to all formats and no proposers', () => {
    const args = parseRolloutReleaseArgs(['a.jsonl', '--out', '/tmp/x'])
    expect(args.formats).toEqual(['sft', 'verifiers', 'rft', 'raw'])
    expect(args.includeProposers).toBe(false)
  })

  it('rejects unknown formats, unknown flags, missing out, bad push repo', () => {
    expect(() =>
      parseRolloutReleaseArgs(['a.jsonl', '--out', '/tmp/x', '--formats', 'sft,nope']),
    ).toThrow('unknown format "nope"')
    expect(() => parseRolloutReleaseArgs(['a.jsonl', '--out', '/tmp/x', '--frobnicate'])).toThrow(
      'unknown flag',
    )
    expect(() => parseRolloutReleaseArgs(['a.jsonl'])).toThrow('usage:')
    expect(() =>
      parseRolloutReleaseArgs(['a.jsonl', '--out', '/tmp/x', '--push', 'not-a-repo']),
    ).toThrow('--push expects <org/name>')
  })
})

describe('push dry-run', () => {
  it('plans the exact huggingface-cli upload argv without touching the network', () => {
    expect(planPushCommand('tangle/rollouts-gen3', '/tmp/x')).toEqual([
      'huggingface-cli',
      'upload',
      'tangle/rollouts-gen3',
      '/tmp/x',
      '.',
      '--repo-type',
      'dataset',
    ])
  })
})
