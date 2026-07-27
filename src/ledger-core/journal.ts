/**
 * Generic durable append-only journal with a SHA-256 hash chain.
 *
 * The file format is canonical JSONL: every row is the canonical JSON encoding
 * (RFC 8785, object keys sorted recursively) of one entry, and every entry
 * hashes the previous entry's hash so the log is tamper-evident. Appends are
 * serialized in-process per path and across processes via a lock file, fsynced
 * before acknowledgement, and idempotent by `eventId`. A malformed,
 * non-canonical, truncated, reordered, or conflicting log fails loudly; a bad
 * row is never skipped.
 *
 * A hash chain binds each entry to its predecessor, which cannot prove that no
 * entry was removed from the end: a valid shorter prefix is still a valid
 * chain. `pinHead` records the appended entry in a sibling `<journal>.head`
 * file and every read re-verifies the journal against a pin that is present,
 * so truncation and wholesale rewrite are refused. `trusted-head.ts` carries
 * the full threat model, including what a pin does not defend against.
 *
 * Domain vocabulary lives entirely in the consumer's codec: entry schema
 * validation, the constant header fields stamped into every entry, the error
 * taxonomy, and the state machine replayed over verified entries.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Mutex } from '../concurrency'
import { canonicalString, hashCanonical, type LedgerHash } from './canonical'
import { appendLedgerLine, type LedgerFileContext, withLedgerFileLock } from './journal-file'
import {
  type LedgerTrustedHead,
  readTrustedHeadFile,
  trustedHeadPathFor,
  verifyEntriesAgainstTrustedHead,
  writeTrustedHeadFile,
} from './trusted-head'

/** Minimum shape of a journal event: the idempotency key. */
export interface LedgerEventBase {
  eventId: string
}

/** Chain envelope every entry carries in addition to the journal's constant
 * header fields. `entryHash` covers the header, sequence, previous hash, and
 * event, so any rewrite of history invalidates every later entry. */
export interface LedgerChainFields<Event extends LedgerEventBase> {
  sequence: number
  previousHash: LedgerHash | null
  event: Event
  entryHash: LedgerHash
}

export type LedgerEntryOf<Header extends object, Event extends LedgerEventBase> = Header &
  LedgerChainFields<Event>

export interface LedgerLineContext {
  path: string
  line: number
}

/** Domain state machine replayed over chain-verified entries in order.
 * `apply` throws (via the codec's error taxonomy) on an invalid transition;
 * `finish` builds the consumer's projection once every entry was applied. */
export interface LedgerProjector<Entry, Projection> {
  apply(entry: Entry, index: number): void
  finish(entries: Entry[]): Projection
}

export interface LedgerJournalCodec<
  Header extends object,
  Event extends LedgerEventBase,
  Projection,
> extends LedgerFileContext {
  /** Constant fields stamped into every entry and covered by its hash. */
  header: Header
  conflictError(message: string): Error
  /** Validate one parsed JSON row into a typed entry. Must reject malformed
   * rows and non-canonical event encodings with the binding's own errors;
   * the journal itself verifies the stored bytes and the hash chain. */
  parseEntry(raw: unknown, context: LedgerLineContext): LedgerEntryOf<Header, Event>
  /** Reject an entry whose constant header fields do not match this journal. */
  checkEntryHeader(entry: LedgerEntryOf<Header, Event>, index: number): void
  createProjector(): LedgerProjector<LedgerEntryOf<Header, Event>, Projection>
}

export interface LedgerReplayResult<Entry, Projection> {
  entries: Entry[]
  projection: Projection
}

export interface LedgerAppendResult<Entry, Projection> {
  entry: Entry
  /** False when the exact event was already durably present. */
  appended: boolean
  projection: Projection
}

export interface LedgerAppendOptions {
  /** Record the appended entry as this journal's trusted head, so a later read
   * can prove nothing was deleted from the end. Ignored on the idempotent
   * path: acknowledging an event that was already durable writes nothing, and
   * moving the pin there would jump trust forward past entries this caller
   * never saw. */
  pinHead?: boolean
}

