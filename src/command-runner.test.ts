import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localCommandRunner } from './command-runner'

describe('localCommandRunner', () => {
  it('spawns a subprocess and returns stdout + status 0 on success', async () => {
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: ['-e', "process.stdout.write('hello')"],
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('hello')
    expect(r.timedOut).toBe(false)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('captures non-zero exit code', async () => {
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: ['-e', 'process.exit(7)'],
    })
    expect(r.status).toBe(7)
  })

  it('captures stderr', async () => {
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: ['-e', "process.stderr.write('boom')"],
    })
    expect(r.stderr).toBe('boom')
  })

  it('honors capMs and reports timedOut=true on overrun', async () => {
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      capMs: 100,
    })
    expect(r.timedOut).toBe(true)
  })

  it('merges env overrides on top of process.env', async () => {
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: ['-e', "process.stdout.write(process.env.TEST_VAR ?? 'unset')"],
      env: { TEST_VAR: 'injected' },
    })
    expect(r.stdout).toBe('injected')
  })

  it('runnerError on missing binary', async () => {
    const r = await localCommandRunner.run({
      cmd: 'definitely-not-a-real-binary-xyz-123',
      argv: [],
    })
    expect(r.status).toBeNull()
    expect(r.runnerError).toBeTruthy()
  })

  it('hasBin: true for node, false for nonsense', async () => {
    expect(await localCommandRunner.hasBin('node')).toBe(true)
    expect(await localCommandRunner.hasBin('definitely-not-a-real-binary-xyz-123')).toBe(false)
  })

  it('fileExists / readFile / readDir round-trip', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'cmd-runner-test-'))
    try {
      mkdirSync(join(wd, 'sub'))
      writeFileSync(join(wd, 'a.txt'), 'alpha')
      writeFileSync(join(wd, 'sub', 'b.txt'), 'beta')

      expect(await localCommandRunner.fileExists(join(wd, 'a.txt'))).toBe(true)
      expect(await localCommandRunner.fileExists(join(wd, 'missing.txt'))).toBe(false)

      expect(await localCommandRunner.readFile(join(wd, 'a.txt'))).toBe('alpha')
      expect(await localCommandRunner.readFile(join(wd, 'missing.txt'))).toBeNull()

      const entries = await localCommandRunner.readDir(wd)
      expect(entries.find((e) => e.name === 'a.txt')?.isFile).toBe(true)
      expect(entries.find((e) => e.name === 'sub')?.isDirectory).toBe(true)
      expect(entries.find((e) => e.name === 'a.txt')?.sizeBytes).toBe(5)
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('readDir returns [] on missing path (no throw)', async () => {
    const r = await localCommandRunner.readDir('/tmp/definitely-not-here-xyz')
    expect(r).toEqual([])
  })

  it('CI=1 is set by default in subprocess env', async () => {
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: ['-e', "process.stdout.write(process.env.CI ?? 'unset')"],
    })
    expect(r.stdout).toBe('1')
  })

  it('hasBin resolves a real binary without relying on `which`', async () => {
    // `node` is on PATH in any environment that runs this suite. The
    // resolution must not depend on a `which`/`command -v` subprocess
    // (absent on Windows / minimal containers).
    expect(await localCommandRunner.hasBin('node')).toBe(true)
  })

  it('hasBin resolves an absolute executable path directly', async () => {
    expect(await localCommandRunner.hasBin(process.execPath)).toBe(true)
  })

  it('readFile surfaces a non-ENOENT error instead of collapsing it to null', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'cmd-runner-errno-'))
    try {
      // Reading a directory as a file yields EISDIR, not ENOENT. The old
      // bare `catch { return null }` reported this real IO error as a
      // missing file; the fix must surface (throw) it.
      await expect(localCommandRunner.readFile(wd)).rejects.toThrow()
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('readFile returns null only for genuinely-absent (ENOENT) files', async () => {
    expect(
      await localCommandRunner.readFile('/tmp/cmd-runner-definitely-absent-xyz-123'),
    ).toBeNull()
  })

  it('readDir surfaces a non-ENOENT error instead of reporting an empty dir', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'cmd-runner-errno-dir-'))
    const file = join(wd, 'not-a-dir.txt')
    try {
      writeFileSync(file, 'x')
      // readdir on a regular file yields ENOTDIR, not ENOENT. The old
      // bare `catch { return [] }` masked this as "empty directory."
      await expect(localCommandRunner.readDir(file)).rejects.toThrow()
    } finally {
      rmSync(wd, { recursive: true, force: true })
    }
  })

  it('readDir still returns [] for a genuinely-absent (ENOENT) directory', async () => {
    expect(await localCommandRunner.readDir('/tmp/cmd-runner-no-such-dir-xyz-123')).toEqual([])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'readFile surfaces EACCES (permission) rather than masking it as absent',
    async () => {
      const wd = mkdtempSync(join(tmpdir(), 'cmd-runner-eacces-'))
      const file = join(wd, 'secret.txt')
      try {
        writeFileSync(file, 'classified')
        chmodSync(file, 0o000)
        await expect(localCommandRunner.readFile(file)).rejects.toThrow()
      } finally {
        chmodSync(file, 0o600)
        rmSync(wd, { recursive: true, force: true })
      }
    },
  )
})

describe('localCommandRunner on runBoundedProcess', () => {
  const posixOnly = process.platform !== 'win32'

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('delivers stdin to the command', async () => {
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: ['-e', 'process.stdin.on("data", (c) => process.stdout.write(c))'],
      stdin: 'piped payload',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('piped payload')
  })

  it('closes stdin when the caller sends none, so a reading command still finishes', async () => {
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: [
        '-e',
        'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"))',
      ],
      capMs: 10_000,
    })
    expect(r.status).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.stdout).toBe('eof')
  }, 20_000)

  it.skipIf(!posixOnly)(
    'kills descendants on capMs — regression: the timeout killed the shell and left its grandchild running',
    async () => {
      const r = await localCommandRunner.run({
        cmd: 'sh',
        argv: ['-c', 'sleep 60 & echo $!; wait'],
        capMs: 400,
      })
      expect(r.timedOut).toBe(true)
      expect(r.status).toBeNull()

      const grandchild = Number.parseInt(r.stdout.trim(), 10)
      expect(Number.isInteger(grandchild)).toBe(true)
      // The kill reaches the process group, so the backgrounded sleep is gone.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(pidAlive(grandchild)).toBe(false)
    },
    20_000,
  )

  it('does not block the event loop while the command runs', async () => {
    let timerFired = false
    const timer = setTimeout(() => {
      timerFired = true
    }, 50)
    const r = await localCommandRunner.run({
      cmd: 'node',
      argv: ['-e', 'setTimeout(() => {}, 500)'],
      capMs: 10_000,
    })
    clearTimeout(timer)
    expect(r.status).toBe(0)
    expect(timerFired).toBe(true)
  }, 20_000)
})
