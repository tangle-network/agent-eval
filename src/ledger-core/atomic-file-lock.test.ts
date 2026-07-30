import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type AtomicFileLockOwner, tryAcquireAtomicFileLock } from './atomic-file-lock'

const DEAD_PID = 999_999_999

describe('tryAcquireAtomicFileLock recovery ownership', () => {
  it('recovers when both the writer and its reclaim owner died', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-lock-recovery-'))
    const lockPath = join(directory, 'events.lock')
    const reclaimPath = `${lockPath}.reclaim`
    writeOwner(lockPath, { host: hostname(), nonce: 'dead-writer', pid: DEAD_PID })
    writeOwner(reclaimPath, { host: hostname(), nonce: 'dead-reclaimer', pid: DEAD_PID })

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
    writeOwner(lockPath, { host: hostname(), nonce: 'dead-writer', pid: DEAD_PID })
    writeOwner(reclaimPath, {
      host: hostname(),
      nonce: 'first-dead-reclaimer',
      pid: DEAD_PID,
    })
    writeOwner(successorPath, {
      host: hostname(),
      nonce: 'second-dead-reclaimer',
      pid: DEAD_PID,
    })

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
    const active = { host: hostname(), nonce: 'active-reclaimer', pid: process.pid }
    writeOwner(lockPath, { host: hostname(), nonce: 'dead-writer', pid: DEAD_PID })
    writeOwner(reclaimPath, active)

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

function writeOwner(path: string, owner: AtomicFileLockOwner): void {
  writeFileSync(path, `${JSON.stringify(owner)}\n`, 'utf8')
}
