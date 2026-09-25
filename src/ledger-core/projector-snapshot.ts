/**
 * Projector snapshot — the cache that lets opening a large journal replay
 * only its tail.
 *
 * `trusted-head.ts`'s pin proves a journal's length and prefix content
 * without trusting a producer's summary; it does not make PROVING that
 * cheap. Every open still walks every row from sequence 0, parses it through
 * the domain codec, and applies it to a fresh projector, because that was the
 * only way this module knew to rebuild `Projection`.
 *
 * This file adds one more sidecar: `<journal>.snapshot` holds a `Projection`
 * a codec that opts in (`snapshotProjection` on its `LedgerJournalCodec`)
 * serialized, alongside the `(sequence, entryHash)` it was taken after. A
 * reader that finds one still verifies the generic hash chain of every row up
 * to that checkpoint — self-consistency and chain linkage, the same two
 * checks `journal.ts`'s `admitEntry` runs on every row — because that
 * verification is what the pin's guarantee actually rests on (see
 * `trusted-head.ts`'s module comment: an entry hash commits to its whole
 * prefix, so there is no way to prove a prefix unchanged without touching
 * every byte of it at least once). What the cache lets a reader skip is the
 * codec's OWN parsing (`parseEntry`, typically zod validation) and the domain
 * projector's `apply` for every row before the checkpoint: rows that already
 * passed both once, at write time, and whose bytes the chain walk has just
 * proven are unchanged since. Only the checkpoint row itself, and every row
 * after it, go through the full domain path — exactly as an already-open
 * instance that had verified up to there would already do.
 *
 * A snapshot that does not match the journal's actual bytes — a chain that
 * does not reach the claimed hash, a wrong entry count for its byte range —
 * fails loudly with the same kind of `integrityError` a full replay would
 * raise for the same tampered bytes; the tampering is real regardless of
 * which path found it, so it is never swallowed in favor of a fallback that
 * would silently re-read the same bytes a different way. Only a MISSING
 * cache file, or one this journal's current pin cannot vouch for at all
 * (§`journal.ts`'s `seedFromSnapshot`), is treated as "no cache" and falls
 * back to full verification.
 */

import { readFileSync } from 'node:fs'
import { LEDGER_HASH_PATTERN, type LedgerHash } from './canonical'
import { type LedgerFileContext, removeLedgerFile, writeLedgerFileAtomically } from './journal-file'
import type { LedgerTrustedHead } from './trusted-head'

/** A cached projection and the pinned entry it was taken after. */
export interface LedgerProjectorSnapshot {
  head: LedgerTrustedHead
  /** Byte length of the journal file up to and including the pinned entry's
   * own row. Where the rows this snapshot covers end and the tail it did not
   * cover begins. */
  byteLength: number
  /** The codec's serialized projection. Opaque to this module. */
  projection: unknown
}

/** Sibling cache file for a journal, alongside its `.head` pin. */
export function projectorSnapshotPathFor(journalPath: string): string {
  return `${journalPath}.snapshot`
}

const RECOVERY =
  ' Restore the file, or remove it and let the journal rebuild it at its next checkpoint.'

/** The cached snapshot, or null when none has been written. Present but
 * unparseable is corruption of the cache itself, not its absence, and fails
 * loudly for the same reason `readTrustedHeadFile` does: silently treating it
 * as "no cache" would just make the next read replay from scratch without
 * ever explaining why the cache stopped working. */
export function readProjectorSnapshotFile(
  path: string,
  context: LedgerFileContext,
): LedgerProjectorSnapshot | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} could not be read.${RECOVERY}`,
      { cause: error },
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} is not valid JSON.${RECOVERY}`,
      { cause: error },
    )
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} is not an object.${RECOVERY}`,
    )
  }
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 3 ||
    keys[0] !== 'byteLength' ||
    keys[1] !== 'head' ||
    keys[2] !== 'projection'
  ) {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} has keys [${keys.join(', ')}], expected [byteLength, head, projection].${RECOVERY}`,
    )
  }
  const { byteLength, head, projection } = record
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} byteLength is not a positive integer.${RECOVERY}`,
    )
  }
  if (typeof head !== 'object' || head === null || Array.isArray(head)) {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} head is not an object.${RECOVERY}`,
    )
  }
  const headRecord = head as Record<string, unknown>
  const headKeys = Object.keys(headRecord).sort()
  if (headKeys.length !== 2 || headKeys[0] !== 'entryHash' || headKeys[1] !== 'sequence') {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} head has keys [${headKeys.join(', ')}], expected [entryHash, sequence].${RECOVERY}`,
    )
  }
  const { sequence, entryHash } = headRecord
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} head.sequence is not a non-negative integer.${RECOVERY}`,
    )
  }
  if (typeof entryHash !== 'string' || !LEDGER_HASH_PATTERN.test(entryHash)) {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} head.entryHash is not a sha256 digest.${RECOVERY}`,
    )
  }
  return {
    head: { sequence, entryHash: entryHash as LedgerHash },
    byteLength,
    projection,
  }
}

/** Publish a snapshot by write-then-rename, so a crash leaves either the
 * previous cache or the new one and never a torn file a reader would have to
 * refuse. Not re-exported from the package's public surface, for the same
 * reason `writeTrustedHeadFile` is not: it takes no lock and enforces no
 * monotonicity against the journal it caches. `FileLedgerJournal` is the only
 * writer, always immediately after its own `sync()` has verified the exact
 * state it is about to cache. */
export function writeProjectorSnapshotFile(
  path: string,
  snapshot: LedgerProjectorSnapshot,
  context: LedgerFileContext,
): void {
  const body = JSON.stringify({
    byteLength: snapshot.byteLength,
    head: snapshot.head,
    projection: snapshot.projection,
  })
  try {
    writeLedgerFileAtomically(path, `${body}\n`, context)
  } catch (error) {
    throw context.integrityError(
      `${context.subject} projector snapshot ${path} could not be written`,
      { cause: error },
    )
  }
}

/** Discard a journal's cached snapshot. A missing cache is not an error: this
 * is how `clearTrustedHead()` keeps the two sidecars from disagreeing about
 * what the journal's writer has vouched for, and it is safe to call whether
 * or not a cache ever existed. */
export function removeProjectorSnapshotFile(path: string, context: LedgerFileContext): void {
  removeLedgerFile(path, context)
  removeLedgerFile(`${path}.tmp`, context)
}
