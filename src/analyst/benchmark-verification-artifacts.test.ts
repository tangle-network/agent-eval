/** `node:fs/promises` is wrapped, not replaced: the artifact is swapped between
 *  `open` and the read that follows it, which reproduces the TOCTOU race the
 *  verification path must refuse. A real filesystem cannot be timed reliably. */
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeTraceBenchRow } from './benchmark-datasets'
import {
  appendVerificationArtifactsToOtlp,
  loadCodeTraceVerificationArtifacts,
  sha256Digest,
} from './benchmark-verification-artifacts'

const fileSystemControl = vi.hoisted(() => ({
  afterOpen: undefined as ((path: string) => Promise<void>) | undefined,
  beforeReadFile: undefined as ((path: string) => Promise<void>) | undefined,
  trackHandleReads: false,
  handleReadCalls: 0,
  pathReadCalls: 0,
  openedPaths: [] as string[],
}))

vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args)
      const openedPath = String(args[0])
      fileSystemControl.openedPaths.push(openedPath)
      if (fileSystemControl.trackHandleReads) {
        const read = handle.read.bind(handle)
        Object.defineProperty(handle, 'read', {
          configurable: true,
          value: (...readArgs: unknown[]) => {
            fileSystemControl.handleReadCalls += 1
            return Reflect.apply(read, handle, readArgs)
          },
        })
      }
      await fileSystemControl.afterOpen?.(openedPath)
      return handle
    },
    async readFile(...args: Parameters<typeof actual.readFile>) {
      const path = String(args[0])
      fileSystemControl.pathReadCalls += 1
      await fileSystemControl.beforeReadFile?.(path)
      return actual.readFile(...args)
    },
  }
})

const temporaryDirectories: string[] = []

