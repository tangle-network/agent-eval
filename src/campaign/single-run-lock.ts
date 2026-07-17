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

import {
  type AtomicFileLockUnavailable,
  probeAtomicFileLock,
  tryAcquireAtomicFileLock,
} from './atomic-file-lock'

export interface SingleRunLockOptions {
  /** Lockfile this runner writes (and checks). */
  readonly lockPath: string
  /** Other runners' lockfiles guarding the same resource; checked, never written. */
  readonly alsoCheck?: readonly string[]
  /** Install a process 'exit' hook that releases the lock. Default true. */
  readonly releaseOnExit?: boolean
  /** Owner pid recorded in the lockfile metadata. Default process.pid. */
  readonly pid?: number
}

export interface SingleRunLock {
  /** Remove the lockfile if this process still owns it. Idempotent. */
  release(): void
}

function assertAvailable(path: string): void {
  const unavailable = probeAtomicFileLock({ lockPath: path, acceptLegacyPid: true })
  if (unavailable) throw unavailableError(path, unavailable)
}

function unavailableError(path: string, unavailable: AtomicFileLockUnavailable): Error {
  if (unavailable.reason === 'recovery') {
    return new Error(
      `single-run lock recovery is already in progress (${path}); refusing a concurrent run`,
    )
  }
  return new Error(
    `single-run lock held by live pid ${unavailable.holder.pid} (${path}); refusing a concurrent run on the shared resource`,
  )
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
  const acquisition = tryAcquireAtomicFileLock({
    lockPath: opts.lockPath,
    pid,
    acceptLegacyPid: true,
  })
  if (!acquisition.acquired) throw unavailableError(opts.lockPath, acquisition)
  const release = (): void => {
    try {
      acquisition.lock.release()
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
