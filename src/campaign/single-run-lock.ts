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

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'

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
  if (!existsSync(path)) return null
  const holder = Number(readFileSync(path, 'utf8').trim())
  if (!Number.isFinite(holder) || holder <= 0) return null
  try {
    process.kill(holder, 0)
    return holder
  } catch {
    return null // stale: holder pid is gone; safe to reclaim
  }
}

/**
 * Acquire the lock or throw naming the live holder. A stale lock (holder pid
 * no longer running) is reclaimed silently.
 */
export function acquireSingleRunLock(opts: SingleRunLockOptions): SingleRunLock {
  const pid = opts.pid ?? process.pid
  for (const path of [opts.lockPath, ...(opts.alsoCheck ?? [])]) {
    const holder = liveHolder(path)
    if (holder !== null && holder !== pid) {
      throw new Error(
        `single-run lock held by live pid ${holder} (${path}); refusing a concurrent run on the shared resource`,
      )
    }
  }
  writeFileSync(opts.lockPath, String(pid))
  const release = (): void => {
    try {
      if (existsSync(opts.lockPath) && readFileSync(opts.lockPath, 'utf8').trim() === String(pid)) {
        unlinkSync(opts.lockPath)
      }
    } catch {
      // release is best-effort; a leftover stale lock is reclaimed on next acquire
    }
  }
  if (opts.releaseOnExit ?? true) process.on('exit', release)
  return { release }
}
