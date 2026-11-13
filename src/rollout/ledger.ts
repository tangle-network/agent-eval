/**
 * Rollout-ledger file API — append-only JSONL of validated `tangle.rollout.v1`
 * lines. Writes validate BEFORE touching disk (a bad line never lands);
 * reads validate line-by-line and fail loud with the line number, because a
 * silently-skipped rollout is a corrupted dataset.
 *
 * "Validate" includes the anti-Goodhart invariant (a realness-gated line may
 * not carry a positive reward), so a poisoned line can neither enter a ledger
 * nor leave one.
 *
 * Two read modes, matching the two write-side row classes: `readRolloutLedger`
 * re-validates under the mint policy (training data), `readRolloutJournal`
 * under the write policy (supervision journals, whose unscreened positive
 * rewards are writable and must stay readable).
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  canonicalString,
  hashCanonical,
  jsonDocument,
  LEDGER_HASH_PATTERN,
  type LedgerHash,
} from '../ledger-core/canonical'
import { withLedgerFileLock, writeLedgerFileAtomically } from '../ledger-core/journal-file'
import { assertMinted, assertRolloutLine, type MintedRolloutLine, type RolloutLine } from './schema'

function serialize(lines: RolloutLine[]): string {
  for (const [i, line] of lines.entries()) assertRolloutLine(line, `rollout line [${i}]`)
  return lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length > 0 ? '\n' : '')
}

/** Replace the ledger file with exactly `lines`. */
export async function writeRolloutLedger(path: string, lines: RolloutLine[]): Promise<void> {
  const payload = serialize(lines)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, payload)
}

/** Append `lines` to the ledger file (created if absent). */
export async function appendRolloutLines(path: string, lines: RolloutLine[]): Promise<void> {
  if (lines.length === 0) return
  const payload = serialize(lines)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, payload)
}

/**
 * Read and validate every line. Throws on the first malformed/invalid line
 * (with its 1-based line number) — fail-closed, never a silent drop.
 *
 * Validation includes the anti-Goodhart invariant, which is why the result is
 * `MintedRolloutLine[]`: a ledger file is the main way a rollout reaches this
 * process from outside the type system (another run, another machine, a
 * hand-edited JSONL), so this read is the runtime boundary where a poisoned
 * line is refused rather than exported.
 */
export async function readRolloutLedger(path: string): Promise<MintedRolloutLine[]> {
  return readLines(path, (parsed, context) => assertMinted(parsed, context))
}

/**
 * Read under the write policy: imported and supervision rows whose positive
 * rewards no realness screen has seen stay readable, as they were writable.
 * Not training input until a screen mints them.
 */
export async function readRolloutJournal(path: string): Promise<RolloutLine[]> {
  return readLines(path, (parsed, context) => {
    assertRolloutLine(parsed, context)
    return parsed
  })
}

async function readLines<T>(
  path: string,
  admit: (parsed: unknown, context: string) => T,
): Promise<T[]> {
  const raw = await readFile(path, 'utf8')
  const lines: T[] = []
  const rawLines = raw.split('\n')
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i]
    if (!text?.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(
        `${path}:${i + 1}: malformed JSON — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    lines.push(admit(parsed, `${path}:${i + 1}`))
  }
  return lines
}

/** A caller's immutable source and projection identity; a batch key is never overwritten. */
export interface RolloutBatchIdentity {
  key: string
  sourceDigest: LedgerHash
  /** Pin the reader/projection version, such as a package version or source commit. */
  projection: string
}

export interface RolloutBatchReceipt extends RolloutBatchIdentity {
  digest: LedgerHash
  rowCount: number
  path: string
}

/**
 * Retain one canonical journal batch exactly once. A receipt commits the fsynced
 * rows; an interrupted write can be finished with the same content. This uses
 * journal validation, so missing labels, explicit gaps and unscreened outcomes
 * remain evidence without being approved for training.
 */
export function admitRolloutBatch(
  directory: string,
  identity: RolloutBatchIdentity,
  lines: RolloutLine[],
): { disposition: 'admitted' | 'existing'; receipt: RolloutBatchReceipt } {
  if (
    !identity.key.trim() ||
    !identity.projection.trim() ||
    !LEDGER_HASH_PATTERN.test(identity.sourceDigest)
  )
    throw new Error('rollout batch requires a key, projection version and canonical source digest')
  for (const [index, line] of lines.entries()) assertRolloutLine(line, `rollout batch [${index}]`)
  const document = jsonDocument(lines)
  const digest = hashCanonical(document)
  const batch = join(directory, hashCanonical(identity.key).slice('sha256:'.length))
  const path = join(batch, 'rows.jsonl')
  const receiptPath = join(batch, 'receipt.json')
  const stored = { ...identity, digest, rowCount: lines.length }
  const receipt: RolloutBatchReceipt = { ...stored, path }
  const payload =
    lines.map((line) => canonicalString(jsonDocument(line))).join('\n') + (lines.length ? '\n' : '')
  const context = {
    subject: 'rollout batch',
    integrityError: (message: string, options?: { cause?: unknown }) => new Error(message, options),
  }
  const read = (file: string): string | null => {
    try {
      return readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  return withLedgerFileLock(receiptPath, context, () => {
    const existing = read(receiptPath)
    const rows = read(path)
    if (existing !== null) {
      if (hashCanonical(JSON.parse(existing)) !== hashCanonical(stored))
        throw new Error(
          `rollout batch key ${identity.key} already names different source or projection content`,
        )
      if (rows !== payload)
        throw new Error(`rollout batch ${identity.key} retained rows failed integrity verification`)
      return { disposition: 'existing', receipt }
    }
    if (rows !== null && rows !== payload)
      throw new Error(
        `rollout batch ${identity.key} has different uncommitted rows; refusing to overwrite evidence`,
      )
    writeLedgerFileAtomically(path, payload, context)
    writeLedgerFileAtomically(receiptPath, `${canonicalString(stored)}\n`, context)
    return { disposition: 'admitted', receipt }
  })
}
