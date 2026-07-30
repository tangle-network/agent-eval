/** Filesystem durability and cross-process exclusion for append-only journal files. */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
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
  recoverTornFinalWrite(path, context)
  const fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND, 0o600)
  try {
    writeAll(fd, Buffer.from(line, 'utf8'), context)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  fsyncDirectory(dirname(path))
}

function recoverTornFinalWrite(path: string, context: LedgerFileContext): void {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDWR)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw context.integrityError(`${context.subject} ${path} could not be opened for recovery`, {
      cause: error,
    })
  }

  try {
    const size = fstatSync(fd).size
    if (size === 0 || readByte(fd, size - 1) === 0x0a) return
    const tailStart = findFinalLineStart(fd, size)
    const replacement = Buffer.alloc(size - tailStart, 0x20)
    replacement[replacement.length - 1] = 0x0a
    writeAllAt(fd, replacement, tailStart, context)
    fsyncSync(fd)
  } catch (error) {
    throw context.integrityError(
      `${context.subject} ${path} has an unrecoverable final journal write`,
      { cause: error },
    )
  } finally {
    closeSync(fd)
  }
}

/** Replace a small sidecar file whole: write a temporary sibling, fsync it,
 * then rename over the target. A reader therefore sees the previous contents
 * or the new ones, never a partial file. */
export function writeLedgerFileAtomically(
  path: string,
  contents: string,
  context: LedgerFileContext,
): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = `${path}.tmp`
  const fd = openSync(
    temporaryPath,
    constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC,
    0o600,
  )
  try {
    writeAll(fd, Buffer.from(contents, 'utf8'), context)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporaryPath, path)
  fsyncDirectory(directory)
}

/** Remove whatever occupies a sidecar path and fsync its directory, so the
 * removal is as durable as the write that created it. False when the path was
 * already empty. Recursive because a sidecar path holding a directory is one of
 * the states this has to be able to clear, not one it can refuse. */
export function removeLedgerFile(path: string, context: LedgerFileContext): boolean {
  try {
    rmSync(path, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw context.integrityError(`${context.subject} ${path} could not be removed`, {
      cause: error,
    })
  }
  fsyncDirectory(dirname(path))
  return true
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

function writeAllAt(fd: number, bytes: Buffer, position: number, context: LedgerFileContext): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset, position + offset)
    if (written <= 0) throw context.integrityError('filesystem wrote zero bytes')
    offset += written
  }
}

function findFinalLineStart(fd: number, size: number): number {
  const chunk = Buffer.alloc(Math.min(4_096, size))
  let cursor = size
  while (cursor > 0) {
    const length = Math.min(chunk.byteLength, cursor)
    cursor -= length
    const read = readSync(fd, chunk, 0, length, cursor)
    for (let index = read - 1; index >= 0; index -= 1) {
      if (chunk[index] === 0x0a) return cursor + index + 1
    }
  }
  return 0
}

function readByte(fd: number, position: number): number {
  const byte = Buffer.allocUnsafe(1)
  const read = readSync(fd, byte, 0, 1, position)
  return read === 1 ? byte[0]! : -1
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
