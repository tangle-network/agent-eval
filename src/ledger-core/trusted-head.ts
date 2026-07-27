/**
 * Trusted head — the pin that makes deletion detectable.
 *
 * ## What the chain binds
 *
 * Every entry hashes the journal header, its sequence, the previous entry's
 * hash, and its event, so editing, reordering, or removing an entry in the
 * middle of a journal invalidates every hash after it. What a hash chain
 * cannot bind is its own length. Dropping entries off the END leaves a shorter
 * journal that is internally perfect, and rebuilding a journal from sequence 0
 * with recomputed hashes produces a different, equally perfect chain. For an
 * audit log of candidate registrations and promotion decisions that is the
 * difference between a record of a search that happened and a record of one
 * that did not.
 *
 * ## What the pin binds
 *
 * `<journal>.head` holds `{sequence, entryHash}` for one entry a writer
 * actually appended, in a file separate from the journal it attests. Each
 * entry hash commits to the entire prefix before it, so checking that the
 * entry at exactly `sequence` still carries `entryHash` proves two things at
 * once: the journal is at least `sequence + 1` entries long, and those entries
 * are byte-for-byte the ones the writer saw. A journal that merely grew past
 * the pin still verifies; a truncated, rolled-back, or wholesale-rewritten one
 * cannot.
 *
 * ## What the pin does NOT defend against
 *
 * The pin is a second file, not a signature. A writer with access to BOTH the
 * journal and its pin can rewrite both consistently, and the result verifies.
 * Pinning raises the cost of undetected tampering from one file to two and
 * nothing more; defending against a writer who holds both requires an anchor
 * outside this store entirely — a signed head, or a digest published to an
 * append-only service the tamperer does not control.
 *
 * Deleting the pin file downgrades a pinned journal to an unpinned one, which
 * cannot be distinguished from a journal written before pinning existed. That
 * is what `requireTrustedHead` is for: a journal opened under it refuses to
 * read at all once a non-empty journal has no pin.
 */

import { existsSync, readFileSync } from 'node:fs'
import { canonicalString, LEDGER_HASH_PATTERN, type LedgerHash } from './canonical'
import { type LedgerFileContext, writeLedgerFileAtomically } from './journal-file'

/** A `(sequence, entryHash)` pair a writer pinned outside the journal. */
export interface LedgerTrustedHead {
  sequence: number
  entryHash: LedgerHash
}

/** Minimum entry shape the anchor check needs. */
export interface LedgerAnchoredEntry {
  sequence: number
  entryHash: LedgerHash
}

/** Sibling pin file for a journal — deliberately NOT the journal, so rewriting
 * the log is not enough to rewrite the trust recorded about it. */
export function trustedHeadPathFor(journalPath: string): string {
  return `${journalPath}.head`
}

/** The pin, or null when this journal has never been pinned. A pin that exists
 * but does not parse is corruption or tamper of the trust record itself and
 * fails loudly: reporting it as "no pin" would silently downgrade what the
 * journal can prove. */
export function readTrustedHeadFile(
  path: string,
  context: LedgerFileContext,
): LedgerTrustedHead | null {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw context.integrityError(`${context.subject} trusted head ${path} is not valid JSON`, {
      cause: error,
    })
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw context.integrityError(`${context.subject} trusted head ${path} is not an object`)
  }
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'entryHash' || keys[1] !== 'sequence') {
    throw context.integrityError(
      `${context.subject} trusted head ${path} has keys [${keys.join(', ')}], expected [entryHash, sequence]`,
    )
  }
  const { sequence, entryHash } = record
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw context.integrityError(
      `${context.subject} trusted head ${path} sequence is not a non-negative integer`,
    )
  }
  if (typeof entryHash !== 'string' || !LEDGER_HASH_PATTERN.test(entryHash)) {
    throw context.integrityError(
      `${context.subject} trusted head ${path} entryHash is not a sha256 digest`,
    )
  }
  return { sequence, entryHash: entryHash as LedgerHash }
}

/** Publish a pin by write-then-rename, so a crash leaves either the previous
 * pin or the new one and never a torn file that would lock a journal out of
 * its own trust record. */
export function writeTrustedHeadFile(
  path: string,
  head: LedgerTrustedHead,
  context: LedgerFileContext,
): void {
  writeLedgerFileAtomically(path, `${canonicalString(head)}\n`, context)
}

/** The entry at exactly `head.sequence` must still carry `head.entryHash`.
 * Entries must already have passed chain verification, which is what makes
 * index and sequence interchangeable here. */
export function verifyEntriesAgainstTrustedHead(
  entries: readonly LedgerAnchoredEntry[],
  head: LedgerTrustedHead,
  context: LedgerFileContext,
  subject: string,
): void {
  const pinned = entries[head.sequence]
  if (pinned === undefined) {
    throw context.integrityError(
      `${subject} trusted head pins sequence ${head.sequence} (${head.entryHash}) but the journal has ${entries.length} entries — pinned history is missing (truncation, rollback, or rewrite)`,
    )
  }
  if (pinned.sequence !== head.sequence) {
    throw context.integrityError(
      `${subject} entry at index ${head.sequence} carries sequence ${pinned.sequence}; the chain was not verified before the trusted head`,
    )
  }
  if (pinned.entryHash !== head.entryHash) {
    throw context.integrityError(
      `${subject} entry at pinned sequence ${head.sequence} carries ${pinned.entryHash} but the trusted head recorded ${head.entryHash} — the journal was rewritten`,
    )
  }
}
