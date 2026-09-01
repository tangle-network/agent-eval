/**
 * `runBoundedProcess` — run one command under a wall-clock bound and return
 * what it produced, leaving no descendant behind.
 *
 * The child leads its own process group (`detached` on every non-win32
 * platform), so a deadline or an abort kills the group with
 * `process.kill(-pid, 'SIGKILL')` rather than only the shell that was
 * spawned. That distinction is the whole point of this module: `sh -c
 * 'solver & wait'` puts the real work in a grandchild, and a kill aimed at
 * the shell alone leaves that grandchild running, holding the stdout and
 * stderr pipes open. `close` then never fires, so the deadline produces no
 * result the caller can observe and the descendant outlives the run.
 *
 * Two further guarantees the caller depends on:
 *
 *   - A killed run never reports success. A SIGKILLed child can still close
 *     with exit code 0, so a run killed by the deadline or by an abort has
 *     its exit code forced non-zero.
 *   - A run always resolves. If a grandchild escaped the group and still
 *     holds the pipes, the result is delivered {@link KILL_DRAIN_MS} after
 *     the kill instead of waiting on a `close` that will not come.
 *
 * The captured output is bounded. Once the cap is reached the streams are
 * still drained — the child needs its pipes read to reach `close` — but the
 * bytes are discarded and `outputTruncated` is set.
 */

import { spawn } from 'node:child_process'

/** Wall-clock bound applied when the caller names none. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** Cap on captured stdout+stderr applied when the caller names none. */
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * Window `close` is given after the process group is killed. A grandchild
 * that escaped the group can hold the pipes open indefinitely; the caller
 * receives its result at the end of this window rather than hanging.
 */
const KILL_DRAIN_MS = 2000

/** Exit code reported for a run the wall-clock bound killed (GNU `timeout`). */
const TIMEOUT_EXIT_CODE = 124

/** Exit code reported for a run an `AbortSignal` killed (128 + SIGKILL). */
const ABORT_EXIT_CODE = 137

/** Exit code reported when the process could not be spawned at all. */
const SPAWN_FAILURE_EXIT_CODE = 127

/** Exit code reported when a process closed with no code and was not killed. */
const UNKNOWN_EXIT_CODE = 1

export interface BoundedProcessInput {
  /**
   * The command line, interpreted by a shell unless `shell` is `false`. When
   * {@link BoundedProcessInput.args} is present this is a program path
   * instead, and no shell reads it.
   */
  command: string
  /**
   * Argument vector for `command`, delivered to the program as separate
   * argv entries with no shell between them.
   *
   * This is the form to use whenever an argument carries text the caller did
   * not author — a script body, a path, a pattern. Without it, `interpreter
   * -flag <script>` can only be expressed by quoting the script into a
   * shell string, and a quoting bug there is a command injection rather than
   * a wrong answer. Each entry arrives verbatim, so there is nothing to
   * quote: `{ command: 'bash', args: ['-n', '-c', body] }` parses `body`
   * whatever bytes it holds.
   *
   * A shell cannot interpret an argument vector, so `args` and a truthy
   * `shell` are contradictory. Passing both spawns nothing and reports
   * `runnerError`.
   */
  args?: string[]
  /**
   * Shell that interprets `command`. `true` (the default) uses the platform
   * default — `/bin/sh` on POSIX, `cmd.exe` on Windows. A string names the
   * shell binary, e.g. `'bash'`, which is required for a bash-only construct
   * such as `[[ ]]` or `$BASH_VERSION`. `false` executes `command` directly
   * as a program path with no arguments. Ignored — and refused when truthy —
   * once {@link BoundedProcessInput.args} is present.
   */
  shell?: boolean | string
  /** Working directory. The parent's cwd is inherited when omitted. */
  cwd?: string
  /**
   * Environment for the child. How it combines with the parent environment
   * is decided by {@link BoundedProcessInput.envMode}.
   */
  env?: NodeJS.ProcessEnv
  /**
   * `'merge'` (the default) layers `env` on top of `process.env`, so the
   * child sees every variable this process has plus the named ones.
   * `'replace'` passes exactly `env` and nothing else, which is what a
   * grader needs when the claim under test is about the variables the
   * command could read. `PATH` is not re-added under `'replace'`: a command
   * that must find a binary on `PATH` names `PATH` itself.
   */
  envMode?: 'merge' | 'replace'
  /** Wall-clock bound in ms. Defaults to 10 minutes. */
  timeoutMs?: number
  /**
   * Cap on captured stdout+stderr. Reaching it truncates the captured text
   * and sets `outputTruncated`; it never kills the process. Defaults to
   * 16 MiB.
   */
  maxOutputBytes?: number
  /**
   * Kills the process group when it aborts, the same way the deadline does.
   * A signal that is already aborted when `runBoundedProcess` is called
   * prevents the spawn entirely — nothing runs.
   */
  signal?: AbortSignal
}

