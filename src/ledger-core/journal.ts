/**
 * Generic durable append-only journal with a SHA-256 hash chain.
 *
 * The file format is canonical JSONL: every row is the canonical JSON encoding
 * (object keys sorted recursively) of one entry, and every entry hashes the
 * previous entry's hash so the log is tamper-evident. Appends are serialized
 * in-process per path and across processes via a lock file, fsynced before
 * acknowledgement, and idempotent by `eventId`. A malformed, non-canonical,
 * truncated, reordered, or conflicting log fails loudly; a bad row is never
 * skipped.
 *
 * Domain vocabulary lives entirely in the consumer's codec: entry schema
 * validation, the constant header fields stamped into every entry, the error
 * taxonomy, and the state machine replayed over verified entries.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Mutex } from '../concurrency'
import { canonicalize } from '../pre-registration'
import { appendLedgerLine, type LedgerFileContext, withLedgerFileLock } from './journal-file'

export type LedgerHash = `sha256:${string}`

/** Canonical JSON encoding: object keys sorted recursively. This is the byte
 * form that is hashed and stored, so identical values always encode identically. */
export function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function hashCanonical(value: unknown): LedgerHash {
  return `sha256:${createHash('sha256').update(canonicalString(value)).digest('hex')}`
}

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
  private readonly codec: LedgerJournalCodec<Header, Event, Projection>
  private readonly mutex: Mutex

  constructor(path: string, codec: LedgerJournalCodec<Header, Event, Projection>) {
    this.path = resolve(path)
    this.codec = codec
    this.mutex = mutexFor(this.path)
  }

  async replay(): Promise<LedgerReplayResult<LedgerEntryOf<Header, Event>, Projection>> {
    return this.mutex.runExclusive(() =>
      withLedgerFileLock(this.path, this.codec, () => this.replayLocked()),
    )
  }

  async append(
    event: Event,
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
        return { entry, appended: true, projection }
      }),
    )
  }

  private replayLocked(): LedgerReplayResult<LedgerEntryOf<Header, Event>, Projection> {
    const entries = this.readEntries()
    return { entries, projection: this.project(entries) }
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
      if (line !== canonicalString(entry)) {
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
