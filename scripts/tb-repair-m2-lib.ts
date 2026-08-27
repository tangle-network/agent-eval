/**
 * Shared fixtures for the milestone 2 phases.
 *
 * The run is split into three phases so the model seat is held only while
 * models are called:
 *
 *   admit     containers, no model. Replays every row, runs both admission
 *             controls, and grades the two deterministic arms.
 *   analyze   models, no container. Re-derives each admitted row from its
 *             recorded evidence and asks every analyst arm for one finding.
 *   grade     containers, no model. Executes each analyst's finding through
 *             the same grader the deterministic arms went through.
 *
 * `AdmittedRow` is phantom-branded and cannot be deserialized, so the phases
 * carry `AdmissionEvidence` between them and re-run `admitRow`. That decision
 * is pure, so re-deriving costs nothing and keeps the guarantee that no row
 * reaches an analyst without the four executed checks.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  injectedTestOracle,
  type RepairContinuationOutcome,
  type RepairContinuationRunner,
  type RepairSession,
  type RepairSessionFactory,
  type RepairSessionRequest,
  type TestOracle,
  type TestSuiteFile,
  testSuiteDigest,
} from '../src/trace-repair'

const run = promisify(execFile)

export const REPO = '/home/drew/bench-cache/terminal-bench-2'
export const WORK = '/home/drew/bench-cache/t8-milestone2'
export const CONTROL_ROLLOUTS = 3
export const INERT_PROBE_ACTION = 'ls -la / > /tmp/tbr-probe.txt'
export const STEP_TIMEOUT_MS = 300_000
export const VERIFIER_TIMEOUT_MS = 900_000
export const RECORDED_TIMEOUT_STEP_MS = 60_000
const RECORDED_TIMEOUT_MARKER = 'timed out and has been killed'

export function stepTimeoutMs(observation: string | null): number {
  return observation !== null && observation.includes(RECORDED_TIMEOUT_MARKER)
    ? RECORDED_TIMEOUT_STEP_MS
    : STEP_TIMEOUT_MS
}

/** Zero model steps, identical to milestone 1, so t4 collapses onto t3 for
 *  every arm equally rather than for one of them. */
export const ZERO_STEP_CONTINUATION_POLICY = {
  id: 'zero-step-continuation',
  digest: 'zero-step-continuation@v1',
} as const

export const zeroStepContinuation: RepairContinuationRunner = async (): Promise<
  RepairContinuationOutcome
> => ({
  policyId: ZERO_STEP_CONTINUATION_POLICY.id,
  policyDigest: ZERO_STEP_CONTINUATION_POLICY.digest,
  steps: 0,
  exitStatus: 'zero-step-policy',
  submitted: false,
})

export interface FeasibleRow {
  rowId: string
  taskName: string
  recordedModel: string
  recordedCommands: number
  unknownReturncodes: number
  unknownRatio: number
  finalReturncode: number | null
  steps: { step_id: number; action: string; observation: string | null }[]
}

export interface TaskFixture {
  name: string
  image: string
  cwd: string
  suite: readonly TestSuiteFile[]
  suiteDigest: string
  oracleAction: string
  instruction: string
}

function loadSuite(task: string): TestSuiteFile[] {
  const dir = join(REPO, task, 'tests')
  const files: TestSuiteFile[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry
      if (statSync(join(dir, relPath)).isDirectory()) walk(relPath)
      else files.push({ path: `/tests/${relPath}`, contents: readFileSync(join(dir, relPath), 'utf8') })
    }
  }
  walk('')
  return files
}

async function imageDigest(image: string): Promise<string> {
  const { stdout } = await run('docker', [
    'image',
    'inspect',
    image,
    '--format',
    '{{index .RepoDigests 0}}',
  ])
  return stdout.trim()
}

export async function loadTask(name: string): Promise<TaskFixture> {
  const tag = `alexgshaw/${name}:20251031`
  const { stdout: workdir } = await run('docker', [
    'image',
    'inspect',
    tag,
    '--format',
    '{{.Config.WorkingDir}}',
  ])
  const suite = loadSuite(name)
  const body = readFileSync(join(REPO, name, 'solution', 'solve.sh'), 'utf8').replace(
    /^#![^\n]*\n/,
    '',
  )
  return {
    name,
    image: await imageDigest(tag),
    cwd: workdir.trim() || '/app',
    suite,
    suiteDigest: testSuiteDigest(suite),
    oracleAction: `{\n${body}\n}`,
    instruction: readFileSync(join(REPO, name, 'instruction.md'), 'utf8'),
  }
}

