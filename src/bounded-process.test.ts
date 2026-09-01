import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBoundedProcess } from './bounded-process'

const posixOnly = process.platform !== 'win32'

/**
 * Prints the shell's own pid, puts the real work in a background descendant,
 * prints that descendant's pid, and waits on it. A detached spawn makes the
 * shell its own group leader, so the shell's pid is also the process-group
 * id. A kill aimed at the shell alone leaves the `sleep` running for its full
 * 60 seconds; a kill aimed at the group takes both. Both writes are shell
 * builtins, so the two pids reach the pipe without a fork or a PATH lookup.
 */
const PGID_PID_THEN_BACKGROUND_SLEEP = 'echo $$; sleep 60 & echo $!; wait'

/** Pids in a process group, read through `pgrep`, whose "no match" exit is 1. */
async function pidsInGroup(pgid: number): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    execFile('pgrep', ['-g', String(pgid)], (error, stdout) => {
      const found = stdout.split('\n').filter((line) => line.trim().length > 0)
      // pgrep exits 1 for "no process matched", which is the answer here, not
      // a failure. Any other non-zero exit means the question went unanswered.
      if (error && (error as { code?: unknown }).code !== 1) {
        reject(error)
        return
      }
      resolve(found)
    })
  })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Reads the group leader's pid and the descendant's pid from stdout. */
function readPids(stdout: string): { pgid: number; descendantPid: number } {
  const lines = stdout.split('\n')
  const pgid = Number.parseInt(lines[0]?.trim() ?? '', 10)
  const descendantPid = Number.parseInt(lines[1]?.trim() ?? '', 10)
  expect(Number.isInteger(pgid) && pgid > 1).toBe(true)
  expect(Number.isInteger(descendantPid) && descendantPid > 1).toBe(true)
  return { pgid, descendantPid }
}

/**
 * The descendant pid is asserted directly so the check cannot pass by asking
 * about the wrong group: a surviving `sleep` answers `kill(pid, 0)` whatever
 * `pgrep` reports.
 */
