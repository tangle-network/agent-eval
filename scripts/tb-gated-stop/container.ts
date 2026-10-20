import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type RepairSession, type TestSuiteFile, testSuiteDigest } from '../../src/trace-repair'
import { readTerminalBenchTestSuite } from '../terminal-bench-test-suite'
import { TB2 } from './settings'

export const run = promisify(execFile)

// ── Containers, replay, grading ──────────────────────────────────────

export interface TaskFixture {
  name: string
  image: string
  cwd: string
  suite: TestSuiteFile[]
  suiteDigest: string
  instruction: string
}

export async function loadTask(name: string): Promise<TaskFixture> {
  const tag = `alexgshaw/${name}:20251031`
  const { stdout: digest } = await run('docker', ['image', 'inspect', tag, '--format', '{{index .RepoDigests 0}}'])
  const { stdout: workdir } = await run('docker', ['image', 'inspect', tag, '--format', '{{.Config.WorkingDir}}'])
  const suite = readTerminalBenchTestSuite(join(TB2, name, 'tests'))
  return {
    name,
    image: digest.trim(),
    cwd: workdir.trim() || '/app',
    suite,
    suiteDigest: testSuiteDigest(suite),
    instruction: readFileSync(join(TB2, name, 'instruction.md'), 'utf8'),
  }
}

interface ExecResult {
  returncode: number
  output: string
  timedOut: boolean
}

export async function openContainer(task: TaskFixture, label: string): Promise<RepairSession & { exec2: (c: string, ms: number) => Promise<ExecResult> }> {
  const name = `gsab-${label}-${randomUUID().slice(0, 8)}`
  await run('docker', [
    'run', '-d', '--name', name, '--entrypoint', '', '--memory', '2g', '--cpus', '1',
    task.image, 'sleep', 'infinity',
  ])
  await run('docker', ['exec', name, 'mkdir', '-p', '/logs/verifier', '/logs/agent', '/logs/artifacts'])
  const exec2 = async (command: string, timeoutMs: number): Promise<ExecResult> => {
    const seconds = Math.ceil(timeoutMs / 1000)
    try {
      const { stdout, stderr } = await run(
        'docker',
        ['exec', '-e', 'DEBIAN_FRONTEND=noninteractive', '-w', task.cwd, name, 'timeout', '--kill-after=5', String(seconds), 'bash', '-lc', command],
        { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 30_000 },
      )
      return { returncode: 0, output: `${stdout}${stderr}`, timedOut: false }
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string }
      const code = typeof err.code === 'number' ? err.code : 1
      return { returncode: code, output: `${err.stdout ?? ''}${err.stderr ?? ''}`, timedOut: code === 124 || code === 137 }
    }
  }
  return {
    ref: name,
    exec: async (command: string, timeoutMs: number) => {
      const r = await exec2(command, timeoutMs)
      return { exitCode: r.returncode, stdout: r.output, stderr: '', timedOut: r.timedOut }
    },
    close: async () => {
      await run('docker', ['rm', '-f', name]).catch(() => undefined)
    },
    exec2,
  }
}
