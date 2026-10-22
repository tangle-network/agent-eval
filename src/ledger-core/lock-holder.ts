/**
 * The one dead-owner rule: whether a lock's recorded holder is provably dead.
 *
 * A lock is safe to take over only when its holder is proved dead. A pid alone
 * proves nothing: the OS hands a dead holder's pid to a later process, and a
 * filesystem hands a removed lock's inode to the next lock. So a holder record
 * carries the pid's OS start token, the boot id, the pid namespace, the host,
 * and the identity of the lock it was written for, and the verdict is `dead`
 * only when those facts prove it. Anything the record or this host cannot
 * settle is `unknown`, and a caller keeps treating the lock as held.
 *
 * This module imports only Node built-ins, so lock owners in other packages can
 * import `@tangle-network/agent-eval/lock-holder` without loading the rest of
 * the package.
 */

import { readFileSync, readlinkSync } from 'node:fs'
import { hostname } from 'node:os'

/**
 * Identity of one lock path's inode, as decimal strings from a bigint `stat`.
 * ext4 hands a removed directory's inode to the next one at once (two
 * directories created 1.4 ms apart got the same inode on drew-gtr-pro), so dev
 * and ino alone can match a stale record to a live holder's new lock; the
 * nanosecond birthtime tells them apart.
 */
export interface LockIdentity {
  readonly dev: string
  readonly ino: string
  readonly birthtimeNs: string
}

/** Who holds a lock: the process and the facts that tell it from a later holder of its pid. */
export interface LockHolderIdentity {
  readonly pid: number
  readonly host: string
  /** OS start token of `pid`: Linux `/proc/<pid>/stat` starttime, elsewhere `ps` lstart. */
  readonly processStart?: string
  readonly bootId?: string
  readonly pidNamespace?: string
}

/** A holder record as a lock owner writes it: the holder and the lock it was written for. */
export interface LockHolderRecord extends LockHolderIdentity {
  readonly lock?: LockIdentity
}

export type LockHolderDeathReason = 'pid gone' | 'pid reused' | 'host rebooted'

export type LockHolderUnknownReason =
  | 'unreadable record'
  | 'other host'
  | 'incomplete record'
  | 'lock changed'
  | 'other pid namespace'
  | 'boot id unavailable'
  | 'start token unavailable'

export type LockHolderVerdict =
  | { readonly liveness: 'dead'; readonly reason: LockHolderDeathReason }
  | { readonly liveness: 'alive' }
  | { readonly liveness: 'unknown'; readonly reason: LockHolderUnknownReason }

/** Stat fields `lockIdentity` reads; pass `statSync(path, { bigint: true })` or its fstat/lstat. */
export interface LockIdentityStats {
  readonly dev: bigint
  readonly ino: bigint
  readonly birthtimeNs: bigint
}

export function lockIdentity(stats: LockIdentityStats): LockIdentity {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
  }
}

/**
 * The identity to record for `pid` on this host. The start token is read for
 * `pid` itself, so a lock taken on behalf of another live process records that
 * process. Fields the host cannot report are omitted, which leaves a later
 * verdict on the record `unknown` rather than wrong.
 */
export function readLockHolderIdentity(pid: number = process.pid): LockHolderIdentity {
  const processStart = readProcessStart(pid)
  const { bootId, pidNamespace } = ownHostIdentity()
  return {
    pid,
    host: hostname(),
    ...(processStart ? { processStart } : {}),
    ...(bootId ? { bootId } : {}),
    ...(pidNamespace ? { pidNamespace } : {}),
  }
}

/**
 * Decide whether `record`'s holder is dead, alive, or unknown.
 *
 * `currentLock` is the identity of the lock as it is now. `dead` needs a record
 * with a start token and a lock identity, written for this very lock (equal dev,
 * ino and a nonzero birthtime), on this host and pid namespace, and then a
 * rebooted host, a gone pid, or a pid whose start token changed. `alive` needs
 * the pid present with the recorded start token. Everything else is `unknown`,
 * so a live holder's lock is never taken.
 */
