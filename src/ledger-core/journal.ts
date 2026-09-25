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
 * Verification is incremental. A journal instance verifies its whole file once,
 * on its first call, and keeps the verified head, the live projector, and an
 * eventId index. Every later call checks that the head line it verified is
 * still in place, then reads, verifies, and projects only the bytes past it, so
 * an append reads one entry however long the journal is. Rows another writer
 * appended are verified as that tail. A file that was replaced, shrank, or no
 * longer carries the verified head is verified whole again. What an open
 * instance cannot see is a same-length rewrite of rows before its head; a new
 * instance verifies every row and refuses one.
 *
 * Domain vocabulary lives entirely in the consumer's codec: entry schema
 * validation, the constant header fields stamped into every entry, the error
 * taxonomy, and the state machine replayed over verified entries.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { resolve } from 'node:path'
import { Mutex } from '../concurrency'
import { canonicalString, hashCanonical, type LedgerHash } from './canonical'
import { deepFreezeCanonicalJson } from './deep-freeze'
import { appendLedgerLine, type LedgerFileContext, withLedgerFileLock } from './journal-file'
import {
  clearTrustedHeadFile,
  type LedgerTrustedHead,
  type LedgerTrustedHeadRemoval,
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

/** Domain state machine applied to chain-verified entries in order.
 *
 * One projector lives as long as its journal instance's verified state: the
 * journal applies each entry once, including entries appended later, and asks
 * for `snapshot()` after any number of them. `apply` throws (via the codec's
 * error taxonomy) on an invalid transition; after a throw the journal discards
 * the projector and replays the file into a new one, so `apply` need not undo
 * a partial update. Entries are deep-frozen before `apply` sees them. */
export interface LedgerProjector<Entry, Projection> {
  apply(entry: Entry, index: number): void
  /** The projection of every entry applied so far. A later `apply` must not
   * change a projection already returned, so a snapshot copies any state the
   * projector keeps mutating. */
  snapshot(): Projection
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
   * the journal itself verifies the stored bytes and the hash chain. A new
   * entry passes through the same parse before it is written, so the journal
   * never writes a row it would refuse to read. */
  parseEntry(raw: unknown, context: LedgerLineContext): LedgerEntryOf<Header, Event>
  /** Reject an entry whose constant header fields do not match this journal. */
  checkEntryHeader(entry: LedgerEntryOf<Header, Event>, index: number): void
  createProjector(): LedgerProjector<LedgerEntryOf<Header, Event>, Projection>
}

export interface LedgerAppendResult<Entry, Projection> {
  entry: Entry
  /** False when the exact event was already durably present. */
  appended: boolean
  projection: Projection
}

export interface LedgerAppendOptions {
  /** Record the appended entry as this journal's trusted head, so a later read
   * can prove nothing was deleted from the end.
   *
   * On the idempotent path — the event is already durable — the pin moves up to
   * that entry only when the entry is ahead of it, along a chain this call has
   * just verified. So a pin write that failed after its row was fsynced is
   * repaired by the retry that idempotency already asks the caller for, and the
   * pin still only ever moves forward over history it has checked.
   *
   * A strict journal whose first pin write failed still refuses the retry
   * because it cannot distinguish that failure from a deleted pin. Recover it
   * explicitly with `pinTrustedHead()`; silently adopting the current file
   * would defeat `requireTrustedHead`. */
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

/** The part of a journal file one instance has verified. It is valid only
 * between successful locked calls: any failure discards it, and the next call
 * verifies the whole file again. */
interface VerifiedJournal<Entry, Projection> {
  /** Device and inode of the verified file; null until the file exists. */
  identity: { dev: bigint; ino: bigint } | null
  /** Verified byte length, which is where the next entry starts. */
  size: number
  /** Byte offset of each entry's row, indexed by sequence. */
  offsets: number[]
  /** The last entry and its row bytes, newline included. Finding these bytes
   * at the end of the verified length is what lets a call trust every row
   * before them without reading them. */
  head: { entry: Entry; row: Buffer } | null
  sequenceByEventId: Map<string, number>
  projector: LedgerProjector<Entry, Projection>
  /** The pin last verified against this chain, or null when there was none. */
  pin: LedgerTrustedHead | null
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

/** Durable filesystem journal. Construction performs no I/O. The first call
 * verifies the complete file under the locks; later calls verify the retained
 * head and only the bytes past it (see the module comment). */
export class FileLedgerJournal<Header extends object, Event extends LedgerEventBase, Projection> {
  readonly path: string
  /** Sibling file holding this journal's trusted head. */
  readonly trustedHeadPath: string
  private readonly codec: LedgerJournalCodec<Header, Event, Projection>
  private readonly mutex: Mutex
  private readonly requireTrustedHead: boolean
  private verified: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection> | null = null

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

  async replay(): Promise<Projection> {
    return this.locked(() => this.sync(this.requireTrustedHead).projector.snapshot())
  }

  async append(
    event: Event,
    options: LedgerAppendOptions = {},
  ): Promise<LedgerAppendResult<LedgerEntryOf<Header, Event>, Projection>> {
    return this.locked(() => {
      const state = this.sync(this.requireTrustedHead)
      const existingSequence = state.sequenceByEventId.get(event.eventId)
      if (existingSequence !== undefined) {
        const existing = this.entryAt(state, existingSequence)!
        if (canonicalString(existing.event) !== canonicalString(event)) {
          throw this.codec.conflictError(
            `eventId ${event.eventId} already exists with different content`,
          )
        }
        if (options.pinHead === true) this.pinAcknowledged(state, existing)
        return { entry: existing, appended: false, projection: state.projector.snapshot() }
      }

      const sequence = state.offsets.length
      const material = {
        ...this.codec.header,
        sequence,
        previousHash: state.head?.entry.entryHash ?? null,
        event,
      }
      const text = canonicalString({ ...material, entryHash: hashCanonical(material) })
      // The new row goes through the reader's own parse and the projector's
      // transition before it is written: a row the journal would refuse to
      // read, or an entry the projector rejects, never reaches the file.
      const entry = parseRow(text, { path: this.path, line: sequence + 1 }, this.codec)
      const row = Buffer.from(`${text}\n`, 'utf8')
      admitEntry(state, entry, row, this.codec)
      appendLedgerLine(this.path, `${text}\n`, this.codec)
      if (options.pinHead === true) {
        // Journal first, pin second: a crash or a failed pin write between
        // them leaves the pin one entry behind, which still verifies and is
        // repaired by the next pinning append, including the idempotent
        // retry of this same event. The reverse order would leave a pin
        // naming an entry the journal does not carry, locking the journal
        // out of its own history.
        const head = { sequence: entry.sequence, entryHash: entry.entryHash }
        writeTrustedHeadFile(this.trustedHeadPath, head, this.codec)
        state.pin = head
      }
      return { entry, appended: true, projection: state.projector.snapshot() }
    })
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
    return this.locked(() => {
      // `requireTrustedHead` is deliberately not applied here: pinning is how
      // a journal that lacks a pin acquires one.
      const state = this.sync(false)
      if (state.head === null) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} is empty; there is no head to pin`,
        )
      }
      const head: LedgerTrustedHead = {
        sequence: state.head.entry.sequence,
        entryHash: state.head.entry.entryHash,
      }
      writeTrustedHeadFile(this.trustedHeadPath, head, this.codec)
      state.pin = head
      return head
    })
  }

  /** Discard this journal's pin, reporting what was discarded. The journal file
   * is untouched and reads as unpinned afterwards, so the next pinning append
   * opens a new pin at the entry it writes. It is the way out of a pin whose
   * journal was deliberately deleted or rebuilt — every read of such a path is
   * refused, correctly, because a pin naming history the file no longer carries
   * is indistinguishable from a deletion. Clearing removes the deletion
   * guarantee for every entry the pin covered. */
  async clearTrustedHead(): Promise<LedgerTrustedHeadRemoval> {
    return this.locked(() => {
      const removal = clearTrustedHeadFile(this.trustedHeadPath, this.codec)
      if (this.verified !== null) this.verified.pin = null
      return removal
    })
  }

  /** Run under both locks. Any failure discards the verified state, because a
   * throw can leave it describing bytes the file does not hold: a projector
   * half way through a rejected transition, or a row whose write failed. */
  private locked<T>(run: () => T): Promise<T> {
    return this.mutex.runExclusive(() =>
      withLedgerFileLock(this.path, this.codec, () => {
        try {
          return run()
        } catch (error) {
          this.verified = null
          throw error
        }
      }),
    )
  }

  /** Bring the verified state up to the file: keep it when its head row is
   * still where it was verified, else start over from byte 0; then verify and
   * apply every row past it, and check the pin. */
  private sync(requirePin: boolean): VerifiedJournal<LedgerEntryOf<Header, Event>, Projection> {
    let state = this.verified
    const fd = openForReading(this.path, this.codec)
    if (fd === null) {
      // A missing file is an empty journal, whatever this instance saw before.
      if (state === null || state.size > 0) state = emptyJournal(this.codec)
      this.verified = state
      this.verifyPin(state, requirePin)
      return state
    }
    try {
      const stats = fstatSync(fd, { bigint: true })
      const size = Number(stats.size)
      const identity = { dev: stats.dev, ino: stats.ino }
      if (
        state === null ||
        (state.identity !== null &&
          (state.identity.dev !== identity.dev || state.identity.ino !== identity.ino)) ||
        size < state.size ||
        !headInPlace(fd, state.size, state.head?.row ?? null)
      ) {
        state = emptyJournal(this.codec)
      }
      state.identity = identity
      this.verified = state
      if (size > state.size) {
        extendJournal(state, readRange(fd, state.size, size), this.path, this.codec)
      }
    } finally {
      closeSync(fd)
    }
    this.verifyPin(state, requirePin)
    return state
  }

  private verifyPin(
    state: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection>,
    requirePin: boolean,
  ): void {
    const pinned = readTrustedHeadFile(this.trustedHeadPath, this.codec)
    const count = state.offsets.length
    if (pinned === null) {
      state.pin = null
      if (requirePin && count > 0) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} has ${count} entries but no trusted head at ${this.trustedHeadPath} — without its pin the journal cannot prove nothing was deleted. Restore the pin file, or adopt the current head with pinTrustedHead().`,
        )
      }
      return
    }
    // A pin already verified against this chain stays verified while the
    // chain's head is in place; sync has just checked that.
    if (state.pin?.sequence === pinned.sequence && state.pin.entryHash === pinned.entryHash) {
      return
    }
    // The anchor is meaningful only over a chain that already verified, so it
    // is checked after sync — and on every call, so a violated pin is refused
    // before an append can extend the journal over it.
    const chain = { length: count, at: (sequence: number) => this.entryAt(state, sequence) }
    verifyEntriesAgainstTrustedHead(chain, pinned, this.codec, {
      subject: `${this.codec.subject} ${this.path}`,
      trustedHeadPath: this.trustedHeadPath,
    })
    state.pin = pinned
  }

  /** Move the pin up to an entry this caller just acknowledged on the
   * idempotent path, when a pin write that failed after its row was already
   * fsynced left the pin behind. The move is safe because it is forward-only
   * along a chain `sync` has just verified: every entry up to this one is bound
   * to it by hash, so the pin can only ever come to name more history than it
   * did, never different history.
   *
   * With no pin at all this only pins the journal's current head. An entry in
   * the middle would publish a pin that reads as protection while leaving every
   * later entry silently truncatable, which is a worse state to hand an auditor
   * than the honest absence of a pin; `pinTrustedHead()` is the way to pin an
   * unpinned journal on purpose. */
  private pinAcknowledged(
    state: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection>,
    entry: LedgerEntryOf<Header, Event>,
  ): void {
    const pinned = state.pin
    if (pinned === null) {
      if (entry.sequence !== state.offsets.length - 1) return
    } else if (pinned.sequence >= entry.sequence) {
      return
    }
    const head = { sequence: entry.sequence, entryHash: entry.entryHash }
    writeTrustedHeadFile(this.trustedHeadPath, head, this.codec)
    state.pin = head
  }

  /** The verified entry at `sequence`, read back from the file. The rows from
   * it to the head are re-read and must chain to the verified head hash, which
   * binds the returned entry to the history this instance verified. Callers ask
   * for recent entries — an idempotent retry, a pin one entry behind — so this
   * usually reads nothing or one row. */
  private entryAt(
    state: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection>,
    sequence: number,
  ): LedgerEntryOf<Header, Event> | undefined {
    const count = state.offsets.length
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= count) return undefined
    if (sequence === count - 1) return state.head!.entry
    const changed = () =>
      this.codec.integrityError(
        `${this.codec.subject} ${this.path} changed at or after sequence ${sequence} since this reader verified it`,
      )
    const fd = openForReading(this.path, this.codec)
    if (fd === null) throw changed()
    let bytes: Buffer
    try {
      bytes = readRange(fd, state.offsets[sequence]!, state.size)
    } finally {
      closeSync(fd)
    }
    const rows = splitRows(bytes, this.path, this.codec)
    if (rows.length !== count - sequence) throw changed()
    let first: LedgerEntryOf<Header, Event> | undefined
    let previous: LedgerEntryOf<Header, Event> | undefined
    for (let index = 0; index < rows.length; index += 1) {
      const entry = parseRow(
        rows[index]!.text,
        { path: this.path, line: sequence + index + 1 },
        this.codec,
      )
      const { entryHash, ...material } = entry
      if (
        entry.sequence !== sequence + index ||
        hashCanonical(material) !== entryHash ||
        (previous !== undefined && entry.previousHash !== previous.entryHash)
      ) {
        throw changed()
      }
      first ??= entry
      previous = entry
    }
    if (previous?.entryHash !== state.head!.entry.entryHash) throw changed()
    return first
  }
}