export interface BoundedProcessResult {
  /**
   * Exit code. Forced non-zero whenever `killedByTimeout` or
   * `killedBySignal` is set, because a SIGKILLed child can close with 0 and
   * a killed run must never read as a pass.
   */
  exitCode: number
  /** Captured stdout, truncated at `maxOutputBytes`. */
  stdout: string
  /**
   * Captured stderr, truncated at `maxOutputBytes`. A runner-side failure is
   * reported in `runnerError`, not appended here; the caller decides whether
   * the command's own stderr and the runner's diagnosis belong together.
   */
  stderr: string
  /** Wall-clock duration in ms, measured across the whole call. */
  wallMs: number
  /** The wall-clock bound was reached and the process group was killed. */
  killedByTimeout: boolean
  /** `signal` aborted and the process group was killed. */
  killedBySignal: boolean
  /** `maxOutputBytes` was reached and later output was discarded. */
  outputTruncated: boolean
  /**
   * Runner-side failure: the process could not be spawned, or the signal was
   * already aborted so nothing was spawned. Absent when the command itself
   * ran, however it exited.
   */
  runnerError?: string
}

export async function runBoundedProcess(input: BoundedProcessInput): Promise<BoundedProcessResult> {
  const start = Date.now()
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const envMode = input.envMode ?? 'merge'
  const env =
    input.env === undefined && envMode === 'merge'
      ? undefined
      : envMode === 'replace'
        ? { ...input.env }
        : { ...process.env, ...input.env }

  if (input.signal?.aborted) {
    return {
      exitCode: ABORT_EXIT_CODE,
      stdout: '',
      stderr: '',
      wallMs: Date.now() - start,
      killedByTimeout: false,
      killedBySignal: true,
      outputTruncated: false,
      runnerError: 'aborted before spawn: the AbortSignal was already aborted',
    }
  }

  // Reported rather than thrown, because this module's contract is that a
  // call always resolves. A caller bug still reads as a failure and never as
  // a pass: the exit code is non-zero and `runnerError` names the cause.
  if (input.args !== undefined && input.shell !== undefined && input.shell !== false) {
    return {
      exitCode: SPAWN_FAILURE_EXIT_CODE,
      stdout: '',
      stderr: '',
      wallMs: Date.now() - start,
      killedByTimeout: false,
      killedBySignal: false,
      outputTruncated: false,
      runnerError:
        'not spawned: `args` passes an argument vector directly to the program, so a shell ' +
        'cannot interpret it — pass `args` or a truthy `shell`, never both',
    }
  }

  return await new Promise<BoundedProcessResult>((resolve) => {
    const spawnOptions = {
      cwd: input.cwd,
      env,
      // Own process group so a kill reaches the whole tree, not just the
      // shell — otherwise a runaway grandchild keeps the pipes open and
      // `close` never fires.
      detached: process.platform !== 'win32',
    }
    // The argv form takes the same bounds, the same group, and the same kill
    // path; only the shell is absent.
    const child =
      input.args === undefined
        ? spawn(input.command, { ...spawnOptions, shell: input.shell ?? true })
        : spawn(input.command, input.args, { ...spawnOptions, shell: false })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let outputTruncated = false
    let killedByTimeout = false
    let killedBySignal = false
    let settled = false

    // Bound the in-memory buffer so a runaway process can't OOM the caller.
    // Once the cap is hit the streams are still drained (the child needs them
    // read to reach `close`) but the bytes are discarded.
    function capture(s: string): string {
      if (outputBytes >= maxOutputBytes) {
        outputTruncated = true
        return ''
      }
      const room = maxOutputBytes - outputBytes
      if (s.length > room) {
        outputBytes = maxOutputBytes
        outputTruncated = true
        return s.slice(0, room)
      }
      outputBytes += s.length
      return s
    }

    const onStdout = (d: unknown) => {
      const chunk = capture(String(d))
      if (chunk) stdout += chunk
    }
    const onStderr = (d: unknown) => {
      const chunk = capture(String(d))
      if (chunk) stderr += chunk
    }

    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)

    let forceResolve: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      clearTimeout(timeout)
      if (forceResolve) clearTimeout(forceResolve)
      input.signal?.removeEventListener('abort', onAbort)
      child.stdout?.off('data', onStdout)
      child.stderr?.off('data', onStderr)
      child.removeAllListeners('close')
      child.removeAllListeners('error')
    }

    // Resolve exactly once. `code` comes from `close`; on a kill path the
    // exit code is forced non-zero so a SIGKILLed child that reports 0 can
    // never read as a clean pass downstream.
    const finish = (outcome: { code: number | null; runnerError?: string }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        exitCode: exitCodeFor(outcome.code, killedByTimeout, killedBySignal),
        stdout,
        stderr,
        wallMs: Date.now() - start,
        killedByTimeout,
        killedBySignal,
        outputTruncated,
        runnerError: outcome.runnerError,
      })
    }

    // SIGKILL the whole process group (we spawned detached). On a clean close
    // this never runs.
    const killTree = () => {
      try {
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          process.kill(-child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      } catch (err) {
        // ESRCH means the group exited between the decision to kill and the
        // signal, which `close` reports on its own. Anything else means the
        // group may still be running, which the caller must hear about.
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          console.warn('[bounded-process] SIGKILL of the process group failed:', err)
        }
      }
    }

    // Give `close` a brief window to fire (flushing any final output) after
    // the group dies; if an orphaned grandchild keeps the pipes open, resolve
    // anyway so the caller can't hang on a runaway. The deadline and an abort
    // can both fire, so the kill happens at most once and the drain window is
    // not restarted by the second one.
    let killed = false
    const killAndDrain = () => {
      if (killed) return
      killed = true
      killTree()
      forceResolve = setTimeout(() => finish({ code: null }), KILL_DRAIN_MS)
    }

    function onAbort() {
      if (settled) return
      killedBySignal = true
      killAndDrain()
    }

    const timeout = setTimeout(() => {
      killedByTimeout = true
      killAndDrain()
    }, timeoutMs)

    input.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('close', (code) => {
      if (forceResolve) clearTimeout(forceResolve)
      finish({ code })
    })
    child.on('error', (err) => {
      if (forceResolve) clearTimeout(forceResolve)
      finish({ code: SPAWN_FAILURE_EXIT_CODE, runnerError: String(err) })
    })
  })
}

/**
 * A killed run reports the code the child closed with only when that code is
 * already non-zero; otherwise it reports the conventional code for the kind
 * of kill. A run that closed on its own with no code at all reports 1.
 */
function exitCodeFor(
  code: number | null,
  killedByTimeout: boolean,
  killedBySignal: boolean,
): number {
  if (code !== null && code !== 0) return code
  if (killedByTimeout) return TIMEOUT_EXIT_CODE
  if (killedBySignal) return ABORT_EXIT_CODE
  return code ?? UNKNOWN_EXIT_CODE
}
