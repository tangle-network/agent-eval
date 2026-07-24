import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSupervisorRunSources } from './analyze'
import {
  fixtureJournal as journal,
  fixtureState as state,
  fixtureWorker as worker,
} from './fixtures'
import {
  analyzeSupervisorRun,
  findSupervisorRunDirs,
  loopsSupervisorRunReader,
  readLoopsSupervisorRun,
  writeSupervisorRunReport,
} from './loops-reader'
import { renderSupervisorRunMarkdown } from './render'
import { isUnavailable, SUPERVISOR_RUN_SCHEMA } from './types'

async function makeRun(opts: { steers?: boolean; withJudge?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-run-test-'))
  const runDir = join(root, 'runs', 'inst-9', 'ARM')
  const sup = join(runDir, 'ws', '.loops', 'supervisor', 'sup-1-abc')
  await mkdir(join(sup, 'workers'), { recursive: true })
  await writeFile(
    join(sup, 'journal.jsonl'),
    journal({
      workers: [
        ['a', 10, 100],
        ['b', 150, 220],
      ],
    }),
  )
  await writeFile(join(sup, 'state.json'), state({ startSec: 0, endSec: 300 }))
  const w0 = worker('w-0', {
    startSec: 10,
    finishSec: 100,
    passed: true,
    patchBytes: 40,
    ...(opts.steers ? { steers: ['refocus'] } : {}),
  })
  await writeFile(join(sup, 'workers', 'w-0.ndjson'), w0.events ?? '')
  if (w0.inbox !== null) await writeFile(join(sup, 'workers', 'w-0.inbox.ndjson'), w0.inbox)
  await writeFile(join(sup, 'workers', 'w-0.patch'), 'x'.repeat(40))
  const patchPath = join(root, 'delivered.patch')
  await writeFile(patchPath, '+++ b/src/a.ts\n+line\n')
  await writeFile(
    join(runDir, 'result.json'),
    JSON.stringify({ iid: 'inst-9', arm: 'ARM', verify_pass: true, verify_rc: 0, patchPath }),
  )
  if (opts.withJudge) {
    await writeFile(join(runDir, 'judge.json'), JSON.stringify({ resolved: true, score: 1 }))
  }
  await writeFile(join(runDir, 'driver.log'), '[driver] registered tools: supervisor_steer\n')
  return runDir
}

describe('loops reader + writeSupervisorRunReport over a real run directory', () => {
  it('reads a run end to end and writes both artifacts + the log headline', async () => {
    const runDir = await makeRun({ steers: true, withJudge: true })
    const logPath = join(runDir, '..', '..', '..', 'run.log')
    await writeFile(logPath, '')
    const report = await writeSupervisorRunReport(runDir, {
      opencodeDb: null,
      appendHeadlineTo: logPath,
      echo: false,
    })

    expect(report.orchestration.steers).toBe(1)
    expect(report.orchestration.workersSpawned).toBe(2)
    expect(report.outcome.judgeResolved).toBe(true)
    expect(report.outcome.verifyPass).toBe(true)
    expect(report.instanceId).toBe('inst-9')

    const json = JSON.parse(await readFile(join(runDir, 'run-report.json'), 'utf8')) as {
      orchestration: { steers: number }
    }
    expect(json.orchestration.steers).toBe(1)
    const md = await readFile(join(runDir, 'run-report.md'), 'utf8')
    expect(md).toContain('# Run report — inst-9 [ARM]')
    const log = await readFile(logPath, 'utf8')
    expect(log).toContain('RUN-REPORT inst-9 [ARM]')
    expect(log).toContain('steers=1 queued / 1 delivered')
  })

  it('reports a steer-free run as 0, and falls back to the ledger for the verdict', async () => {
    const runDir = await makeRun()
    const ledger = join(runDir, '..', '..', '..', 'ledger.jsonl')
    await writeFile(
      ledger,
      `${JSON.stringify({ iid: 'inst-9', arm: 'ARM', resolved: false, score: 0.43, passed: 13, total: 30 })}\n`,
    )
    const src = await readLoopsSupervisorRun(runDir, { opencodeDb: null, ledgerPath: ledger })
    const report = analyzeSupervisorRunSources(src)
    expect(report.orchestration.steers).toBe(0)
    expect(report.outcome.judgeResolved).toBe(false)
    expect(report.outcome.judgeScore).toBe(0.43)
    expect(report.outcome.judgeSource).toContain('ledger row')
  })

  it('honours reportDir so a READ-ONLY run directory is never written to', async () => {
    const runDir = await makeRun()
    const dest = await mkdtemp(join(tmpdir(), 'supervisor-run-out-'))
    await writeSupervisorRunReport(runDir, { opencodeDb: null, reportDir: dest, echo: false })
    await expect(readFile(join(runDir, 'run-report.json'), 'utf8')).rejects.toThrow()
    const written = await readFile(join(dest, 'inst-9.ARM.json'), 'utf8')
    expect(JSON.parse(written)).toMatchObject({ schema: SUPERVISOR_RUN_SCHEMA })
  })

  it('produces an all-unavailable report for a run directory with no artifacts at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervisor-run-empty-'))
    const runDir = join(root, 'runs', 'inst-0', 'ARM')
    await mkdir(runDir, { recursive: true })
    const report = await writeSupervisorRunReport(runDir, { opencodeDb: null, echo: false })
    expect(isUnavailable(report.orchestration.steers)).toBe(true)
    expect(isUnavailable(report.orchestration.workersSpawned)).toBe(true)
    expect(report.gaps.length).toBeGreaterThan(3)
    expect(renderSupervisorRunMarkdown(report)).toContain('unavailable —')
  })

  it('discovers every runs/<iid>/<arm> run directory under an out dir', async () => {
    const runDir = await makeRun()
    const outDir = join(runDir, '..', '..', '..')
    const found = await findSupervisorRunDirs(outDir)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('/runs/inst-9/ARM')
  })
})

describe('analyzeSupervisorRun input contract', () => {
  it('accepts a run dir, a reader, and already-read sources interchangeably', async () => {
    const runDir = await makeRun({ steers: true })
    const fromDir = await analyzeSupervisorRun(runDir, { opencodeDb: null })
    const fromReader = await analyzeSupervisorRun(
      loopsSupervisorRunReader(runDir, { opencodeDb: null }),
    )
    const fromSources = await analyzeSupervisorRun(
      await readLoopsSupervisorRun(runDir, { opencodeDb: null }),
    )
    for (const r of [fromReader, fromSources]) {
      expect({ ...r, generatedAt: '' }).toEqual({ ...fromDir, generatedAt: '' })
    }
  })

  it('serves a custom reader that never touches the filesystem', async () => {
    const sources = await readLoopsSupervisorRun(await makeRun({ steers: true }), {
      opencodeDb: null,
    })
    const inMemory = {
      runRef: 'memory://run-1',
      read: async () => ({ ...sources, runRef: 'memory://run-1' }),
    }
    const report = await analyzeSupervisorRun(inMemory)
    expect(report.runRef).toBe('memory://run-1')
    expect(report.orchestration.steers).toBe(1)
  })
})