/** Where a memory journal keeps its text: an in-process store keyed by path,
 * such as an in-memory `CampaignStorage`. */
export interface LedgerTextStore {
  read(path: string): string | undefined
  write(path: string, text: string): void
}

/**
 * A journal for runs without a filesystem. It keeps its rows as text in a
 * store and applies the file journal's rules: the same row parse, hash chain,
 * idempotent append by `eventId`, and projector transition before a row is
 * kept. It has no lock, fsync or trusted head, because its rows live and die
 * with the process that holds the store.
 */
export class MemoryLedgerJournal<Header extends object, Event extends LedgerEventBase, Projection> {
  readonly path: string
  private readonly codec: LedgerJournalCodec<Header, Event, Projection>
  private readonly store: LedgerTextStore
  private verified: {
    text: string
    journal: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection>
    entries: LedgerEntryOf<Header, Event>[]
  } | null = null

  constructor(
    path: string,
    codec: LedgerJournalCodec<Header, Event, Projection>,
    store: LedgerTextStore,
  ) {
    this.path = path
    this.codec = codec
    this.store = store
  }

  async replay(): Promise<Projection> {
    return this.guarded(() => this.sync().journal.projector.snapshot())
  }

  async append(
    event: Event,
  ): Promise<LedgerAppendResult<LedgerEntryOf<Header, Event>, Projection>> {
    return this.guarded(() => {
      const verified = this.sync()
      const { journal, entries } = verified
      const existingSequence = journal.sequenceByEventId.get(event.eventId)
      if (existingSequence !== undefined) {
        const existing = entries[existingSequence]!
        if (canonicalString(existing.event) !== canonicalString(event)) {
          throw this.codec.conflictError(
            `eventId ${event.eventId} already exists with different content`,
          )
        }
        return { entry: existing, appended: false, projection: journal.projector.snapshot() }
      }
      const sequence = entries.length
      const material = {
        ...this.codec.header,
        sequence,
        previousHash: journal.head?.entry.entryHash ?? null,
        event,
      }
      const text = canonicalString({ ...material, entryHash: hashCanonical(material) })
      const entry = parseRow(text, { path: this.path, line: sequence + 1 }, this.codec)
      admitEntry(journal, entry, Buffer.from(`${text}\n`, 'utf8'), this.codec)
      entries.push(entry)
      verified.text = `${verified.text}${text}\n`
      this.store.write(this.path, verified.text)
      return { entry, appended: true, projection: journal.projector.snapshot() }
    })
  }