export interface FileLedgerJournalOptions {
  /** Refuse to read a non-empty journal that has no trusted head.
   *
   * Off by default because journals written before pinning have no pin and
   * must keep opening. Turn it on for a journal this process pins: without it,
   * deleting the sibling pin file silently downgrades the journal back to a
   * chain that cannot detect deletion. */
  requireTrustedHead?: boolean
}

// One async mutex per resolved journal path so concurrent appends from a single
// process queue up instead of failing on the held cross-process lock file.
const journalMutexes = new Map<string, Mutex>()

function mutexFor(path: string): Mutex {
  const existing = journalMutexes.get(path)
  if (existing) return existing
  const mutex = new Mutex()
  journalMutexes.set(path, mutex)
  return mutex
}

/** Durable filesystem journal. Construction performs no I/O; `append` and
 * `replay` validate the complete existing file under the locks. */
export class FileLedgerJournal<Header extends object, Event extends LedgerEventBase, Projection> {
  readonly path: string
  /** Sibling file holding this journal's trusted head. */
  readonly trustedHeadPath: string
  private readonly codec: LedgerJournalCodec<Header, Event, Projection>
  private readonly mutex: Mutex
  private readonly requireTrustedHead: boolean

  constructor(
    path: string,
    codec: LedgerJournalCodec<Header, Event, Projection>,
    options: FileLedgerJournalOptions = {},
  ) {
    this.path = resolve(path)
    this.trustedHeadPath = trustedHeadPathFor(this.path)
    this.codec = codec
    this.mutex = mutexFor(this.path)
    this.requireTrustedHead = options.requireTrustedHead === true
  }

  async replay(): Promise<LedgerReplayResult<LedgerEntryOf<Header, Event>, Projection>> {
    return this.mutex.runExclusive(() =>
      withLedgerFileLock(this.path, this.codec, () => this.replayLocked()),
    )
  }

  async append(
    event: Event,
    options: LedgerAppendOptions = {},
  ): Promise<LedgerAppendResult<LedgerEntryOf<Header, Event>, Projection>> {
    return this.mutex.runExclusive(() =>
      withLedgerFileLock(this.path, this.codec, () => {
        const before = this.replayLocked()
        const existing = before.entries.find((entry) => entry.event.eventId === event.eventId)
        if (existing) {
          if (canonicalString(existing.event) !== canonicalString(event)) {
            throw this.codec.conflictError(
              `eventId ${event.eventId} already exists with different content`,
            )
          }
          return { entry: existing, appended: false, projection: before.projection }
        }

        const material = {
          ...this.codec.header,
          sequence: before.entries.length,
          previousHash: before.entries.at(-1)?.entryHash ?? null,
          event,
        }
        const entry = { ...material, entryHash: hashCanonical(material) }

        // Apply the state transition before spending an append: an entry the
        // projector rejects must never reach the durable file.
        const projection = this.project([...before.entries, entry])
        appendLedgerLine(this.path, `${canonicalString(entry)}\n`, this.codec)
        if (options.pinHead === true) {
          // Journal first, pin second: a crash between them leaves the pin one
          // entry behind, which still verifies and is healed by the next
          // pinning append. The reverse order would leave a pin naming an
          // entry the journal does not carry, locking the journal out.
          writeTrustedHeadFile(
            this.trustedHeadPath,
            { sequence: entry.sequence, entryHash: entry.entryHash },
            this.codec,
          )
        }
        return { entry, appended: true, projection }
      }),
    )
  }

  /** The pinned head, or null when this journal has never been pinned. */
  async trustedHead(): Promise<LedgerTrustedHead | null> {
    return this.mutex.runExclusive(() =>
      withLedgerFileLock(this.path, this.codec, () =>
        readTrustedHeadFile(this.trustedHeadPath, this.codec),
      ),
    )
  }

