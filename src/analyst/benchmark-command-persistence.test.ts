import { access, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AnalystBenchmarkRunner } from './benchmark'
import {
  ANALYST_BENCHMARK_MANIFEST_FILE,
  ANALYST_BENCHMARK_OBSERVATIONS_FILE,
  readAnalystBenchmarkArtifact,
  runAnalystBenchmarkCommand,
} from './benchmark-command'
import {
  agentRxCommandArgs,
  agentRxFixture,
  progressRows,
  UNKNOWN_USAGE,
} from './benchmark-command.test-support'
import { digestCanonical } from './benchmark-command-artifact'
import { ANALYST_BENCHMARK_INITIALIZATION_COMPLETE_FILE } from './benchmark-command-persistence'
import type { AnalystRunInputs } from './types'

describe('analyst benchmark persistence and resume', () => {
  it('produces the same public identity from identical inputs in different output roots', async () => {
    const first = await agentRxFixture()
    const second = await agentRxFixture()
    const dependencies = {
      createAnalystRunner: () => ({
        id: 'dspy-rlm',
        analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
      }),
    }

    await runAnalystBenchmarkCommand(
      agentRxCommandArgs(first),
      { TEST_ANALYST_KEY: 'unused' },
      dependencies,
    )
    await runAnalystBenchmarkCommand(
      agentRxCommandArgs(second),
      { TEST_ANALYST_KEY: 'unused' },
      dependencies,
    )

    const firstManifest = JSON.parse(
      await readFile(join(first.outDir, ANALYST_BENCHMARK_MANIFEST_FILE), 'utf8'),
    )
    const secondManifest = JSON.parse(
      await readFile(join(second.outDir, ANALYST_BENCHMARK_MANIFEST_FILE), 'utf8'),
    )
    const firstResult = JSON.parse(await readFile(join(first.outDir, 'result.json'), 'utf8'))
    const secondResult = JSON.parse(await readFile(join(second.outDir, 'result.json'), 'utf8'))

    expect(secondManifest.identity).toEqual(firstManifest.identity)
    expect(firstManifest.identitySha256).toBe(digestCanonical(firstManifest.identity))
    expect(secondManifest.identitySha256).toBe(firstManifest.identitySha256)
    expect(secondResult.runIdentitySha256).toBe(firstResult.runIdentitySha256)
    expect(secondManifest.localIdentitySha256).not.toBe(firstManifest.localIdentitySha256)
  })

  it('allows exactly one process to claim a new output directory', async () => {
    const fixture = await agentRxFixture()
    const analyze = vi.fn(() => ({ findings: [], usage: UNKNOWN_USAGE }))
    const dependencies = {
      createAnalystRunner: () => ({ id: 'dspy-rlm', analyze }),
    }

    const attempts = await Promise.allSettled([
      runAnalystBenchmarkCommand(
        agentRxCommandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        dependencies,
      ),
      runAnalystBenchmarkCommand(
        agentRxCommandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        dependencies,
      ),
    ])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    const [rejected] = attempts.filter((attempt) => attempt.status === 'rejected')
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringMatching(/single-run lock held|existing benchmark output directory/),
      }),
    })
    expect(analyze).toHaveBeenCalledOnce()
  })

  it('rejects a second resume while the first resume owns the output lock', async () => {
    const fixture = await agentRxFixture()
    const args = agentRxCommandArgs(fixture)
    await expect(
      runAnalystBenchmarkCommand(
        args,
        { TEST_ANALYST_KEY: 'unused' },
        {
          createAnalystRunner: () => {
            throw new Error('stop after initialization')
          },
        },
      ),
    ).rejects.toThrow('stop after initialization')

    let releaseAnalysis!: () => void
    const analysisReleased = new Promise<void>((resolve) => {
      releaseAnalysis = resolve
    })
    let markAnalysisStarted!: () => void
    const analysisStarted = new Promise<void>((resolve) => {
      markAnalysisStarted = resolve
    })
    const firstResume = runAnalystBenchmarkCommand(
      [...args, '--resume'],
      { TEST_ANALYST_KEY: 'unused' },
      {
        createAnalystRunner: () => ({
          id: 'dspy-rlm',
          async analyze() {
            markAnalysisStarted()
            await analysisReleased
            return { findings: [], usage: UNKNOWN_USAGE }
          },
        }),
      },
    )
    await analysisStarted

    try {
      await expect(
        runAnalystBenchmarkCommand(
          [...args, '--resume'],
          { TEST_ANALYST_KEY: 'unused' },
          {
            createAnalystRunner: () => ({
              id: 'dspy-rlm',
              analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
            }),
          },
        ),
      ).rejects.toThrow(/single-run lock held by live pid/)
    } finally {
      releaseAnalysis()
    }
    await expect(firstResume).resolves.toBe(0)
    await expect(access(`${fixture.outDir}.lock`)).rejects.toThrow()
  })

  it('repairs exact files left by interrupted initialization and writes the marker', async () => {
    const fixture = await agentRxFixture()
    const args = agentRxCommandArgs(fixture)
    await expect(
      runAnalystBenchmarkCommand(
        args,
        { TEST_ANALYST_KEY: 'unused' },
        {
          createAnalystRunner: () => {
            throw new Error('stop after initialization')
          },
        },
      ),
    ).rejects.toThrow('stop after initialization')
    const manifestPath = join(fixture.outDir, ANALYST_BENCHMARK_MANIFEST_FILE)
    const manifestBefore = await readFile(manifestPath, 'utf8')
    await unlink(join(fixture.outDir, ANALYST_BENCHMARK_INITIALIZATION_COMPLETE_FILE))
    await unlink(join(fixture.outDir, ANALYST_BENCHMARK_OBSERVATIONS_FILE))
    await unlink(join(fixture.outDir, 'run.local.json'))

    const analyze = vi.fn(() => ({ findings: [], usage: UNKNOWN_USAGE }))
    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner: () => ({ id: 'dspy-rlm', analyze }) },
      ),
    ).resolves.toBe(0)

    expect(analyze).toHaveBeenCalledOnce()
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
    const marker = JSON.parse(
      await readFile(join(fixture.outDir, ANALYST_BENCHMARK_INITIALIZATION_COMPLETE_FILE), 'utf8'),
    )
    const manifest = JSON.parse(manifestBefore)
    expect(marker).toEqual({
      kind: 'agent-eval/analyst-benchmark-initialization-complete',
      runIdentitySha256: manifest.identitySha256,
      localIdentitySha256: manifest.localIdentitySha256,
      createdAt: manifest.createdAt,
    })
  })

  it('rejects a conflicting partial initialization without publishing the marker', async () => {
    const fixture = await agentRxFixture()
    const args = agentRxCommandArgs(fixture)
    await expect(
      runAnalystBenchmarkCommand(
        args,
        { TEST_ANALYST_KEY: 'unused' },
        {
          createAnalystRunner: () => {
            throw new Error('stop after initialization')
          },
        },
      ),
    ).rejects.toThrow('stop after initialization')
    const markerPath = join(fixture.outDir, ANALYST_BENCHMARK_INITIALIZATION_COMPLETE_FILE)
    const localReceiptPath = join(fixture.outDir, 'run.local.json')
    await unlink(markerPath)
    const localReceipt = JSON.parse(await readFile(localReceiptPath, 'utf8'))
    localReceipt.command = 'conflicting command'
    await writeFile(localReceiptPath, `${JSON.stringify(localReceipt, null, 2)}\n`)
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/local run receipt does not exactly match interrupted initialization/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
    await expect(access(markerPath)).rejects.toThrow()
  })

  it('refuses a report-only output directory before preparing traces or constructing a runner', async () => {
    const fixture = await agentRxFixture()
    await mkdir(fixture.outDir)
    await writeFile(join(fixture.outDir, 'report.md'), 'unrelated report\n')
    await unlink(fixture.labelsPath)
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        agentRxCommandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/existing benchmark output directory/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('rejects symbolic-link output directories and observation logs', async () => {
    const outputFixture = await agentRxFixture()
    const targetDirectory = join(outputFixture.root, 'target-output')
    await mkdir(targetDirectory)
    await symlink(targetDirectory, outputFixture.outDir, 'dir')
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        [...agentRxCommandArgs(outputFixture), '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/output must be a real directory/)

    const logFixture = await agentRxFixture()
    const args = agentRxCommandArgs(logFixture)
    const runner = {
      id: 'dspy-rlm',
      analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
    }
    await runAnalystBenchmarkCommand(
      args,
      { TEST_ANALYST_KEY: 'unused' },
      { createAnalystRunner: () => runner },
    )
    await unlink(join(logFixture.outDir, 'result.json'))
    await unlink(join(logFixture.outDir, 'report.md'))
    const observationPath = join(logFixture.outDir, ANALYST_BENCHMARK_OBSERVATIONS_FILE)
    const targetLog = join(logFixture.root, 'attacker-observations.jsonl')
    await writeFile(targetLog, await readFile(observationPath, 'utf8'))
    await unlink(observationPath)
    await symlink(targetLog, observationPath)

    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/observation log must be a real file/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('persists completed observation rows when finalization is interrupted', async () => {
    const fixture = await agentRxFixture()
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      async analyze() {
        await writeFile(join(fixture.outDir, 'result.json'), 'interrupted finalization\n')
        return { findings: [], usage: UNKNOWN_USAGE }
      },
    }

    await expect(
      runAnalystBenchmarkCommand(
        agentRxCommandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner: () => modelRunner },
      ),
    ).rejects.toThrow(/refusing to replace existing benchmark artifact/)

    const rows = await progressRows(fixture.outDir)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.sequence)).toEqual([0, 1])
    expect(rows.map((row) => row.observation.runnerId).sort()).toEqual(['dspy-rlm', 'empty'])
    await expect(readFile(join(fixture.outDir, 'report.md'), 'utf8')).rejects.toThrow()
  })

  it('resumes only missing jobs without repeating persisted model calls', async () => {
    const fixture = await agentRxFixture()
    const args = [...agentRxCommandArgs(fixture), '--repetitions', '3', '--concurrency', '1']
    const firstCalls: string[] = []
    const firstRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      analyze(_input, context) {
        firstCalls.push(`${context.caseId}/${context.repetition}`)
        return { findings: [], usage: UNKNOWN_USAGE }
      },
    }
    await runAnalystBenchmarkCommand(
      args,
      { TEST_ANALYST_KEY: 'first-secret' },
      { createAnalystRunner: () => firstRunner },
    )
    expect(firstCalls).toHaveLength(3)

    const allRows = await progressRows(fixture.outDir)
    const firstModelRow = allRows.findIndex((row) => row.observation.runnerId === 'dspy-rlm')
    expect(firstModelRow).toBeGreaterThanOrEqual(0)
    const retainedRows = allRows.slice(0, firstModelRow + 1)
    expect(retainedRows.filter((row) => row.observation.runnerId === 'dspy-rlm')).toHaveLength(1)
    await writeFile(
      join(fixture.outDir, ANALYST_BENCHMARK_OBSERVATIONS_FILE),
      `${retainedRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
    await unlink(join(fixture.outDir, 'result.json'))
    await unlink(join(fixture.outDir, 'report.md'))

    const retainedModelKeys = new Set(
      retainedRows
        .filter((row) => row.observation.runnerId === 'dspy-rlm')
        .map((row) => `${row.observation.caseId}/${row.observation.repetition}`),
    )
    const resumedCalls: string[] = []
    const resumedRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      analyze(_input, context) {
        resumedCalls.push(`${context.caseId}/${context.repetition}`)
        return { findings: [], usage: UNKNOWN_USAGE }
      },
    }
    await runAnalystBenchmarkCommand(
      [...args, '--resume'],
      { TEST_ANALYST_KEY: 'second-secret' },
      { createAnalystRunner: () => resumedRunner },
    )

    expect(resumedCalls).toHaveLength(2)
    expect(resumedCalls.every((key) => !retainedModelKeys.has(key))).toBe(true)
    const completedRows = await progressRows(fixture.outDir)
    expect(completedRows).toHaveLength(6)
    expect(
      new Set(
        completedRows.map(
          (row) =>
            `${row.observation.runnerId}/${row.observation.caseId}/${row.observation.repetition}`,
        ),
      ).size,
    ).toBe(6)
    const artifact = await readAnalystBenchmarkArtifact(join(fixture.outDir, 'result.json'))
    expect(artifact.result.observations).toHaveLength(6)
    const persistedRunFiles = `${await readFile(
      join(fixture.outDir, ANALYST_BENCHMARK_MANIFEST_FILE),
      'utf8',
    )}${await readFile(join(fixture.outDir, 'result.json'), 'utf8')}`
    expect(persistedRunFiles).not.toContain('first-secret')
    expect(persistedRunFiles).not.toContain('second-secret')
  })

  it('validates and returns a completed run without another model call', async () => {
    const fixture = await agentRxFixture()
    const args = agentRxCommandArgs(fixture)
    const analyze = vi.fn(() => ({ findings: [], usage: UNKNOWN_USAGE }))
    const createAnalystRunner = vi.fn(() => ({ id: 'dspy-rlm', analyze }))
    await runAnalystBenchmarkCommand(args, { TEST_ANALYST_KEY: 'unused' }, { createAnalystRunner })

    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).resolves.toBe(0)
    expect(createAnalystRunner).toHaveBeenCalledOnce()
    expect(analyze).toHaveBeenCalledOnce()
  })

  it('rejects a resume whose public inputs, local paths, or execution-owner module differ', async () => {
    const fixture = await agentRxFixture()
    const args = agentRxCommandArgs(fixture)
    await runAnalystBenchmarkCommand(
      args,
      { TEST_ANALYST_KEY: 'unused' },
      {
        createAnalystRunner: () => ({
          id: 'dspy-rlm',
          analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
        }),
      },
    )
    await unlink(join(fixture.outDir, 'result.json'))
    await unlink(join(fixture.outDir, 'report.md'))
    const changedArgs = [...args]
    changedArgs[changedArgs.indexOf('--model') + 1] = 'opencode/zai-coding-plan/glm-5.2'
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        [...changedArgs, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/resume configuration or inputs do not match/)
    expect(createAnalystRunner).not.toHaveBeenCalled()

    const changedOwnerArgs = [...args]
    changedOwnerArgs[changedOwnerArgs.indexOf('--model-owner-module') + 1] = 'alternate-test-owner'
    await expect(
      runAnalystBenchmarkCommand(
        [...changedOwnerArgs, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        {
          createAnalystRunner,
          loadModelExecutionOwner: async (_moduleRef, { model }) => ({
            call: async () => {
              throw new Error('resume validation must run before model execution')
            },
            callRef: `test-owner:${model}`,
            recordExecution: () => undefined,
          }),
        },
      ),
    ).rejects.toThrow(/resume configuration or inputs do not match/)
    expect(createAnalystRunner).not.toHaveBeenCalled()

    const alternateLabelsPath = join(fixture.root, 'same-labels-another-path.json')
    await writeFile(alternateLabelsPath, await readFile(fixture.labelsPath, 'utf8'))
    const changedPathArgs = [...args]
    changedPathArgs[changedPathArgs.indexOf('--labels') + 1] = alternateLabelsPath
    await expect(
      runAnalystBenchmarkCommand(
        [...changedPathArgs, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/resume configuration or inputs do not match/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('rejects malformed and duplicate observation log rows before model calls', async () => {
    const fixture = await agentRxFixture()
    const args = agentRxCommandArgs(fixture)
    const runner = {
      id: 'dspy-rlm',
      analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
    }
    await runAnalystBenchmarkCommand(
      args,
      { TEST_ANALYST_KEY: 'unused' },
      { createAnalystRunner: () => runner },
    )
    await unlink(join(fixture.outDir, 'result.json'))
    await unlink(join(fixture.outDir, 'report.md'))
    const observationPath = join(fixture.outDir, ANALYST_BENCHMARK_OBSERVATIONS_FILE)
    const valid = await readFile(observationPath, 'utf8')
    const createAnalystRunner = vi.fn(() => runner)

    await writeFile(observationPath, '{not json}\n')
    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/invalid JSON/)
    expect(createAnalystRunner).not.toHaveBeenCalled()

    const tamperedRows = valid
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    tamperedRows[0].observation.caseTags.push('tampered')
    await writeFile(
      observationPath,
      `${tamperedRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/digest does not match its contents/)
    expect(createAnalystRunner).not.toHaveBeenCalled()

    const [firstLine] = valid.trim().split('\n')
    await writeFile(observationPath, `${valid}${firstLine}\n`)
    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/duplicate benchmark observation/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('rejects completed results whose derived metrics were changed', async () => {
    const fixture = await agentRxFixture()
    const args = agentRxCommandArgs(fixture)
    const createAnalystRunner = vi.fn(() => ({
      id: 'dspy-rlm',
      analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
    }))
    await runAnalystBenchmarkCommand(args, { TEST_ANALYST_KEY: 'unused' }, { createAnalystRunner })
    const resultPath = join(fixture.outDir, 'result.json')
    const artifact = JSON.parse(await readFile(resultPath, 'utf8'))
    artifact.result.summaries[1].failedRuns = 1
    await writeFile(resultPath, `${JSON.stringify(artifact, null, 2)}\n`)

    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/summaries do not match durable observations/)
    expect(createAnalystRunner).toHaveBeenCalledOnce()
  })
})