  /** Verify the stored text again whenever it is not the text this instance wrote. */
  private sync(): NonNullable<MemoryLedgerJournal<Header, Event, Projection>['verified']> {
    const text = this.store.read(this.path) ?? ''
    if (this.verified?.text === text) return this.verified
    const journal = emptyJournal(this.codec)
    const entries: LedgerEntryOf<Header, Event>[] = []
    const bytes = Buffer.from(text, 'utf8')
    for (const row of splitRows(bytes, this.path, this.codec)) {
      const entry = parseRow(row.text, { path: this.path, line: entries.length + 1 }, this.codec)
      admitEntry(journal, entry, Buffer.from(bytes.subarray(row.start, row.end)), this.codec)
      entries.push(entry)
    }
    this.verified = { text, journal, entries }
    return this.verified
  }

  /** A refused transition can leave the projector half applied; discard it. */
  private async guarded<T>(run: () => T): Promise<T> {
    try {
      return run()
    } catch (error) {
      this.verified = null
      throw error
    }
  }
}

/** Verify and replay resolved immutable journal bytes without filesystem I/O. */
export function replayLedgerText<Header extends object, Event extends LedgerEventBase, Projection>(
  text: string,
  path: string,
  codec: LedgerJournalCodec<Header, Event, Projection>,
): Projection {
  const state = emptyJournal(codec)
  extendJournal(state, Buffer.from(text, 'utf8'), path, codec)
  return state.projector.snapshot()
}

