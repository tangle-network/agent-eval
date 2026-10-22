import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type LockHolderRecord,
  lockHolderVerdict,
  lockIdentity,
  readLockHolderIdentity,
} from './lock-holder'

const children: ChildProcess[] = []
const directories: string[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function spawnHolder(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (child.pid === undefined) throw new Error('holder child has no pid')
  return child as ChildProcess & { pid: number }
}

async function sigkill(child: ChildProcess): Promise<void> {
  // Node reaps the child before 'exit', so its pid is gone, not a zombie, after this resolves.
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}

function lockDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-lock-holder-'))
  directories.push(root)
  const lock = join(root, 'held.lock')
  mkdirSync(lock)
  return lock
}

function currentIdentity(path: string) {
  return lockIdentity(statSync(path, { bigint: true }))
}

function recordFor(pid: number, lock: string): LockHolderRecord {
  return { ...readLockHolderIdentity(pid), lock: currentIdentity(lock) }
}

describe('lockHolderVerdict with real holder processes', () => {
  it('answers alive for a live holder', async () => {
    const child = await spawnHolder()
    const lock = lockDirectory()
    const record = recordFor(child.pid, lock)
    expect(record.processStart).toEqual(expect.any(String))
    expect(lockHolderVerdict(record, currentIdentity(lock))).toEqual({ liveness: 'alive' })
  })

  it('answers dead for a SIGKILLed holder', async () => {
    const child = await spawnHolder()
    const lock = lockDirectory()
    const record = recordFor(child.pid, lock)
    await sigkill(child)
    expect(lockHolderVerdict(record, currentIdentity(lock))).toEqual({
      liveness: 'dead',
      reason: 'pid gone',
    })
  })

  it('answers dead when a new process holds the recorded pid', async () => {
    const child = await spawnHolder()
    const lock = lockDirectory()
    const record = recordFor(child.pid, lock)
    // Same pid, a start token from an earlier process: what a reused pid looks like.
    const reused = { ...record, processStart: `earlier-${record.processStart}` }
    expect(lockHolderVerdict(reused, currentIdentity(lock))).toEqual({
      liveness: 'dead',
      reason: 'pid reused',
    })
  })

  it('answers unknown for a record from another host', async () => {
    const child = await spawnHolder()
    const lock = lockDirectory()
    const record = { ...recordFor(child.pid, lock), host: 'remote-worker.example' }
    await sigkill(child)
    expect(lockHolderVerdict(record, currentIdentity(lock))).toEqual({
      liveness: 'unknown',
      reason: 'other host',
    })
  })

  it('answers unknown when the lock was replaced, even at the same inode', async () => {
    const child = await spawnHolder()
    const lock = lockDirectory()
    const record = recordFor(child.pid, lock)
    await sigkill(child)
    rmdirSync(lock)
    mkdirSync(lock)
    expect(lockHolderVerdict(record, currentIdentity(lock))).toEqual({
      liveness: 'unknown',
      reason: 'lock changed',
    })
  })

  it('answers unknown for an unreadable or incomplete record', async () => {
    const child = await spawnHolder()
    const lock = lockDirectory()
    const { lock: _lock, ...withoutLock } = recordFor(child.pid, lock)
    await sigkill(child)
    expect(lockHolderVerdict(undefined, currentIdentity(lock))).toEqual({
      liveness: 'unknown',
      reason: 'unreadable record',
    })
    expect(lockHolderVerdict(withoutLock, currentIdentity(lock))).toEqual({
      liveness: 'unknown',
      reason: 'incomplete record',
    })
  })
})