afterEach(async () => {
  fileSystemControl.afterOpen = undefined
  fileSystemControl.beforeReadFile = undefined
  fileSystemControl.trackHandleReads = false
  fileSystemControl.handleReadCalls = 0
  fileSystemControl.pathReadCalls = 0
  fileSystemControl.openedPaths.length = 0
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('loadCodeTraceVerificationArtifacts', () => {
  it('keeps unknown result formats explicit without aborting the case', async () => {
    const { artifactDir, row } = await writeResult({ score: 1 })

    const loaded = await loadCodeTraceVerificationArtifacts({ artifactDir, row })

    expect(loaded.manifest).toMatchObject({
      status: 'present',
      outcome: {
        status: 'unavailable',
        reason: 'result-parse-error',
        parseError: {
          class: 'TypeError',
          message: expect.stringContaining('no supported outcome field'),
        },
      },
    })
    expect(loaded.files).toHaveLength(1)
    expect(
      appendVerificationArtifactsToOtlp(
        `${JSON.stringify({
          trace_id: row.traj_id,
          span_id: 'step-1',
          name: 'step',
          start_time: '1970-01-01T00:00:00.000Z',
          end_time: '1970-01-01T00:00:00.001Z',
          attributes: { 'openinference.span.kind': 'LLM' },
        })}\n`,
        row.traj_id,
        loaded,
        '1970-01-01T00:00:00.001Z',
      ),
    ).toContain('benchmark.verification.parse_error')
  })

  it('preserves a recognized SWE-Multi no-results outcome', async () => {
    const { artifactDir, row } = await writeResult(
      {
        valid: false,
        error_msg:
          'After applying the fix patch, no test results were captured when executing the test command. A brief summary is as follows: Test Result Summary:',
        fix_patch_result: {
          passed_count: 0,
          failed_count: 0,
          skipped_count: 0,
          passed_tests: [],
          failed_tests: [],
          skipped_tests: [],
        },
      },
      { solved: true },
    )

    const loaded = await loadCodeTraceVerificationArtifacts({ artifactDir, row })

    expect(loaded.outcome).toMatchObject({
      status: 'unavailable',
      reason: 'result-output-unavailable',
      sources: [{ path: 'results.json', format: 'swe-multi', status: 'unavailable' }],
    })
    expect(loaded.outcome).not.toHaveProperty('parseError')
  })

  it.each([
    { solved: true, resolved: false, parsedStatus: 'failed' },
    { solved: false, resolved: true, parsedStatus: 'passed' },
  ] as const)(
    'marks solved=$solved versus resolved=$resolved unavailable without discarding evidence',
    async ({ solved, resolved, parsedStatus }) => {
      const result = {
        resolved,
        passed_tests: resolved ? ['final-check'] : [],
        failed_tests: resolved ? [] : ['final-check'],
      }
      const { artifactDir, row, content } = await writeResult(result, { solved })

      const loaded = await loadCodeTraceVerificationArtifacts({ artifactDir, row })
      const expectedHash = sha256Digest(content)

      expect(loaded.outcome).toMatchObject({
        status: 'unavailable',
        reason: 'result-label-disagreement',
        parseError: {
          class: 'ResultLabelDisagreementError',
          message: expect.stringContaining(
            `solved=${solved} disagrees with parsed final verification status '${parsedStatus}'`,
          ),
        },
        sources: [
          {
            path: 'results.json',
            format: 'swe-bench',
            status: parsedStatus,
          },
        ],
      })
      expect(loaded.files).toEqual([
        expect.objectContaining({
          path: expect.stringContaining('/results.json'),
          relativePath: 'results.json',
          sha256: expectedHash,
          content,
        }),
      ])
      expect(loaded.manifest.files).toEqual([
        expect.objectContaining({
          path: expect.stringContaining('/results.json'),
          relativePath: 'results.json',
          sha256: expectedHash,
        }),
      ])
    },
  )

  it('uses the parsed result when the CodeTraceBench row has no solved label', async () => {
    const { artifactDir, row } = await writeResult({
      resolved: false,
      passed_tests: ['baseline'],
      failed_tests: ['final-check'],
    })

    const loaded = await loadCodeTraceVerificationArtifacts({ artifactDir, row })

    expect(loaded.outcome).toMatchObject({
      status: 'failed',
      passedChecks: ['baseline'],
      failedChecks: ['final-check'],
      sources: [{ path: 'results.json', format: 'swe-bench', status: 'failed' }],
    })
    expect(loaded.outcome).not.toHaveProperty('reason')
    expect(loaded.outcome).not.toHaveProperty('parseError')
    expect(fileSystemControl.openedPaths.filter((path) => path.endsWith('results.json'))).toEqual([
      expect.stringContaining('/results.json'),
    ])
    expect(fileSystemControl.pathReadCalls).toBe(0)
  })

  it.each([
    [
      'missing required arrays',
      {
        valid: true,
        error_msg: '',
        fix_patch_result: {
          passed_count: 1,
          failed_count: 0,
          skipped_count: 0,
        },
      },
      /passed_tests/,
    ],
    [
      'a contradictory passed result',
      {
        resolved: true,
        passed_tests: ['baseline'],
        failed_tests: ['regression'],
      },
      /cannot be true while failed checks are reported/,
    ],
  ])('marks %s unavailable instead of accepting it', async (_name, result, error) => {
    const { artifactDir, row } = await writeResult(result, { solved: true })

    const loaded = await loadCodeTraceVerificationArtifacts({ artifactDir, row })

    expect(loaded.outcome).toMatchObject({
      status: 'unavailable',
      reason: 'result-parse-error',
      parseError: {
        message: expect.stringMatching(error),
      },
    })
  })

  it('rejects an oversized file before reading or allocating its contents', async () => {
    const { artifactDir, row } = await writeResult({
      resolved: false,
      passed_tests: [],
      failed_tests: ['regression'],
    })
    fileSystemControl.trackHandleReads = true

    await expect(
      loadCodeTraceVerificationArtifacts({ artifactDir, row, maxBytes: 8 }),
    ).rejects.toThrow(/per-file limit/)
    expect(fileSystemControl.handleReadCalls).toBe(0)
    expect(fileSystemControl.pathReadCalls).toBe(0)
  })

  it('enforces the cumulative limit before reading the next file', async () => {
    const { artifactDir, row, resultPath, content } = await writeResult({
      resolved: false,
      passed_tests: [],
      failed_tests: ['regression'],
    })
    const metrics = JSON.stringify({ detail: 'x'.repeat(content.length) })
    await writeFile(join(resultPath, '..', 'run_metrics.json'), metrics)
    const maxBytes = Math.max(Buffer.byteLength(content), Buffer.byteLength(metrics)) + 1

    await expect(
      loadCodeTraceVerificationArtifacts({ artifactDir, row, maxBytes }),
    ).rejects.toThrow(/cumulative limit/)
  })

  it('rejects a result path replaced with an escaping symlink after open', async () => {
    const { artifactDir, row, resultPath } = await writeResult(
      {
        resolved: false,
        passed_tests: [],
        failed_tests: ['original-regression'],
      },
      { solved: false },
    )
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'agent-eval-verification-outside-'))
    temporaryDirectories.push(outsideDirectory)
    const outsidePath = join(outsideDirectory, 'replacement.json')
    await writeFile(
      outsidePath,
      JSON.stringify({
        resolved: true,
        passed_tests: ['forged-success'],
        failed_tests: [],
      }),
    )
    const backupPath = `${resultPath}.opened`
    let swapped = false
    const swap = async (path: string) => {
      if (swapped || path !== resultPath) return
      swapped = true
      await rename(resultPath, backupPath)
      await symlink(outsidePath, resultPath)
    }
    fileSystemControl.afterOpen = swap
    fileSystemControl.beforeReadFile = swap

    await expect(loadCodeTraceVerificationArtifacts({ artifactDir, row })).rejects.toThrow(
      /escapes --artifact-dir|changed while being read/,
    )
    expect(swapped).toBe(true)
  })
})

async function writeResult(
  result: unknown,
  rowOverrides: Partial<CodeTraceBenchRow> = {},
): Promise<{
  artifactDir: string
  row: CodeTraceBenchRow
  content: string
  resultPath: string
}> {
  const artifactDir = await mkdtemp(join(tmpdir(), 'agent-eval-verification-'))
  temporaryDirectories.push(artifactDir)
  const row: CodeTraceBenchRow = {
    traj_id: 'case-1',
    agent: 'mini-SWE-agent',
    model: 'test-model',
    task_name: 'test-task',
    source_relpath: 'runs/case-1',
    step_count: 1,
    incorrect_stages: [],
    ...rowOverrides,
  }
  const caseDirectory = join(artifactDir, row.traj_id, row.source_relpath!)
  await mkdir(caseDirectory, { recursive: true })
  const content = JSON.stringify(result)
  const resultPath = join(caseDirectory, 'results.json')
  await writeFile(resultPath, content)
  return { artifactDir, row, content, resultPath }
}
