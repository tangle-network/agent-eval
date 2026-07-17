/** Filesystem durability and cross-process exclusion for the search ledger. */

import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { AtomicFileLockError, tryAcquireAtomicFileLock } from './atomic-file-lock'
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
  try {
    const acquisition = tryAcquireAtomicFileLock({ lockPath })
    if (!acquisition.acquired) return { acquired: false }
    try {
      return { acquired: true, value: run() }
    } finally {
      acquisition.lock.release()
    }
  } catch (error) {
    if (error instanceof AtomicFileLockError) {
      throw new SearchLedgerIntegrityError(error.message, { cause: error })
    }
    throw error
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
