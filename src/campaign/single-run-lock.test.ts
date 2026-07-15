import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireSingleRunLock } from './single-run-lock'

const dir = () => mkdtempSync(join(tmpdir(), 'single-run-lock-'))

describe('acquireSingleRunLock', () => {
  it('acquires, records the pid, and releases idempotently', () => {
    const lockPath = join(dir(), 'gym.lock')
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))
    lock.release()
    lock.release()
    expect(() => acquireSingleRunLock({ lockPath, releaseOnExit: false }).release()).not.toThrow()
  })

  it('throws naming a live holder', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeFileSync(lockPath, String(process.pid)) // this test process IS the live holder
    expect(() =>
      acquireSingleRunLock({ lockPath, pid: process.pid + 1, releaseOnExit: false }),
    ).toThrow(/held by live pid/)
  })

  it('reclaims a stale lock whose holder pid is gone', () => {
    const lockPath = join(dir(), 'gym.lock')
    writeFileSync(lockPath, '999999999') // beyond pid_max: never a live process
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))
    lock.release()
  })

  it('respects other runners lockfiles via alsoCheck without writing them', () => {
    const d = dir()
    const mine = join(d, 'mine.lock')
    const theirs = join(d, 'theirs.lock')
    writeFileSync(theirs, String(process.pid))
    expect(() =>
      acquireSingleRunLock({
        lockPath: mine,
        alsoCheck: [theirs],
        pid: process.pid + 1,
        releaseOnExit: false,
      }),
    ).toThrow(/theirs\.lock/)
    // their lock untouched
    expect(readFileSync(theirs, 'utf8')).toBe(String(process.pid))
  })

  it('does not release a lock another process re-acquired', () => {
    const lockPath = join(dir(), 'gym.lock')
    const lock = acquireSingleRunLock({ lockPath, releaseOnExit: false })
    writeFileSync(lockPath, '999999998') // someone else took it over
    lock.release()
    expect(readFileSync(lockPath, 'utf8')).toBe('999999998')
  })
})
