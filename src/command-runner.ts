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

import {
  accessSync,
  existsSync,
  constants as fsConstants,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import { DEFAULT_BOUNDED_PROCESS_TIMEOUT_MS, runBoundedProcess } from './bounded-process'

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
   *
   * Omitting it does NOT mean unbounded: {@link localCommandRunner} then
   * applies {@link LOCAL_COMMAND_RUNNER_DEFAULT_CAP_MS}. A command that
   * legitimately runs longer than that names its own `capMs`; it is never
   * killed silently, because a run stopped by the bound comes back with
   * `timedOut: true` and `status: null`.
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
 * Host-process runner, mapped onto {@link runBoundedProcess} so the package
 * has one spawn site rather than two.
 *
 * It used `spawnSync` and therefore had none of the bounds that runner exists
 * to provide: a `capMs` timeout killed the direct child and left any
 * descendant it had started running, a killed run could still report exit
 * code 0, captured output was unbounded, and the whole run blocked the event
 * loop. This runner spawns build, test and lint commands, which are exactly
 * the commands most likely to start descendants.
 *
 * It is not the package's last private spawn: `nodeProcessRunner`
 * (`src/trace-repair/docker-environment.ts`) and `runProcess`
 * (`src/campaign/external-optimizer-subprocess.ts`) still spawn their own
 * detached children, and several one-shot `spawnSync` git and CLI calls
 * remain. What this removes is the second spawn behind the `CommandRunner`
 * contract, which is the one that graded build, test and lint commands.
 *
 * Two behaviours the mapping changes on purpose:
 *   - a run with no `capMs` is now bounded by
 *     {@link LOCAL_COMMAND_RUNNER_DEFAULT_CAP_MS} instead of running forever;
 *   - the run no longer blocks the event loop, so a minutes-long `capMs` no
 *     longer stalls everything else in the process.
 */
/**
 * Wall clock {@link localCommandRunner} applies when the caller names no
 * `capMs`. It is `runBoundedProcess`'s own default, stated here because this
 * runner used to be unbounded: a consumer whose command runs longer names its
 * own `capMs`, and a run the bound stops says so with `timedOut: true`.
 */
export const LOCAL_COMMAND_RUNNER_DEFAULT_CAP_MS = DEFAULT_BOUNDED_PROCESS_TIMEOUT_MS

export const localCommandRunner: CommandRunner = {
  name: 'local',
  async run(input: RunCommandInput): Promise<RunCommandResult> {
    const result = await runBoundedProcess({
      command: input.cmd,
      args: input.argv,
      envMode: 'merge',
      env: { CI: '1', ...(input.env ?? {}) },
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.capMs === undefined ? {} : { timeoutMs: input.capMs }),
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
    })
    // `status: null` keeps its documented meaning — the process could not
    // start, or it was killed. A stdin payload the child did not drain is
    // neither: that command ran and exited on its own, so it keeps its code.
    const killed = result.killedByTimeout || result.killedBySignal
    return {
      status: killed || !result.spawned ? null : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.wallMs,
      timedOut: result.killedByTimeout,
      ...(result.runnerError === undefined ? {} : { runnerError: result.runnerError }),
    }
  },
  async hasBin(name: string): Promise<boolean> {
    return resolveBinOnPath(name) !== null
  },
  async fileExists(path: string): Promise<boolean> {
    return existsSync(path)
  },
  async readFile(path: string): Promise<string | null> {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      // ENOENT is the only "legitimately absent" signal → null. Any other
      // errno (EACCES, EISDIR, EIO, …) is a real failure that must NOT
      // masquerade as "file not present" — surface it so callers don't
      // treat a permission/IO error as a missing artifact.
      if (isErrnoCode(err, 'ENOENT')) return null
      throw err
    }
  },
  async readDir(path: string): Promise<DirEntry[]> {
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch (err) {
      // Same ENOENT-vs-real-error split as readFile: a missing directory
      // is legitimately empty (→ []); EACCES/ENOTDIR/EIO must surface so
      // an unreadable directory isn't silently reported as having no files.
      if (isErrnoCode(err, 'ENOENT')) return []
      throw err
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
      } catch (err) {
        // An entry that vanished between readdir and stat (TOCTOU) is a
        // benign race → skip. Any other errno surfaces.
        if (isErrnoCode(err, 'ENOENT')) continue
        throw err
      }
    }
    return out
  },
}

function isErrnoCode(err: unknown, code: NodeJS.ErrnoException['code']): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

/**
 * Resolve `name` to an executable absolute path using the runner's PATH,
 * or `null` if not found. Cross-platform: does not depend on `which`
 * (absent on Windows) or a `command -v` shell (absent on minimal
 * containers). On Windows, candidate extensions come from PATHEXT.
 *
 * Throws only on a non-ENOENT/EACCES filesystem error while probing a
 * candidate — those indicate a real IO fault, not "binary absent."
 */
function resolveBinOnPath(name: string): string | null {
  // An explicit path component means PATH lookup doesn't apply: probe directly.
  if (name.includes('/') || name.includes('\\')) {
    return isExecutable(name) ? name : null
  }
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(delimiter).filter((d) => d.length > 0)
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

function isExecutable(path: string): boolean {
  try {
    // On win32 X_OK is a no-op; presence of the file (with a PATHEXT
    // extension) is the executability signal there.
    accessSync(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch (err) {
    // Not found / not executable / not permitted → "not a usable binary
    // here," keep scanning. A different errno (EIO, ELOOP, …) is a real
    // fault and must surface rather than silently yield a false negative.
    if (isErrnoCode(err, 'ENOENT') || isErrnoCode(err, 'EACCES') || isErrnoCode(err, 'ENOTDIR')) {
      return false
    }
    throw err
  }
}
