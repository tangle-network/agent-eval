import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { probeAtomicFileLock, tryAcquireAtomicFileLock } from './atomic-file-lock'
import { DEAD_PID, writeHolderRecord, writeRunnableLockModules } from './lock-holder-test-fixtures'

describe('tryAcquireAtomicFileLock recovery ownership', () => {
  it('recovers when both the writer and its reclaim owner died', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-lock-recovery-'))
    const lockPath = join(directory, 'events.lock')
    const reclaimPath = `${lockPath}.reclaim`
    writeHolderRecord(lockPath, { nonce: 'dead-writer', pid: DEAD_PID })
    writeHolderRecord(reclaimPath, { nonce: 'dead-reclaimer', pid: DEAD_PID })

    try {
      const result = tryAcquireAtomicFileLock({ lockPath })
      expect(result.acquired).toBe(true)
      if (!result.acquired) throw new Error('stale recovery owner blocked acquisition')
      expect(existsSync(reclaimPath)).toBe(false)
      expect(existsSync(`${reclaimPath}.next.dead-reclaimer`)).toBe(false)
      result.lock.release()
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('walks multiple crashed recovery owners without racing an active owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-lock-recovery-chain-'))
    const lockPath = join(directory, 'events.lock')
    const reclaimPath = `${lockPath}.reclaim`
    const successorPath = `${reclaimPath}.next.first-dead-reclaimer`
    writeHolderRecord(lockPath, { nonce: 'dead-writer', pid: DEAD_PID })
    writeHolderRecord(reclaimPath, { nonce: 'first-dead-reclaimer', pid: DEAD_PID })
    writeHolderRecord(successorPath, { nonce: 'second-dead-reclaimer', pid: DEAD_PID })

    try {
      const result = tryAcquireAtomicFileLock({ lockPath })
      expect(result.acquired).toBe(true)
      if (!result.acquired) throw new Error('stale recovery chain blocked acquisition')
      expect(existsSync(reclaimPath)).toBe(false)
      expect(existsSync(successorPath)).toBe(false)
      result.lock.release()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not take over a live reclaim owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-lock-active-recovery-'))
    const lockPath = join(directory, 'events.lock')
    const reclaimPath = `${lockPath}.reclaim`
    writeHolderRecord(lockPath, { nonce: 'dead-writer', pid: DEAD_PID })
    writeHolderRecord(reclaimPath, { nonce: 'active-reclaimer', pid: process.pid })

    try {
      expect(tryAcquireAtomicFileLock({ lockPath })).toEqual({
        acquired: false,
        reason: 'recovery',
      })
      expect(existsSync(reclaimPath)).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('tryAcquireAtomicFileLock dead-holder takeover', () => {
  it('takes over a SIGKILLed holder at once and never a live one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-lock-takeover-'))
    const lockPath = join(directory, 'events.lock')
    const atomicModule = pathToFileURL(writeRunnableLockModules(directory)).href
    const childSource = `
      import { tryAcquireAtomicFileLock } from ${JSON.stringify(atomicModule)}
      const result = tryAcquireAtomicFileLock({ lockPath: process.argv[1] })
      process.stdout.write(result.acquired ? 'ACQUIRED\\n' : 'REJECTED\\n')
      setInterval(() => {}, 1_000)
    `
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', childSource, lockPath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

    try {
      const outcome = await new Promise<string>((resolve, reject) => {
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
          if (stdout.includes('\n')) resolve(stdout.trim())
        })
        child.once('exit', (code) => reject(new Error(`holder exited ${String(code)}: ${stderr}`)))
      })
      expect(outcome).toBe('ACQUIRED')

      const record = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>
      expect(record).toMatchObject({
        pid: child.pid,
        processStart: expect.any(String),
        lock: { dev: expect.any(String), ino: expect.any(String), birthtimeNs: expect.any(String) },
      })
      expect(tryAcquireAtomicFileLock({ lockPath })).toMatchObject({
        acquired: false,
        reason: 'held',
        holder: { pid: child.pid },
      })

      child.kill('SIGKILL')
      await exited

      expect(probeAtomicFileLock({ lockPath })).toBeNull()
      const takeover = tryAcquireAtomicFileLock({ lockPath })
      expect(takeover.acquired).toBe(true)
      if (!takeover.acquired) throw new Error('dead holder kept the lock')
      expect(takeover.lock.owner.pid).toBe(process.pid)
      takeover.lock.release()
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      child.kill('SIGKILL')
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it('refuses a torn record from this boot and reclaims one born before it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-lock-torn-'))
    const lockPath = join(directory, 'events.lock')
    writeFileSync(lockPath, '{"pid":')

    try {
      expect(() => tryAcquireAtomicFileLock({ lockPath })).toThrow(/invalid owner/u)
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + uptime() * 1000 + 10_000)
      const result = tryAcquireAtomicFileLock({ lockPath })
      expect(result.acquired).toBe(true)
      if (result.acquired) result.lock.release()
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