function emptyJournal<Header extends object, Event extends LedgerEventBase, Projection>(
  codec: LedgerJournalCodec<Header, Event, Projection>,
): VerifiedJournal<LedgerEntryOf<Header, Event>, Projection> {
  return {
    identity: null,
    size: 0,
    offsets: [],
    head: null,
    sequenceByEventId: new Map(),
    projector: codec.createProjector(),
    pin: null,
  }
}

/** Verify and apply the rows in `bytes`, which start at the state's verified
 * length. */
function extendJournal<Header extends object, Event extends LedgerEventBase, Projection>(
  state: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection>,
  bytes: Buffer,
  path: string,
  codec: LedgerJournalCodec<Header, Event, Projection>,
): void {
  const rows = splitRows(bytes, path, codec)
  for (const { text, start, end } of rows) {
    const entry = parseRow(text, { path, line: state.offsets.length + 1 }, codec)
    // Copy the row: a view would keep the whole read buffer alive.
    admitEntry(state, entry, Buffer.from(bytes.subarray(start, end)), codec)
  }
}

/** Check one parsed entry against the chain and apply it. Every row, read or
 * about to be written, enters the verified state here. */
function admitEntry<Header extends object, Event extends LedgerEventBase, Projection>(
  state: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection>,
  entry: LedgerEntryOf<Header, Event>,
  row: Buffer,
  codec: LedgerJournalCodec<Header, Event, Projection>,
): void {
  const index = state.offsets.length
  codec.checkEntryHeader(entry, index)
  if (entry.sequence !== index) {
    throw codec.integrityError(
      `entry ${entry.event.eventId} has sequence ${entry.sequence}, expected ${index}`,
    )
  }
  if (entry.previousHash !== (state.head?.entry.entryHash ?? null)) {
    throw codec.integrityError(`entry ${entry.event.eventId} does not extend the previous hash`)
  }
  const { entryHash: _entryHash, ...material } = entry
  const expectedHash = hashCanonical(material)
  if (entry.entryHash !== expectedHash) {
    throw codec.integrityError(
      `entry ${entry.event.eventId} hash mismatch: expected ${expectedHash}, got ${entry.entryHash}`,
    )
  }
  if (state.sequenceByEventId.has(entry.event.eventId)) {
    throw codec.integrityError(`duplicate eventId ${entry.event.eventId} in durable ledger`)
  }
  state.projector.apply(entry, index)
  state.sequenceByEventId.set(entry.event.eventId, index)
  state.offsets.push(state.size)
  state.size += row.byteLength
  state.head = { entry, row }
}

