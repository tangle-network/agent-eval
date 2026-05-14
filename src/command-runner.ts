/**
 * CommandRunner — abstract subprocess execution surface.
 *
 * Layers in a {@link MultiLayerVerifier} that need to invoke external
 * tools (compilers, test runners, package managers) call out via this
 * interface rather than directly using `child_process`. Two reasons:
 *
 *   1. **Sandbox interchangeability.** A run that targets a sandbox box
 *      (via SDK-specific Box.exec) and a run that targets the host both
 *      satisfy this same contract. The harness doesn't care which.
 *   2. **Testability.** Tests inject a fake runner and assert on calls
 *      without spawning real subprocesses.
 *
 * agent-eval ships only the local implementation (host-process). Sandbox
 * implementations live with their consumer because they depend on
 * SDK-specific Box / Sandbox types that don't belong in this package.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ─── Types ──────────────────────────────────────────────────────────────

export interface RunCommandInput {
  /** Executable name, looked up via PATH unless absolute. */
  cmd: string
  /** Argument vector, NOT shell-interpolated. Each element passed to argv. */
  argv: string[]
  /** Working directory. Defaults to runner's notion of cwd if omitted. */
  cwd?: string
  /**
   * Wall-clock cap in ms. The runner SHOULD return `timedOut: true` when
   * exceeded; callers MAY treat status null + timedOut as "killed."
   */
  capMs?: number
  /** Env overrides merged on top of the runner's base environment. */
  env?: Record<string, string>
  /** Optional stdin payload. */
  stdin?: string
}

export interface RunCommandResult {
  /** Exit code, or null when the process couldn't start / was killed. */
  status: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  /** Non-fatal runner-side error (binary missing, signal, etc.). */
  runnerError?: string
}

export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
  /** File size in bytes. `null` for directories (not stat'd). */
  sizeBytes: number | null
}

export interface CommandRunner {
  /** Identifier for telemetry + logs. Open-ended literal-union for new runners. */
  readonly name: string
  /** Execute a command in the runner's environment. */
  run(input: RunCommandInput): Promise<RunCommandResult>
  /** True iff `<name>` resolves on the runner's PATH. */
  hasBin(name: string): Promise<boolean>
  /** True iff the given path exists in the runner's filesystem. */
  fileExists(path: string): Promise<boolean>
  /** Read a file. Returns `null` if missing or unreadable. */
  readFile(path: string): Promise<string | null>
  /** List a directory. Returns `[]` if unreadable / missing. */
  readDir(path: string): Promise<DirEntry[]>
}

// ─── Local runner ───────────────────────────────────────────────────────

/**
 * Host-process runner. Uses node:child_process spawnSync (synchronous
 * under the hood — wrapped in a Promise to satisfy the interface). For
 * very long-running commands consider an async-spawn variant; this
 * shape matches VB's existing behavior and is fine for build/test/lint
 * subprocesses that finish in seconds-to-minutes.
 */
export const localCommandRunner: CommandRunner = {
  name: 'local',
  async run(input: RunCommandInput): Promise<RunCommandResult> {
    const start = Date.now()
    const res = spawnSync(input.cmd, input.argv, {
      cwd: input.cwd,
      encoding: 'utf8',
      timeout: input.capMs,
      env: { ...process.env, CI: '1', ...(input.env ?? {}) },
      input: input.stdin,
    })
    const durationMs = Date.now() - start
    const timedOut = !!(
      res.error &&
      'code' in res.error &&
      (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    )
    return {
      status: res.status ?? null,
      stdout: (res.stdout ?? '').toString(),
      stderr: (res.stderr ?? '').toString(),
      durationMs,
      timedOut,
      runnerError: res.error && !timedOut ? String(res.error.message ?? res.error) : undefined,
    }
  },
  async hasBin(name: string): Promise<boolean> {
    const r = spawnSync('which', [name], { encoding: 'utf8', timeout: 2000 })
    return r.status === 0 && (r.stdout ?? '').trim().length > 0
  },
  async fileExists(path: string): Promise<boolean> {
    return existsSync(path)
  },
  async readFile(path: string): Promise<string | null> {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  async readDir(path: string): Promise<DirEntry[]> {
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch {
      return []
    }
    const out: DirEntry[] = []
    for (const name of entries) {
      try {
        const st = statSync(join(path, name))
        out.push({
          name,
          isDirectory: st.isDirectory(),
          isFile: st.isFile(),
          sizeBytes: st.isFile() ? st.size : null,
        })
      } catch {
        // skip unreadable
      }
    }
    return out
  },
}
