/** Crash-safe filesystem lock shared by campaign persistence and run exclusion. */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'

export interface AtomicFileLockOwner {
  readonly pid: number
  readonly host: string
  readonly nonce: string
}

export interface AtomicFileLock {
  readonly owner: AtomicFileLockOwner
  release(): void
}

export type AtomicFileLockUnavailable =
  | { readonly acquired: false; readonly reason: 'held'; readonly holder: AtomicFileLockOwner }
  | { readonly acquired: false; readonly reason: 'recovery' }

export type AtomicFileLockAcquisition =
  | { readonly acquired: true; readonly lock: AtomicFileLock }
  | AtomicFileLockUnavailable

export interface AtomicFileLockOptions {
  readonly lockPath: string
  readonly pid?: number
  readonly acceptLegacyPid?: boolean
}

export class AtomicFileLockError extends Error {
  override readonly name = 'AtomicFileLockError'
}

type OwnerState =
  | { readonly state: 'missing' }
  | { readonly state: 'stale'; readonly owner: AtomicFileLockOwner }
  | { readonly state: 'held'; readonly owner: AtomicFileLockOwner }

/** Report whether another lock path prevents acquisition without modifying it. */
export function probeAtomicFileLock(
  options: AtomicFileLockOptions,
): AtomicFileLockUnavailable | null {
  if (existsSync(recoveryPath(options.lockPath))) return { acquired: false, reason: 'recovery' }
  const state = ownerState(options.lockPath, options.acceptLegacyPid ?? false)
  if (state.state === 'held') {
    return { acquired: false, reason: 'held', holder: state.owner }
  }
  return null
}

/**
 * Try to acquire a complete, uniquely-owned lock inode.
 *
 * A hard link publishes fully-written owner metadata atomically. Stale-owner
 * removal is serialized so one reclaimer cannot delete a new owner's lock.
 */
export function tryAcquireAtomicFileLock(
  options: AtomicFileLockOptions,
): AtomicFileLockAcquisition {
  const pid = options.pid ?? process.pid
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new AtomicFileLockError('atomic file lock pid must be a positive integer')
  }
  const owner: AtomicFileLockOwner = { pid, host: hostname(), nonce: randomUUID() }
  const acceptLegacyPid = options.acceptLegacyPid ?? false

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (existsSync(recoveryPath(options.lockPath))) {
      return { acquired: false, reason: 'recovery' }
    }
    if (tryLinkOwner(options.lockPath, owner, `acquire.${attempt}`)) {
      return acquired(options.lockPath, owner)
    }

    const holder = ownerState(options.lockPath, acceptLegacyPid)
    if (holder.state === 'missing') continue
    if (holder.state === 'held') {
      return { acquired: false, reason: 'held', holder: holder.owner }
    }

    const reclaimPath = recoveryPath(options.lockPath)
    if (!tryLinkOwner(reclaimPath, owner, `reclaim.${attempt}`)) {
      return { acquired: false, reason: 'recovery' }
    }
    try {
      const current = ownerState(options.lockPath, acceptLegacyPid)
      if (current.state === 'held') {
        return { acquired: false, reason: 'held', holder: current.owner }
      }
      if (current.state === 'stale') {
        const tombstone = `${options.lockPath}.stale.${owner.nonce}.${attempt}`
        try {
          renameSync(options.lockPath, tombstone)
          unlinkSync(tombstone)
        } catch (error) {
          if (!isMissing(error)) throw error
        }
      }
      if (tryLinkOwner(options.lockPath, owner, `recovered.${attempt}`)) {
        return acquired(options.lockPath, owner)
      }
    } finally {
      releaseOwnedPath(reclaimPath, owner)
    }
  }

  throw new AtomicFileLockError(`could not acquire atomic file lock ${options.lockPath}`)
}

function acquired(lockPath: string, owner: AtomicFileLockOwner): AtomicFileLockAcquisition {
  return {
    acquired: true,
    lock: {
      owner,
      release: () => releaseOwnedPath(lockPath, owner),
    },
  }
}

function tryLinkOwner(lockPath: string, owner: AtomicFileLockOwner, suffix: string): boolean {
  const ownerPath = `${lockPath}.${owner.pid}.${owner.nonce}.${suffix}.owner`
  const descriptor = openSync(
    ownerPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  )
  try {
    writeFileSync(descriptor, `${canonicalOwner(owner)}\n`, 'utf8')
    fsyncSync(descriptor)
  } catch (error) {
    closeSync(descriptor)
    unlinkIfExists(ownerPath)
    throw error
  }
  closeSync(descriptor)

  try {
    linkSync(ownerPath, lockPath)
    return true
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    return false
  } finally {
    unlinkIfExists(ownerPath)
  }
}

function ownerState(lockPath: string, acceptLegacyPid: boolean): OwnerState {
  const owner = readOwner(lockPath, acceptLegacyPid)
  if (!owner) return { state: 'missing' }
  if (owner.host !== hostname()) return { state: 'held', owner }
  try {
    process.kill(owner.pid, 0)
    return { state: 'held', owner }
  } catch (error) {
    if (isNoSuchProcess(error)) return { state: 'stale', owner }
    return { state: 'held', owner }
  }
}

function readOwner(lockPath: string, acceptLegacyPid: boolean): AtomicFileLockOwner | undefined {
  let contents: string
  try {
    contents = readFileSync(lockPath, 'utf8').trim()
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }

  if (acceptLegacyPid && /^[1-9]\d*$/.test(contents)) {
    const pid = Number(contents)
    if (Number.isSafeInteger(pid)) return { pid, host: hostname(), nonce: 'legacy-pid' }
  }

  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch (error) {
    throw invalidOwner(lockPath, error)
  }
  if (!isOwner(value)) throw invalidOwner(lockPath)
  return value
}

function isOwner(value: unknown): value is AtomicFileLockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 3 &&
    Number.isSafeInteger(record.pid) &&
    Number(record.pid) > 0 &&
    typeof record.host === 'string' &&
    record.host.trim().length > 0 &&
    typeof record.nonce === 'string' &&
    record.nonce.trim().length > 0
  )
}

function invalidOwner(lockPath: string, cause?: unknown): AtomicFileLockError {
  const error = new AtomicFileLockError(
    `atomic file lock has an invalid owner (${lockPath}); refusing unsafe recovery`,
  )
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause })
  return error
}

function releaseOwnedPath(lockPath: string, owner: AtomicFileLockOwner): void {
  const current = readOwner(lockPath, true)
  if (!current) return
  if (canonicalOwner(current) !== canonicalOwner(owner)) {
    throw new AtomicFileLockError(`atomic file lock owner changed before release (${lockPath})`)
  }
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function canonicalOwner(owner: AtomicFileLockOwner): string {
  return JSON.stringify({ host: owner.host, nonce: owner.nonce, pid: owner.pid })
}

function recoveryPath(lockPath: string): string {
  return `${lockPath}.reclaim`
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}