/** Parse one canonical row into a frozen entry. The projector and every caller
 * share entries, so none of them can change what the journal verified. */
function parseRow<Header extends object, Event extends LedgerEventBase, Projection>(
  text: string,
  context: LedgerLineContext,
  codec: LedgerJournalCodec<Header, Event, Projection>,
): LedgerEntryOf<Header, Event> {
  const { path, line } = context
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw codec.integrityError(`${codec.subject} ${path} has invalid JSON at line ${line}`, {
      cause: error,
    })
  }
  const entry = codec.parseEntry(raw, context)
  let canonical: string
  try {
    canonical = canonicalString(entry)
  } catch (error) {
    throw codec.integrityError(
      `${codec.subject} ${path} has a row with no canonical JSON form at line ${line}`,
      { cause: error },
    )
  }
  if (text !== canonical) {
    throw codec.integrityError(`${codec.subject} ${path} has non-canonical bytes at line ${line}`)
  }
  return deepFreezeCanonicalJson(entry)
}

interface JournalRow {
  text: string
  /** Byte range of the row in the buffer, newline included. */
  start: number
  end: number
}

function splitRows(bytes: Buffer, path: string, context: LedgerFileContext): JournalRow[] {
  if (bytes.byteLength === 0) return []
  if (bytes[bytes.byteLength - 1] !== 0x0a) {
    throw context.integrityError(
      `${context.subject} ${path} has a truncated final record (missing newline)`,
    )
  }
  const rows: JournalRow[] = []
  let start = 0
  while (start < bytes.byteLength) {
    const newline = bytes.indexOf(0x0a, start)
    if (newline === start) {
      throw context.integrityError(
        `${context.subject} ${path} has a blank row at line ${rows.length + 1}`,
      )
    }
    rows.push({ text: bytes.toString('utf8', start, newline), start, end: newline + 1 })
    start = newline + 1
  }
  return rows
}

/** True when the verified head row still ends the verified length of the file. */
function headInPlace(fd: number, size: number, row: Buffer | null): boolean {
  return row === null || readRange(fd, size - row.byteLength, size).equals(row)
}

/** A read-only descriptor, or null when the file does not exist. */
function openForReading(path: string, context: LedgerFileContext): number | null {
  try {
    return openSync(path, constants.O_RDONLY)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw context.integrityError(`${context.subject} ${path} could not be opened for reading`, {
      cause: error,
    })
  }
}

function readRange(fd: number, start: number, end: number): Buffer {
  const bytes = Buffer.allocUnsafe(end - start)
  let offset = 0
  while (offset < bytes.byteLength) {
    const read = readSync(fd, bytes, offset, bytes.byteLength - offset, start + offset)
    if (read === 0) return bytes.subarray(0, offset)
    offset += read
  }
  return bytes
}