async function expectTreeGone(stdout: string, budgetMs = 5000): Promise<void> {
  const { pgid, descendantPid } = readPids(stdout)
  const deadline = Date.now() + budgetMs
  let survivors = await pidsInGroup(pgid)
  while ((survivors.length > 0 || pidAlive(descendantPid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    survivors = await pidsInGroup(pgid)
  }
  expect(survivors).toEqual([])
  expect(pidAlive(descendantPid)).toBe(false)
}

describe.skipIf(!posixOnly)('runBoundedProcess kills the whole process group', () => {
  it('leaves no descendant when the deadline kills a shell that backgrounded its work', async () => {
    const started = Date.now()
    const res = await runBoundedProcess({
      command: PGID_PID_THEN_BACKGROUND_SLEEP,
      shell: 'bash',
      timeoutMs: 100,
    })
    const elapsed = Date.now() - started

    expect(res.killedByTimeout).toBe(true)
    expect(res.killedBySignal).toBe(false)
    expect(res.exitCode).not.toBe(0)
    // The command asks for 60s of work. Returning anywhere near that means the
    // kill did not reach the descendant holding the pipes.
    expect(elapsed).toBeLessThan(10_000)

    await expectTreeGone(res.stdout)
  }, 30_000)

  it('a kill that is not aimed at the group leaves the descendant running', async () => {
    // The control for the test above: without `detached`, the shell and its
    // descendant share this process's group, so the only reachable kill is the
    // shell itself — and the descendant survives it.
    const child = spawn(PGID_PID_THEN_BACKGROUND_SLEEP, { shell: 'bash' })
    let stdout = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })

    const deadline = Date.now() + 10_000
    while (stdout.split('\n').length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const descendantPid = Number.parseInt(stdout.split('\n')[1]?.trim() ?? '', 10)
    expect(Number.isInteger(descendantPid) && descendantPid > 1).toBe(true)

    try {
      // `exit` fires when the shell dies. `close` waits for the stdio streams
      // as well, and the descendant still holds them — so a caller that awaits
      // `close`, as a process runner must to collect output, waits forever.
      const exited = new Promise((resolve) => child.once('exit', resolve))
      let closeFired = false
      child.once('close', () => {
        closeFired = true
      })
      child.kill('SIGKILL')
      await exited
      await new Promise((resolve) => setTimeout(resolve, 500))

      expect(pidAlive(descendantPid)).toBe(true)
      expect(closeFired).toBe(false)
    } finally {
      try {
        process.kill(descendantPid, 'SIGKILL')
      } catch {
        // Already gone: nothing to clean up.
      }
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }, 30_000)
})

describe('runBoundedProcess environment handling', () => {
  const parentVar = 'BOUNDED_PROCESS_PARENT_MARKER'
  const namedVar = 'BOUNDED_PROCESS_NAMED'
  // Only shell builtins, so the command runs with no PATH at all.
  const reportEnv = `echo "parent=\${${parentVar}-unset} named=\${${namedVar}-unset}"`

  beforeEach(() => {
    process.env[parentVar] = 'leaked'
  })
  afterEach(() => {
    delete process.env[parentVar]
  })

  it("'replace' gives the child exactly the named variables", async () => {
    const res = await runBoundedProcess({
      command: reportEnv,
      env: { [namedVar]: 'yes' },
      envMode: 'replace',
      timeoutMs: 10_000,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('parent=unset named=yes')
  }, 20_000)

  it("'merge' (the default) keeps the parent's variables", async () => {
    const res = await runBoundedProcess({
      command: reportEnv,
      env: { [namedVar]: 'yes' },
      timeoutMs: 10_000,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('parent=leaked named=yes')
  }, 20_000)
})

describe.skipIf(!posixOnly)('runBoundedProcess shell selection', () => {
  it("shell: 'bash' runs bash, not the platform default shell", async () => {
    const res = await runBoundedProcess({
      command: 'echo "$BASH_VERSION"',
      shell: 'bash',
      timeoutMs: 10_000,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim().length).toBeGreaterThan(0)
  }, 20_000)

  it("shell: 'bash' accepts a construct the POSIX shell has no grammar for", async () => {
    const res = await runBoundedProcess({
      command: 'if [[ -n nonempty ]]; then echo bash-grammar; fi',
      shell: 'bash',
      timeoutMs: 10_000,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe('bash-grammar')
  }, 20_000)
})

describe.skipIf(!posixOnly)('runBoundedProcess abort handling', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bounded-process-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not spawn when the signal is already aborted', async () => {
    const marker = join(dir, 'spawned')
    const res = await runBoundedProcess({
      command: `touch ${marker}`,
      signal: AbortSignal.abort(),
      timeoutMs: 10_000,
    })
    expect(res.killedBySignal).toBe(true)
    expect(res.killedByTimeout).toBe(false)
    expect(res.exitCode).not.toBe(0)
    expect(res.runnerError).toBeTruthy()
    // The only proof that nothing ran: the command's side effect is absent.
    expect(existsSync(marker)).toBe(false)
  }, 20_000)

  it('an abort mid-run kills the group and reports killedBySignal', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300)
    const started = Date.now()
    const res = await runBoundedProcess({
      command: PGID_PID_THEN_BACKGROUND_SLEEP,
      shell: 'bash',
      signal: controller.signal,
      timeoutMs: 60_000,
    })
    clearTimeout(timer)

    expect(res.killedBySignal).toBe(true)
    expect(res.killedByTimeout).toBe(false)
    expect(res.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)

    await expectTreeGone(res.stdout)
  }, 30_000)
})

describe('runBoundedProcess output bounds', () => {
  it('truncates and flags instead of killing the process', async () => {
    const res = await runBoundedProcess({
      command: `node -e "const b='x'.repeat(1024); for(let i=0;i<5000;i++) process.stdout.write(b)"`,
      maxOutputBytes: 4096,
      timeoutMs: 30_000,
    })
    expect(res.outputTruncated).toBe(true)
    expect(res.stdout.length).toBeLessThanOrEqual(4096)
    // Truncation bounds the buffer; it must not become a kill.
    expect(res.killedByTimeout).toBe(false)
    expect(res.killedBySignal).toBe(false)
    expect(res.exitCode).toBe(0)
  }, 60_000)
})

describe('runBoundedProcess reports a completed run verbatim', () => {
  it('returns the real exit code, stdout and stderr with every kill flag clear', async () => {
    const res = await runBoundedProcess({
      command: 'echo to-stdout; echo to-stderr 1>&2; exit 3',
      timeoutMs: 10_000,
    })
    expect(res.exitCode).toBe(3)
    expect(res.stdout.trim()).toBe('to-stdout')
    expect(res.stderr.trim()).toBe('to-stderr')
    expect(res.killedByTimeout).toBe(false)
    expect(res.killedBySignal).toBe(false)
    expect(res.outputTruncated).toBe(false)
    expect(res.runnerError).toBeUndefined()
    expect(res.wallMs).toBeGreaterThanOrEqual(0)
  }, 20_000)

  it('reports a spawn failure as a runner error rather than a clean exit', async () => {
    const res = await runBoundedProcess({
      command: '/nonexistent/bounded-process-binary',
      shell: false,
      timeoutMs: 10_000,
    })
    expect(res.exitCode).not.toBe(0)
    expect(res.runnerError).toContain('ENOENT')
    expect(res.killedByTimeout).toBe(false)
    expect(res.killedBySignal).toBe(false)
  }, 20_000)
})

describe('runBoundedProcess runs an argument vector with no shell', () => {
  let argvScratch: string
  beforeEach(() => {
    argvScratch = mkdtempSync(join(tmpdir(), 'bounded-process-argv-'))
  })
  afterEach(() => {
    rmSync(argvScratch, { recursive: true, force: true })
  })

  it.skipIf(!posixOnly)(
    'delivers an argument the shell form would have to quote',
    async () => {
      // Every metacharacter a shell acts on, in one argument. Under the shell
      // form this text would need quoting, and a quoting bug here executes it.
      const hostile = `'"; rm -rf /; $(echo pwned) \`echo pwned\` $HOME | & \n`
      const res = await runBoundedProcess({
        command: 'printf',
        args: ['%s', hostile],
        timeoutMs: 10_000,
      })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toBe(hostile)
      expect(res.stderr).toBe('')
      expect(res.runnerError).toBeUndefined()
    },
    20_000,
  )

  it.skipIf(!posixOnly)(
    'parses a script under `bash -n` without executing it',
    async () => {
      // The caller this was added for: check that a body parses before running
      // it. `-n` is an argument to bash, which the shell form cannot express.
      const marker = join(argvScratch, 'ran')
      const body = `printf x > ${marker}`

      const parsed = await runBoundedProcess({
        command: 'bash',
        args: ['-n', '-c', body],
        timeoutMs: 10_000,
      })
      expect(parsed.exitCode).toBe(0)
      expect(existsSync(marker)).toBe(false)

      const malformed = await runBoundedProcess({
        command: 'bash',
        args: ['-n', '-c', 'if then'],
        timeoutMs: 10_000,
      })
      expect(malformed.exitCode).not.toBe(0)
      expect(malformed.stderr).toContain('syntax error')
    },
    20_000,
  )

  it.skipIf(!posixOnly)(
    'keeps the deadline, the group kill and the flags',
    async () => {
      const started = Date.now()
      const res = await runBoundedProcess({
        command: 'bash',
        args: ['-c', PGID_PID_THEN_BACKGROUND_SLEEP],
        timeoutMs: 100,
      })
      expect(res.killedByTimeout).toBe(true)
      expect(res.exitCode).not.toBe(0)
      expect(Date.now() - started).toBeLessThan(10_000)
      await expectTreeGone(res.stdout)
    },
    30_000,
  )

  it.skipIf(!posixOnly)(
    'applies `envMode: replace` to the argv form too',
    async () => {
      // Asserting only that the named variable arrived would pass whether or not
      // the parent environment was excluded, so the exclusion is asserted too.
      process.env.BOUNDED_PROCESS_ARGV_PARENT = 'leaked'
      try {
        const res = await runBoundedProcess({
          command: 'bash',
          args: ['-c', 'printf "%s|%s" "$BOUNDED_PROCESS_ARGV_PARENT" "$SECRET"'],
          env: { PATH: process.env.PATH ?? '', SECRET: 'kept' },
          envMode: 'replace',
          timeoutMs: 10_000,
        })
        expect(res.exitCode).toBe(0)
        expect(res.stdout).toBe('|kept')
      } finally {
        delete process.env.BOUNDED_PROCESS_ARGV_PARENT
      }
    },
    20_000,
  )

  it.skipIf(!posixOnly)(
    'an abort mid-run kills the group and reports killedBySignal on the argv form',
    async () => {
      // The abort path shares `killAndDrain` with the shell form, but the flags and
      // the forced non-zero exit had no coverage for an argv caller.
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 150)
      const res = await runBoundedProcess({
        command: 'bash',
        args: ['-c', PGID_PID_THEN_BACKGROUND_SLEEP],
        timeoutMs: 30_000,
        signal: controller.signal,
      })
      expect(res.killedBySignal).toBe(true)
      expect(res.killedByTimeout).toBe(false)
      expect(res.exitCode).not.toBe(0)
      await expectTreeGone(res.stdout)
    },
    40_000,
  )

  it('runs an argument vector on every platform this package supports', async () => {
    // Every other argv case is posix-gated, so a Windows regression in the argv
    // branch could ship unseen. `process.execPath` is the one program guaranteed
    // to exist wherever this test runs.
    const res = await runBoundedProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', 'carried'],
      timeoutMs: 20_000,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('carried')
    expect(res.runnerError).toBeUndefined()
  }, 30_000)

  it('reports a spawn failure as a runner error rather than a clean exit', async () => {
    const res = await runBoundedProcess({
      command: '/nonexistent/bounded-process-binary',
      args: ['--flag'],
      timeoutMs: 10_000,
    })
    expect(res.exitCode).not.toBe(0)
    expect(res.runnerError).toContain('ENOENT')
    expect(res.killedByTimeout).toBe(false)
    expect(res.killedBySignal).toBe(false)
  }, 20_000)

  it('refuses `args` together with a truthy shell instead of quoting them together', async () => {
    const res = await runBoundedProcess({
      command: 'printf',
      args: ['%s', 'never-run'],
      shell: true,
      timeoutMs: 10_000,
    })
    expect(res.exitCode).not.toBe(0)
    expect(res.stdout).toBe('')
    expect(res.runnerError).toContain('never both')
    expect(res.killedByTimeout).toBe(false)
    expect(res.killedBySignal).toBe(false)
  }, 20_000)

  it.skipIf(!posixOnly)(
    'runs the argv form when `shell` is explicitly false',
    async () => {
      const res = await runBoundedProcess({
        command: 'printf',
        args: ['%s', 'ok'],
        shell: false,
        timeoutMs: 10_000,
      })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toBe('ok')
    },
    20_000,
  )
})

describe('runBoundedProcess argv refusal is exactly the documented rule', () => {
  it.skipIf(!posixOnly)(
    'runs the argv form for a falsy shell, which names no shell to contradict it',
    async () => {
      // `shell: ''` names no shell, so there is nothing for the argument vector to contradict.
      // Refusing it here would make the code stricter than the rule it states.
      const res = await runBoundedProcess({
        command: 'printf',
        args: ['%s', 'ok'],
        shell: '',
        timeoutMs: 10_000,
      })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toBe('ok')
      expect(res.runnerError).toBeUndefined()
    },
    20_000,
  )

  it('resolves instead of rejecting when spawn refuses an argument', async () => {
    // `spawn` validates argv synchronously and throws, which inside the executor would
    // reject and break the always-resolves guarantee. A caller grading text it did not
    // author must be able to score that text as failed rather than die on it.
    const res = await runBoundedProcess({
      command: 'printf',
      args: ['%s', 'a\u0000b'],
      timeoutMs: 10_000,
    })
    expect(res.exitCode).not.toBe(0)
    expect(res.runnerError).toContain('null bytes')
    expect(res.killedByTimeout).toBe(false)
    expect(res.killedBySignal).toBe(false)
    expect(res.stdout).toBe('')
  }, 20_000)

  it('refuses a named shell, not just `true`', async () => {
    const res = await runBoundedProcess({
      command: 'printf',
      args: ['%s', 'never-run'],
      shell: 'bash',
      timeoutMs: 10_000,
    })
    expect(res.exitCode).not.toBe(0)
    expect(res.stdout).toBe('')
    expect(res.runnerError).toContain('never both')
  }, 20_000)
})
