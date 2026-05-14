import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
