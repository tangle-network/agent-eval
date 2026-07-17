/**
 * Single-run lock for evaluations that share one mutable environment.
 *
 * Two concurrent runs against a shared stateful gym silently corrupt each
 * other: each resets/mutates environment state mid-cell of the other, and
 * every score from both becomes garbage that LOOKS like worker variance
 * (agent-lab R357 burned hours on flip-flopping scores before tracing them
 * to exactly this). The fix is a pid lockfile: refuse to start while a live
 * holder exists, reclaim stale locks whose pid is gone, release only if the
 * lock is still ours.
 *
 * `alsoCheck` exists because independent runners can guard the same shared
 * resource with differently named lockfiles; a runner must respect all of
 * them even though it writes only its own.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export interface SingleRunLockOptions {
  /** Lockfile this runner writes (and checks). */
  readonly lockPath: string
  /** Other runners' lockfiles guarding the same resource; checked, never written. */
  readonly alsoCheck?: readonly string[]
  /** Install a process 'exit' hook that releases the lock. Default true. */
  readonly releaseOnExit?: boolean
  /** Owner pid recorded in the lockfile. Default process.pid. */
  readonly pid?: number
}

export interface SingleRunLock {
  /** Remove the lockfile if this process still owns it. Idempotent. */
  release(): void
}

function liveHolder(path: string): number | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8').trim()
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  const holder = Number(raw)
  if (!Number.isSafeInteger(holder) || holder <= 0) {
    throw new Error(`single-run lock has an invalid owner (${path}); refusing unsafe recovery`)
  }
  try {
    process.kill(holder, 0)
    return holder
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return null
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return holder
    throw error
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function createLock(path: string, pid: number): boolean {
  let descriptor: number
  try {
    descriptor = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (isAlreadyExists(error)) return false
    throw error
  }
  try {
    writeFileSync(descriptor, String(pid), 'utf8')
  } catch (error) {
    closeSync(descriptor)
    try {
      unlinkSync(path)
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) throw cleanupError
    }
    throw error
  }
  closeSync(descriptor)
  return true
}

function releaseOwnedPath(path: string, pid: number): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function recoveryPath(path: string): string {
  return `${path}.reclaim`
}

function assertNoRecovery(path: string): void {
  if (existsSync(recoveryPath(path))) {
    throw new Error(
      `single-run lock recovery is already in progress (${path}); refusing a concurrent run`,
    )
  }
}

function acquireOwnedPath(path: string, pid: number): void {
  while (true) {
    assertNoRecovery(path)
    if (createLock(path, pid)) return
    const holder = liveHolder(path)
    if (holder !== null) {
      throw new Error(
        `single-run lock held by live pid ${holder} (${path}); refusing a concurrent run on the shared resource`,
      )
    }

    const reclaim = recoveryPath(path)
    if (!createLock(reclaim, pid)) {
      throw new Error(
        `single-run lock recovery is already in progress (${path}); refusing a concurrent run`,
      )
    }
    try {
      const current = liveHolder(path)
      if (current !== null) continue
      try {
        unlinkSync(path)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      if (createLock(path, pid)) return
    } finally {
      releaseOwnedPath(reclaim, pid)
    }
  }
}

function assertAvailable(path: string): void {
  assertNoRecovery(path)
  const holder = liveHolder(path)
  if (holder !== null) {
    throw new Error(
      `single-run lock held by live pid ${holder} (${path}); refusing a concurrent run on the shared resource`,
    )
  }
}

/**
 * Acquire the lock or throw naming the live holder. A stale lock (holder pid
 * no longer running) is reclaimed by one contender. An interrupted reclaim
 * leaves a marker that fails closed instead of admitting overlapping runs.
 */
export function acquireSingleRunLock(opts: SingleRunLockOptions): SingleRunLock {
  const pid = opts.pid ?? process.pid
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('single-run lock pid must be a positive integer')
  for (const path of opts.alsoCheck ?? []) assertAvailable(path)
  acquireOwnedPath(opts.lockPath, pid)
  const release = (): void => {
    try {
      releaseOwnedPath(opts.lockPath, pid)
    } catch {
      // release is best-effort; a leftover stale lock is reclaimed on next acquire
    }
  }
  try {
    for (const path of opts.alsoCheck ?? []) assertAvailable(path)
  } catch (error) {
    release()
    throw error
  }
  if (opts.releaseOnExit ?? true) process.on('exit', release)
  return { release }
}