  /** Pin the current verified head. The chain and any existing pin are checked
   * first, so the pin only ever moves forward along a journal that still
   * carries the history it already recorded. */
  async pinTrustedHead(): Promise<LedgerTrustedHead> {
    return this.mutex.runExclusive(() =>
      withLedgerFileLock(this.path, this.codec, () => {
        const entries = this.readEntries()
        this.project(entries)
        // `requireTrustedHead` is deliberately not applied here: pinning is how
        // a journal that lacks a pin acquires one.
        this.verifyTrustedHead(entries, false)
        const last = entries.at(-1)
        if (last === undefined) {
          throw this.codec.integrityError(
            `${this.codec.subject} ${this.path} is empty; there is no head to pin`,
          )
        }
        const head: LedgerTrustedHead = { sequence: last.sequence, entryHash: last.entryHash }
        writeTrustedHeadFile(this.trustedHeadPath, head, this.codec)
        return head
      }),
    )
  }

  private replayLocked(): LedgerReplayResult<LedgerEntryOf<Header, Event>, Projection> {
    const entries = this.readEntries()
    const projection = this.project(entries)
    // The anchor is meaningful only over a chain that already verified, so it
    // is checked last — and on every read path, so a violated pin is refused
    // before an append can extend the journal over it.
    this.verifyTrustedHead(entries, this.requireTrustedHead)
    return { entries, projection }
  }

  private verifyTrustedHead(entries: LedgerEntryOf<Header, Event>[], requirePin: boolean): void {
    const pinned = readTrustedHeadFile(this.trustedHeadPath, this.codec)
    if (pinned === null) {
      if (requirePin && entries.length > 0) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} has ${entries.length} entries but no trusted head at ${this.trustedHeadPath} — without its pin the journal cannot prove nothing was deleted`,
        )
      }
      return
    }
    verifyEntriesAgainstTrustedHead(
      entries,
      pinned,
      this.codec,
      `${this.codec.subject} ${this.path}`,
    )
  }

  private readEntries(): LedgerEntryOf<Header, Event>[] {
    if (!existsSync(this.path)) return []
    const text = readFileSync(this.path, 'utf8')
    if (text.length === 0) return []
    if (!text.endsWith('\n')) {
      throw this.codec.integrityError(
        `${this.codec.subject} ${this.path} has a truncated final record (missing newline)`,
      )
    }

    const lines = text.slice(0, -1).split('\n')
    const entries: LedgerEntryOf<Header, Event>[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      if (line.length === 0) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} has a blank row at line ${index + 1}`,
        )
      }
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch (error) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} has invalid JSON at line ${index + 1}`,
          { cause: error },
        )
      }
      const entry = this.codec.parseEntry(raw, { path: this.path, line: index + 1 })
      let canonical: string
      try {
        canonical = canonicalString(entry)
      } catch (error) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} has a row with no canonical JSON form at line ${index + 1}`,
          { cause: error },
        )
      }
      if (line !== canonical) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} has non-canonical bytes at line ${index + 1}`,
        )
      }
      entries.push(entry)
    }
    return entries
  }

  private project(entries: LedgerEntryOf<Header, Event>[]): Projection {
    const projector = this.codec.createProjector()
    const eventIds = new Set<string>()
    let expectedPrevious: LedgerHash | null = null
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      this.codec.checkEntryHeader(entry, index)
      if (entry.sequence !== index) {
        throw this.codec.integrityError(
          `entry ${entry.event.eventId} has sequence ${entry.sequence}, expected ${index}`,
        )
      }
      if (entry.previousHash !== expectedPrevious) {
        throw this.codec.integrityError(
          `entry ${entry.event.eventId} does not extend the previous hash`,
        )
      }
      const { entryHash: _entryHash, ...material } = entry
      const expectedHash = hashCanonical(material)
      if (entry.entryHash !== expectedHash) {
        throw this.codec.integrityError(
          `entry ${entry.event.eventId} hash mismatch: expected ${expectedHash}, got ${entry.entryHash}`,
        )
      }
      expectedPrevious = entry.entryHash
      if (eventIds.has(entry.event.eventId)) {
        throw this.codec.integrityError(
          `duplicate eventId ${entry.event.eventId} in durable ledger`,
        )
      }
      eventIds.add(entry.event.eventId)
      projector.apply(entry, index)
    }
    return projector.finish(entries)
  }
}