export function dockerSessions(image: string, cwd: string): RepairSessionFactory {
  return {
    async open(request: RepairSessionRequest): Promise<RepairSession> {
      const name = `tbr2-${request.arm}-${request.rolloutIndex}-${randomUUID().slice(0, 8)}`
      await run('docker', [
        'run',
        '-d',
        '--name',
        name,
        '--entrypoint',
        '',
        '--memory',
        '2g',
        '--cpus',
        '1',
        image,
        'sleep',
        'infinity',
      ])
      await run('docker', ['exec', name, 'mkdir', '-p', '/logs/verifier', '/logs/agent', '/logs/artifacts'])
      return {
        ref: name,
        async exec(command: string, timeoutMs: number) {
          const seconds = Math.ceil(timeoutMs / 1000)
          try {
            const { stdout, stderr } = await run(
              'docker',
              [
                'exec',
                '-e',
                'DEBIAN_FRONTEND=noninteractive',
                '-w',
                cwd,
                name,
                'timeout',
                '--kill-after=5',
                String(seconds),
                'bash',
                '-lc',
                command,
              ],
              { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 30_000 },
            )
            return { exitCode: 0, stdout, stderr, timedOut: false }
          } catch (error) {
            const err = error as { code?: number; stdout?: string; stderr?: string }
            const exitCode = typeof err.code === 'number' ? err.code : 1
            return {
              exitCode,
              stdout: err.stdout ?? '',
              stderr: err.stderr ?? '',
              timedOut: exitCode === 124 || exitCode === 137,
            }
          }
        },
        async close() {
          await run('docker', ['rm', '-f', name]).catch(() => undefined)
        },
      }
    },
  }
}

export function taskOracle(task: TaskFixture): TestOracle {
  return injectedTestOracle({
    files: task.suite,
    command:
      'chmod +x /tests/test.sh; rm -f /logs/verifier/reward.txt; ' +
      '(/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1; ' +
      'grep -qx 1 /logs/verifier/reward.txt',
    purge: ['/tests'],
    commandTimeoutMs: VERIFIER_TIMEOUT_MS,
  })
}

export function recordedReturncode(observation: string | null): number | null {
  if (!observation) return null
  const m = /<returncode>(-?\d+)<\/returncode>/.exec(observation)
  return m ? Number(m[1]) : null
}

export function stratumOfRow(finalReturncode: number | null): string {
  if (finalReturncode === 0) return 'clean-exit'
  return (finalReturncode ?? 0) < 0 ? 'signal-kill' : 'command-error'
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        results[index] = await fn(items[index]!, index)
      }
    }),
  )
  return results
}

export function makeLogger(write: (line: string) => void): (m: string) => void {
  return (message: string): void => {
    const line = `${new Date().toISOString()} ${message}\n`
    process.stdout.write(line)
    write(line)
  }
}

/**
 * The measurement seat.
 *
 * `mkdir` is the mutex: it succeeds for exactly one process. Every phase that
 * calls a model takes it and releases it in a `finally`, so a crash between the
 * two is the only way it leaks — which is exactly how the stale lock this run
 * inherited was created.
 *
 * A lock held by someone else is waited for, never removed. Reclaiming a lock
 * whose owner is gone is a separate, deliberate, evidenced act; it is not
 * something a runner does on its own.
 */
export const SEAT = '/tmp/ctb-llm-mutex.lock'

export async function acquireSeat(
  label: string,
  log: (m: string) => void,
  maxWaitMs = 6 * 60 * 60_000,
): Promise<() => void> {
  const waitStarted = Date.now()
  for (;;) {
    try {
      mkdirSync(SEAT)
      const owner = join(SEAT, 'owner')
      const stamp = `${process.pid} ${label} ${new Date().toISOString()}\n`
      writeFileSync(owner, stamp)
      log(`seat acquired after ${Math.round((Date.now() - waitStarted) / 1000)}s`)
      let released = false
      return () => {
        if (released) return
        released = true
        // Release only what this process still owns. Between acquiring and
        // releasing, an operator may have judged this holder dead and handed
        // the seat on; removing the directory then would evict the live holder
        // rather than free anything.
        let held: string
        try {
          held = readFileSync(owner, 'utf8')
        } catch {
          log('seat release skipped: owner file is gone, the seat is no longer ours')
          return
        }
        if (held !== stamp) {
          log(`seat release skipped: owner file names ${held.trim()}, not this process`)
          return
        }
        try {
          unlinkSync(owner)
          rmdirSync(SEAT)
          log('seat released')
        } catch (error) {
          log(`seat release failed: ${(error as Error).message}`)
        }
      }
    } catch {
      if (Date.now() - waitStarted > maxWaitMs) throw new Error(`seat not free after ${maxWaitMs}ms`)
      await new Promise((resolve) => setTimeout(resolve, 20_000))
    }
  }
}
