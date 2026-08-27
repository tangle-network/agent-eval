/**
 * evalReportingSuite — the one-call wrapper over fromRunRecordDir + analyzeRuns.
 *
 * Covers the four journeys:
 *   - in-memory RunRecord[] → report (no write)
 *   - directory of .json / .jsonl → report (+ analysis.json on disk)
 *   - explicit output path (file and dir forms)
 *   - boundary validation: throw by default, collect on demand
 *
 * The suite must REUSE analyzeRuns — these tests assert the wrapped report is
 * byte-identical to calling analyzeRuns directly, so the wrapper can't drift
 * into reimplementing analysis.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeRuns, evalReportingSuite } from '../src/contract'
import type { RunRecord } from '../src/run-record'

function makeRun(opts: { id: string; candidate: string; composite: number }): RunRecord {
  return {
    runId: opts.id,
    experimentId: 'exp',
    candidateId: opts.candidate,
    seed: 0,
    model: 'm@v',
    promptHash: 'sha256:p',
    configHash: 'sha256:c',
    commitSha: 'abc',
    wallMs: 100,
    costUsd: 0.01,
    tokenUsage: { input: 100, output: 50 },
    outcome: { holdoutScore: opts.composite, raw: {} },
    splitTag: 'holdout',
  } satisfies RunRecord
}

const runs: RunRecord[] = [
  makeRun({ id: 'r1', candidate: 'base', composite: 0.4 }),
  makeRun({ id: 'r2', candidate: 'base', composite: 0.5 }),
  makeRun({ id: 'r3', candidate: 'cand', composite: 0.7 }),
  makeRun({ id: 'r4', candidate: 'cand', composite: 0.8 }),
]

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eval-suite-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('evalReportingSuite', () => {
  it('analyzes in-memory records and matches analyzeRuns exactly', async () => {
    const suite = await evalReportingSuite(runs)
    const direct = await analyzeRuns({ runs })
    expect(suite.report).toEqual(direct)
    expect(suite.provenance.runCount).toBe(4)
    expect(suite.provenance.sourcePath).toBeNull()
    expect(suite.provenance.files).toEqual([])
    expect(suite.writtenTo).toBeNull()
  })

  it('forwards analyze options through to analyzeRuns', async () => {
    const suite = await evalReportingSuite(runs, {
      analyze: { baselineCandidateId: 'base', candidateCandidateId: 'cand' },
    })
    // lift only materializes when a baseline/candidate pair is given
    expect(suite.report.lift).toBeDefined()
    expect(suite.report.lift?.candidateMean).toBeGreaterThan(suite.report.lift?.baselineMean ?? 1)
  })

  it('loads a directory of .json and .jsonl files and writes analysis.json', async () => {
    await writeFile(join(dir, 'a.json'), JSON.stringify(runs.slice(0, 2)), 'utf8')
    await writeFile(
      join(dir, 'b.jsonl'),
      `${runs
        .slice(2)
        .map((r) => JSON.stringify(r))
        .join('\n')}\n`,
      'utf8',
    )

    const suite = await evalReportingSuite(dir, { write: true })
    expect(suite.report.n).toBe(4)
    expect(suite.provenance.sourcePath).toBe(dir)
    expect(suite.provenance.files).toHaveLength(2)
    expect(suite.writtenTo).toBe(join(dir, 'analysis.json'))

    const onDisk = JSON.parse(await readFile(join(dir, 'analysis.json'), 'utf8'))
    expect(onDisk.report.n).toBe(4)
    expect(onDisk.provenance.runCount).toBe(4)
  })

  it('re-running on a directory ignores its own analysis.json output', async () => {
    await writeFile(join(dir, 'a.json'), JSON.stringify(runs), 'utf8')
    const first = await evalReportingSuite(dir, { write: true })
    expect(first.report.n).toBe(4)
    // Second pass must not ingest the analysis.json the first pass wrote.
    const second = await evalReportingSuite(dir, { write: true })
    expect(second.report.n).toBe(4)
    expect(second.provenance.files).toEqual([join(dir, 'a.json')])
  })

  it('loads a single .jsonl file and writes alongside it', async () => {
    const file = join(dir, 'runs.jsonl')
    await writeFile(file, `${runs.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8')
    const suite = await evalReportingSuite(file, { write: true })
    expect(suite.report.n).toBe(4)
    expect(suite.writtenTo).toBe(join(dir, 'analysis.json'))
  })

  it('writes to an explicit file path when write is a string', async () => {
    const out = join(dir, 'nested', 'custom-report.json')
    const suite = await evalReportingSuite(runs, { write: out })
    expect(suite.writtenTo).toBe(out)
    const onDisk = JSON.parse(await readFile(out, 'utf8'))
    expect(onDisk.report.n).toBe(4)
  })

  it('treats a string write target without a .json extension as a directory', async () => {
    const outDir = join(dir, 'reports')
    const suite = await evalReportingSuite(runs, { write: outDir })
    expect(suite.writtenTo).toBe(join(outDir, 'analysis.json'))
    const onDisk = JSON.parse(await readFile(join(outDir, 'analysis.json'), 'utf8'))
    expect(onDisk.report.n).toBe(4)
  })

  it('refuses write:true for in-memory records (no anchor directory)', async () => {
    await expect(evalReportingSuite(runs, { write: true })).rejects.toThrow(/anchor/)
  })

  it('throws on an empty corpus', async () => {
    await expect(evalReportingSuite([])).rejects.toThrow(/no RunRecords/)
    await expect(evalReportingSuite(dir)).rejects.toThrow(/no RunRecords found/)
  })

  it('fails loud on an invalid record by default', async () => {
    await writeFile(
      join(dir, 'bad.jsonl'),
      `${JSON.stringify(runs[0])}\n${JSON.stringify({ runId: 'x' })}\n`,
      'utf8',
    )
    await expect(evalReportingSuite(dir)).rejects.toThrow(/invalid RunRecord/)
  })

  it('collects invalid records when load.onInvalid is "collect"', async () => {
    await writeFile(
      join(dir, 'mixed.jsonl'),
      `${runs.map((r) => JSON.stringify(r)).join('\n')}\n${JSON.stringify({ runId: 'x' })}\n`,
      'utf8',
    )
    const suite = await evalReportingSuite(dir, { load: { onInvalid: 'collect' } })
    expect(suite.report.n).toBe(4)
    expect(suite.provenance.rejected).toHaveLength(1)
    expect(suite.provenance.rejected[0]?.reason).toMatch(/mandatory|missing/i)
  })
})