export function lockHolderVerdict(
  record: LockHolderRecord | undefined,
  currentLock: LockIdentity | undefined,
): LockHolderVerdict {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    return unknown('unreadable record')
  }
  if (record.host !== hostname()) return unknown('other host')
  if (!record.processStart || !record.lock) return unknown('incomplete record')
  if (
    !currentLock ||
    currentLock.birthtimeNs === '0' ||
    currentLock.dev !== record.lock.dev ||
    currentLock.ino !== record.lock.ino ||
    currentLock.birthtimeNs !== record.lock.birthtimeNs
  ) {
    return unknown('lock changed')
  }
  const own = ownHostIdentity()
  if (record.pidNamespace !== own.pidNamespace) return unknown('other pid namespace')
  if ((record.bootId === undefined) !== (own.bootId === undefined)) {
    return unknown('boot id unavailable')
  }
  if (record.bootId !== own.bootId) return { liveness: 'dead', reason: 'host rebooted' }
  if (pidIsGone(record.pid)) return { liveness: 'dead', reason: 'pid gone' }
  const start = readProcessStart(record.pid)
  if (start === undefined) return unknown('start token unavailable')
  if (start !== record.processStart) return { liveness: 'dead', reason: 'pid reused' }
  return { liveness: 'alive' }
}

/**
 * Read a holder record from parsed JSON. The required fields are `pid` and
 * `host`; an identity field that is missing or malformed is dropped, which
 * leaves the holder named but never provably dead.
 */
export function parseLockHolderRecord(value: unknown): LockHolderRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) return undefined
  if (typeof record.host !== 'string' || record.host.length === 0) return undefined
  const processStart = text(record.processStart)
  const bootId = text(record.bootId)
  const pidNamespace = text(record.pidNamespace)
  const lock = parseLockIdentity(record.lock)
  return {
    pid: record.pid as number,
    host: record.host,
    ...(processStart ? { processStart } : {}),
    ...(bootId ? { bootId } : {}),
    ...(pidNamespace ? { pidNamespace } : {}),
    ...(lock ? { lock } : {}),
  }
}

function parseLockIdentity(value: unknown): LockIdentity | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const lock = value as Record<string, unknown>
  if (!decimal(lock.dev) || !decimal(lock.ino) || !decimal(lock.birthtimeNs)) return undefined
  return { dev: lock.dev, ino: lock.ino, birthtimeNs: lock.birthtimeNs }
}

function unknown(reason: LockHolderUnknownReason): LockHolderVerdict {
  return { liveness: 'unknown', reason }
}

function text(field: unknown): string | undefined {
  return typeof field === 'string' && field.length > 0 ? field : undefined
}

function decimal(field: unknown): field is string {
  return typeof field === 'string' && /^\d+$/u.test(field)
}

/** Only ESRCH proves a pid gone; EPERM means it exists under another user. */
function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

interface HostIdentity {
  readonly bootId?: string
  readonly pidNamespace?: string
}

let hostIdentity: HostIdentity | undefined

function ownHostIdentity(): HostIdentity {
  if (hostIdentity) return hostIdentity
  const bootId = readOptional(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
  const pidNamespace = readOptional(() => readlinkSync('/proc/self/ns/pid'))
  hostIdentity = {
    ...(bootId ? { bootId } : {}),
    ...(pidNamespace ? { pidNamespace } : {}),
  }
  return hostIdentity
}

/**
 * The OS start token of a live pid: the same for a process's whole life and
 * different for every later holder of its pid. `undefined` when the host cannot
 * report one.
 */
function readProcessStart(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === 'win32') return undefined
  if (process.platform === 'linux') {
    const stat = readOptional(() => readFileSync(`/proc/${pid}/stat`, 'utf8'))
    if (stat === undefined) return undefined
    // The comm field is parenthesized and may hold spaces, so fields are counted after its close.
    const startTime = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/u)[19]
    return startTime !== undefined && /^\d+$/u.test(startTime) ? startTime : undefined
  }
  // `ps` lstart has 1 s resolution, so a pid reused within the same second reads
  // as alive and keeps the lock: the safe direction. child_process is resolved
  // on use so bundles that import this module never load it at startup.
  const childProcess = process.getBuiltinModule?.('node:child_process') as
    | typeof import('node:child_process')
    | undefined
  if (!childProcess) return undefined
  return readOptional(() =>
    childProcess
      .execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim(),
  )
}

function readOptional(read: () => string): string | undefined {
  try {
    return read() || undefined
  } catch {
    return undefined
  }
}
