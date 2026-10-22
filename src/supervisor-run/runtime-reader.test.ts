import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'


import { analyzeSupervisorRunSources } from './analyze'



import { readRuntimeSupervisorRun } from './runtime-reader'

import { isUnavailable } from './types'


























describe('journal-less Runtime run dirs — absence is a modeled result', () => {
  it('returns the absent source shape instead of throwing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(parent, 'journal-less')
    await mkdir(runDir, { recursive: true })

    const source = await readRuntimeSupervisorRun(runDir)
    expect(source.journal).toBeNull()
    expect(source.supRunDir).toBeNull()
    expect(source.workers).toBeNull()
    expect(source.instanceId).toBeNull()
    expect(source.journalMissingReason).toBe(
      `no Runtime spawn journal (spawn-journal.jsonl) under ${runDir}`,
    )
    expect(source.workersMissingReason).toBe(source.journalMissingReason)

    const report = analyzeSupervisorRunSources(source)
    expect(report.orchestration.workersSpawned).toEqual({
      unavailable: `no Runtime spawn journal (spawn-journal.jsonl) under ${runDir}`,
    })
    expect(isUnavailable(report.orchestration.supervisorWallMs)).toBe(true)
    expect(isUnavailable(report.economics.totalUsd)).toBe(true)
    expect(isUnavailable(report.economics.brain.tokensIn)).toBe(true)
    expect(report.gaps.length).toBeGreaterThan(0)
  })

  it('still reads a result.json the journal-less run dir carries', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(parent, 'journal-less-with-result')
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'result.json'),
      JSON.stringify({ kind: 'completed', tree: { root: 'orphan-root', nodes: [] } }),
    )

    const source = await readRuntimeSupervisorRun(runDir)
    expect(source.journal).toBeNull()
    expect(source.result).toContain('"kind":"completed"')
  })

  it('throws on the missing journal when strict is set', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'runtime-supervisor-run-'))
    const runDir = join(parent, 'strict-journal-less')
    await mkdir(runDir, { recursive: true })

    await expect(readRuntimeSupervisorRun(runDir, { strict: true })).rejects.toThrow(/ENOENT/)
  })
})
