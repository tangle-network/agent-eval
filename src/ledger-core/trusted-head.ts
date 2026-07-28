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
 *
 * ## Abandoning a pin
 *
 * A pin outlives the journal it attests: deleting or rebuilding the journal
 * leaves a pin naming history the file no longer carries, and every read is
 * refused because that is precisely the deletion the pin exists to catch. The
 * refusal names the pin file, and `clearTrustedHeadFile` is the explicit way to
 * discard it — the same downgrade a writer with filesystem access could already
 * perform with `rm`, made reachable through the API so it is a decision in the
 * code rather than an undocumented manual step. It returns the guarantee it
 * gave up and writes no record of its own; a caller that needs the discard on
 * the record has to write one.
 */

import { readFileSync } from 'node:fs'
import { canonicalString, LEDGER_HASH_PATTERN, type LedgerHash } from './canonical'
import { type LedgerFileContext, removeLedgerFile, writeLedgerFileAtomically } from './journal-file'

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
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw context.integrityError(
      `${context.subject} trusted head ${path} could not be read. Restore the file, or discard the pin it held with clearTrustedHead().`,
      { cause: error },
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw context.integrityError(
      `${context.subject} trusted head ${path} is not valid JSON. Restore the file, or discard the pin it held with clearTrustedHead().`,
      { cause: error },
    )
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
 * its own trust record.
 *
 * Module-internal on purpose. It takes no lock, checks no chain, and enforces
 * no monotonicity, so an exported form would be the one call in this package
 * able to move a pin BACKWARD onto a journal it never read — which is the
 * truncation the pin exists to refuse. `FileLedgerJournal.pinTrustedHead` is
 * the public writer: locked, chain-verified, forward-only. */
export function writeTrustedHeadFile(
  path: string,
  head: LedgerTrustedHead,
  context: LedgerFileContext,
): void {
  try {
    writeLedgerFileAtomically(path, `${canonicalString(head)}\n`, context)
  } catch (error) {
    throw context.integrityError(`${context.subject} trusted head ${path} could not be written`, {
      cause: error,
    })
  }
}

/** Outcome of discarding a pin: the guarantee that was given up. `unreadable`
 * carries why the discarded pin could not be named — corruption, a permission
 * fault, a wrong file type — so a caller recording the decision never has to
 * treat "no pin was there" and "the pin could not be read" as one state. */
export type LedgerTrustedHeadRemoval =
  | { removed: true; head: LedgerTrustedHead }
  | { removed: true; head: null; unreadable: string }
  | { removed: false }

/** Discard a journal's pin, reporting what was discarded. The journal file is
 * untouched and reads as unpinned afterwards, so the next pinning append opens
 * a new pin at the entry it writes. This gives up the deletion guarantee for
 * every entry the pin covered; it is the recovery for a pin whose journal was
 * deliberately deleted or rebuilt, and the only way past a pin file that can no
 * longer be read at all. */
export function clearTrustedHeadFile(
  path: string,
  context: LedgerFileContext,
): LedgerTrustedHeadRemoval {
  let head: LedgerTrustedHead | null = null
  let unreadable = ''
  try {
    head = readTrustedHeadFile(path, context)
  } catch (error) {
    // A pin nobody can read is precisely what clearing has to get past, so the
    // fault is reported on a removal that still happens rather than raised —
    // but it is reported, never flattened into "there was no pin".
    unreadable = error instanceof Error ? error.message : String(error)
  }
  // The atomic writer's temporary sibling would otherwise outlive the pin it
  // was staging, leaving the reset half-done.
  removeLedgerFile(`${path}.tmp`, context)
  if (!removeLedgerFile(path, context)) return { removed: false }
  if (head === null) return { removed: true, head: null, unreadable }
  return { removed: true, head }
}

/** How a journal is named when a trusted-head check refuses it. */
export interface LedgerTrustedHeadSubject {
  /** The journal in error messages, e.g. `search ledger /runs/a/ledger.jsonl`. */
  subject: string
  /** The sibling pin file, named in every refusal so the operator can see which
   * of the two files carries the claim being enforced. */
  trustedHeadPath: string
}

/** The entry at exactly `head.sequence` must still carry `head.entryHash`.
 * Entries must already have passed chain verification, which is what makes
 * index and sequence interchangeable here. */
export function verifyEntriesAgainstTrustedHead(
  entries: readonly LedgerAnchoredEntry[],
  head: LedgerTrustedHead,
  context: LedgerFileContext,
  naming: LedgerTrustedHeadSubject,
): void {
  // A caller passing the bare subject string an untyped build would accept
  // destructures into two undefineds, which would corrupt the text of a
  // security refusal rather than fail. Refuse instead.
  if (typeof naming !== 'object' || naming === null) {
    throw new TypeError(
      'verifyEntriesAgainstTrustedHead expects { subject, trustedHeadPath } as its fourth argument',
    )
  }
  const { subject, trustedHeadPath } = naming
  const pinned = entries[head.sequence]
  if (pinned === undefined) {
    throw context.integrityError(
      `${subject} trusted head ${trustedHeadPath} pins sequence ${head.sequence} (${head.entryHash}) but the journal has ${entries.length} entries — pinned history is missing (truncation, rollback, or rewrite). Restore the journal, or abandon the pinned history on purpose with clearTrustedHead().`,
    )
  }
  if (pinned.sequence !== head.sequence) {
    throw context.integrityError(
      `${subject} entry at index ${head.sequence} carries sequence ${pinned.sequence}; the chain was not verified before the trusted head ${trustedHeadPath}`,
    )
  }
  if (pinned.entryHash !== head.entryHash) {
    throw context.integrityError(
      `${subject} entry at pinned sequence ${head.sequence} carries ${pinned.entryHash} but the trusted head ${trustedHeadPath} recorded ${head.entryHash} — the journal was rewritten. Restore the journal, or abandon the pinned history on purpose with clearTrustedHead().`,
    )
  }
}
