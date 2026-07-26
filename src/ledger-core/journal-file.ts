/** Filesystem durability and cross-process exclusion for append-only journal files. */

import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { AtomicFileLockError, tryAcquireAtomicFileLock } from './atomic-file-lock'

/** How a journal binding reports file-layer faults in its own error taxonomy. */
export interface LedgerFileContext {
  /** Noun used in error messages, e.g. 'search ledger'. */
  subject: string
  integrityError(message: string, options?: { cause?: unknown }): Error
}

/** Append one already-serialized line; the write is fsynced (file and directory)
 * before returning so an acknowledged append survives a crash. */
export function appendLedgerLine(path: string, line: string, context: LedgerFileContext): void {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600)
  try {
    writeAll(fd, Buffer.from(line, 'utf8'), context)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  fsyncDirectory(dirname(path))
}

export function withLedgerFileLock<T>(path: string, context: LedgerFileContext, run: () => T): T {
  const result = tryWithLedgerFileLock(path, context, run)
  if (!result.acquired) {
    throw context.integrityError(`${context.subject} lock is held (${path})`)
  }
  return result.value
}

export type FileLockResult<T> = { acquired: true; value: T } | { acquired: false }

export function tryWithLedgerFileLock<T>(
  path: string,
  context: LedgerFileContext,
  run: () => T,
): FileLockResult<T> {
  mkdirSync(dirname(path), { recursive: true })
  const lockPath = `${path}.lock`
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
      throw context.integrityError(error.message, { cause: error })
    }
    throw error
  }
}

function writeAll(fd: number, bytes: Buffer, context: LedgerFileContext): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
    if (written <= 0) throw context.integrityError('filesystem wrote zero bytes')
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
