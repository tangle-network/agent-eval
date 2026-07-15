/** Filesystem durability and cross-process exclusion for the search ledger. */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { z } from 'zod'
import { SearchLedgerIntegrityError } from './search-ledger-errors'

export function appendSearchLedgerLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600)
  try {
    writeAll(fd, Buffer.from(line, 'utf8'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  fsyncDirectory(dirname(path))
}

export function withSearchLedgerFileLock<T>(ledgerPath: string, run: () => T): T {
  const result = tryWithSearchLedgerFileLock(ledgerPath, run)
  if (!result.acquired) {
    throw new SearchLedgerIntegrityError(`search ledger lock is held (${ledgerPath})`)
  }
  return result.value
}

export type FileLockResult<T> = { acquired: true; value: T } | { acquired: false }

export function tryWithSearchLedgerFileLock<T>(
  ledgerPath: string,
  run: () => T,
): FileLockResult<T> {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  const lockPath = `${ledgerPath}.lock`
  const owner = acquireLock(lockPath)
  if (!owner) return { acquired: false }
  try {
    return { acquired: true, value: run() }
  } finally {
    releaseLock(lockPath, owner)
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
    if (written <= 0) throw new SearchLedgerIntegrityError('filesystem wrote zero bytes')
    offset += written
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

interface LockOwner {
  pid: number
  host: string
  nonce: string
}

/** Create a complete owner inode first, then hard-link it into the fixed lock
 * path. `link` is the atomic compare-and-set; a crash can never leave an empty
 * or partially-written lock owner. */
function acquireLock(lockPath: string): LockOwner | undefined {
  const owner: LockOwner = { pid: process.pid, host: hostname(), nonce: randomUUID() }
  const ownerBytes = `${canonicalOwner(owner)}\n`
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const ownerPath = `${lockPath}.${owner.pid}.${owner.nonce}.${attempt}.owner`
    const fd = openSync(ownerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try {
      writeAll(fd, Buffer.from(ownerBytes, 'utf8'))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    try {
      linkSync(ownerPath, lockPath)
      unlinkSync(ownerPath)
      return owner
    } catch (error) {
      unlinkIfExists(ownerPath)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const holder = readOwner(lockPath)
    if (holder.host !== owner.host || isProcessAlive(holder.pid)) {
      return undefined
    }

    const tombstone = `${lockPath}.stale.${owner.nonce}.${attempt}`
    try {
      renameSync(lockPath, tombstone)
      unlinkSync(tombstone)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new SearchLedgerIntegrityError(`could not acquire search ledger lock ${lockPath}`)
}

function releaseLock(lockPath: string, owner: LockOwner): void {
  if (!existsSync(lockPath)) return
  const holder = readOwner(lockPath)
  if (canonicalOwner(holder) !== canonicalOwner(owner)) {
    throw new SearchLedgerIntegrityError(
      `search ledger lock owner changed before release (${lockPath})`,
    )
  }
  unlinkSync(lockPath)
}

function readOwner(lockPath: string): LockOwner {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (error) {
    throw new SearchLedgerIntegrityError(`search ledger lock ${lockPath} is malformed`, {
      cause: error,
    })
  }
  const parsed = z
    .object({
      pid: z.number().int().positive().safe(),
      host: z.string().trim().min(1),
      nonce: z.string().trim().min(1),
    })
    .strict()
    .safeParse(raw)
  if (!parsed.success) {
    throw new SearchLedgerIntegrityError(
      `search ledger lock ${lockPath} is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  return parsed.data
}

function canonicalOwner(owner: LockOwner): string {
  return JSON.stringify({ host: owner.host, nonce: owner.nonce, pid: owner.pid })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
