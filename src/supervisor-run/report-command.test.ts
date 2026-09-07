/**
 * `agent-eval supervisor-run report <runDir>` through the command driver with
 * captured output: the bytes a terminal would show, and the exit code.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runSupervisorRunCommand, SUPERVISOR_RUN_USAGE } from './report-command'
import type { SupervisorRunReport } from './types'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'supervisor-run')
const NO_WINNER_DIR = join(FIXTURES, 'runtime-run-r1-no-winner')
const FAILED_DIR = join(FIXTURES, 'runtime-run-r1-failed')

interface Captured {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function run(argv: readonly string[]): Promise<Captured> {
  let stdout = ''
  let stderr = ''
  const code = await runSupervisorRunCommand(argv, {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

describe('supervisor-run report', () => {
  it('prints the headline for a settled Runtime run and exits 0', async () => {
    const out = await run(['report', NO_WINNER_DIR])
    expect(out.code).toBe(0)
    expect(out.stderr).toBe('')
    expect(out.stdout.startsWith('RUN-REPORT meta-operator-recursion-smoke-r1')).toBe(true)
    expect(out.stdout).toContain(
      'status=no-winner source=runtime-result reason=all-children-down failure=TypeError:',
    )
    expect(out.stdout.endsWith('\n')).toBe(true)
  })

  it('prints the markdown report on --format markdown', async () => {
    const out = await run(['report', NO_WINNER_DIR, '--format', 'markdown'])
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('# Run report — meta-operator-recursion-smoke-r1')
    expect(out.stdout).toContain('| Supervisor status | no-winner |')
    expect(out.stdout).toContain('| Status source | runtime-result |')
    expect(out.stdout).toContain('| Terminal reason | all-children-down |')
  })

  it('prints the report as JSON on --format=json', async () => {
    const out = await run(['report', NO_WINNER_DIR, '--format=json'])
    expect(out.code).toBe(0)
    const report = JSON.parse(out.stdout) as SupervisorRunReport
    expect(report.outcome.supStatus).toBe('no-winner')
    expect(report.outcome.supStatusSource).toBe('runtime-result')
    expect(report.outcome.failure).toMatchObject({ earlierAttempt: true, name: 'TypeError' })
  })

  it('reports a run that threw before its first spawn', async () => {
    const out = await run(['report', FAILED_DIR])
    expect(out.code).toBe(0)
    expect(out.stdout.startsWith('RUN-REPORT meta-operator-recursion-smoke-r1')).toBe(true)
    expect(out.stdout).toContain(
      'status=failed source=runtime-failure reason=null failure=TypeError: supervise budget.deadlineMs must be a non-negative finite number [runtime-failure at 2026-09-06T05:58:29.604Z]',
    )
  })

  it('exits 1 when the path is not a directory', async () => {
    const missing = join(FIXTURES, 'no-such-run')
    const out = await run(['report', missing])
    expect(out.code).toBe(1)
    expect(out.stdout).toBe('')
    expect(out.stderr).toContain(`${missing} is not a directory`)

    const file = join(NO_WINNER_DIR, 'result.json')
    expect((await run(['report', file])).code).toBe(1)
  })

  it('exits 1 when a terminal record is corrupt', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'supervisor-run-report-'))
    await writeFile(join(runDir, 'failure.json'), '{"runId":"x"}')
    const out = await run(['report', runDir])
    expect(out.code).toBe(1)
    expect(out.stdout).toBe('')
    expect(out.stderr).toContain('Runtime failure record has no error object')
  })

  it('exits 2 on a usage error and 0 on --help', async () => {
    expect(await run([])).toEqual({ code: 2, stdout: `${SUPERVISOR_RUN_USAGE}\n`, stderr: '' })
    expect((await run(['--help'])).code).toBe(0)
    expect((await run(['report', '--help'])).code).toBe(0)

    const verb = await run(['inspect', NO_WINNER_DIR])
    expect(verb.code).toBe(2)
    expect(verb.stderr).toContain('unknown supervisor-run subcommand "inspect"')

    const format = await run(['report', NO_WINNER_DIR, '--format', 'yaml'])
    expect(format.code).toBe(2)
    expect(format.stderr).toContain('--format expects one of headline|markdown|json')

    const flag = await run(['report', NO_WINNER_DIR, '--quiet'])
    expect(flag.code).toBe(2)
    expect(flag.stderr).toContain('unknown flag "--quiet"')

    expect((await run(['report'])).code).toBe(2)
    expect((await run(['report', NO_WINNER_DIR, FAILED_DIR])).code).toBe(2)
  })

  it('is reachable through the agent-eval entry point', async () => {
    // One real process through src/cli.ts proves the dispatch and the flag
    // pass-through; the injected-io cases above cover the command itself.
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'supervisor-run', 'report', FAILED_DIR, '--format=json'],
      { cwd: process.cwd(), env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    )
    expect(stderr).toBe('')
    const report = JSON.parse(stdout) as SupervisorRunReport
    expect(report.outcome.supStatus).toBe('failed')
    expect(report.outcome.supStatusSource).toBe('runtime-failure')
  }, 30_000)
})
