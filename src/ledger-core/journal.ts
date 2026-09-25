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
 * That "whole file once" is still every row, however long ago it was already
 * proven unchanged. A codec that opts into `snapshotProjection` lets a fresh
 * instance shortcut it: `projector-snapshot.ts`'s cache still walks the whole
 * hash chain up to its checkpoint — nothing is exempted from tamper detection
 * — but only the checkpoint row and the true tail after it go through the
 * codec's own parsing and projector; the FileLedgerJournalOptions.projectorSnapshot
 * option controls how often a pinning append refreshes it.
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
  type LedgerProjectorSnapshot,
  projectorSnapshotPathFor,
  readProjectorSnapshotFile,
  removeProjectorSnapshotFile,
  writeProjectorSnapshotFile,
} from './projector-snapshot'
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

/** Serialize a projection into JSON-safe cache data, and rebuild a projector
 * from it whose next `apply` continues right after the entry it was taken
 * after — as if that projector had been live since sequence 0. Supplying
 * both opts a codec into the projector snapshot cache (`projector-snapshot.ts`):
 * a fresh journal open can then verify the generic hash chain of the rows
 * before a cached checkpoint without parsing or applying any of them through
 * this codec. Omit to disable the cache for this codec; every open then
 * fully replays through `createProjector`, exactly as before. */
export interface LedgerProjectorSnapshotCodec<Entry, Projection> {
  serialize(projection: Projection): unknown
  restore(serialized: unknown): LedgerProjector<Entry, Projection>
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
  snapshotProjection?: LedgerProjectorSnapshotCodec<LedgerEntryOf<Header, Event>, Projection>
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
  /** Cache a projector snapshot at the trusted head, refreshed once at least
   * this many entries have appended past the last cached one, so the cost
   * amortizes and a fresh open's tail stays bounded by this interval however
   * large the journal grows. Requires the codec's `snapshotProjection`; a
   * codec without it ignores this option and every open fully replays. */
  projectorSnapshot?: { everyEntries: number }
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
  /** Sequence of the last projector snapshot this instance wrote or seeded
   * from, or null when it has not cached one. Tracked in memory so a run of
   * pinning appends checks whether a refresh is due without re-reading the
   * cache file on every one of them. */
  snapshotSequence: number | null
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
  /** Sibling file holding this journal's cached projector snapshot, if its
   * codec opts in. */
  readonly projectorSnapshotPath: string
  private readonly codec: LedgerJournalCodec<Header, Event, Projection>
  private readonly mutex: Mutex
  private readonly requireTrustedHead: boolean
  private readonly snapshotEvery: number | null
  private verified: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection> | null = null

  constructor(
    path: string,
    codec: LedgerJournalCodec<Header, Event, Projection>,
    options: FileLedgerJournalOptions = {},
  ) {
    this.path = resolve(path)
    this.trustedHeadPath = trustedHeadPathFor(this.path)
    this.projectorSnapshotPath = projectorSnapshotPathFor(this.path)
    this.codec = codec
    this.mutex = mutexFor(this.path)
    this.requireTrustedHead = options.requireTrustedHead === true
    this.snapshotEvery =
      codec.snapshotProjection !== undefined && options.projectorSnapshot !== undefined
        ? options.projectorSnapshot.everyEntries
        : null
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
        this.maybeWriteProjectorSnapshot(state)
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
      // An explicit pin is already a deliberate, infrequent checkpoint call,
      // so — when the caller opted into the cache at all — it always
      // refreshes it rather than waiting for the interval. Gated on
      // `snapshotEvery`, not just the codec's support, so a journal that
      // never asked for `projectorSnapshot` never gets a cache file from
      // this path either; caching stays one on/off decision, not two.
      if (this.snapshotEvery !== null) this.writeProjectorSnapshotNow(state)
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
      // A cached snapshot that survived would be pinned to a head this
      // journal no longer vouches for, indistinguishable from a stale one a
      // future re-pin could seed from without earning it. It is not
      // security-critical to remove it — a reader only ever trusts a cached
      // checkpoint the current pin can vouch for — but keeping the sidecars
      // in agreement about what has been given up is the honest state to
      // leave on disk.
      removeProjectorSnapshotFile(this.projectorSnapshotPath, this.codec)
      if (this.verified !== null) {
        this.verified.pin = null
        this.verified.snapshotSequence = null
      }
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
        // This is the case a full verification exists to catch — a fresh
        // instance, or one whose retained head is no longer where it was
        // verified — so a cached checkpoint is only ever a shortcut to the
        // SAME conclusion a full replay would reach, never a substitute for
        // reaching it.
        state = (size > 0 ? this.seedFromSnapshot(fd, size) : null) ?? emptyJournal(this.codec)
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
    this.maybeWriteProjectorSnapshot(state)
  }

  /** Refresh the cached projector snapshot once the current pin has moved at
   * least `snapshotEvery` entries past the last one cached, so the write cost
   * amortizes across many appends and a fresh open's uncached tail stays
   * bounded by that interval no matter how large the journal grows. A no-op
   * when the codec does not support the cache, the option is off, or the
   * head this call just pinned is not actually new (the idempotent-append
   * path can call this after re-acknowledging an already-durable entry). */
  private maybeWriteProjectorSnapshot(
    state: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection>,
  ): void {
    if (this.codec.snapshotProjection === undefined || this.snapshotEvery === null) return
    if (state.pin === null || state.pin.sequence !== state.head?.entry.sequence) return
    if (
      state.snapshotSequence !== null &&
      state.pin.sequence - state.snapshotSequence < this.snapshotEvery
    ) {
      return
    }
    this.writeProjectorSnapshotNow(state)
  }

  /** Serialize the live projector and write it as the cache, unconditionally.
   * Callers have already established that `state.pin` names `state.head`, so
   * the cache and the pin agree on the checkpoint by construction. */
  private writeProjectorSnapshotNow(
    state: VerifiedJournal<LedgerEntryOf<Header, Event>, Projection>,
  ): void {
    const head = state.pin!
    const projection = this.codec.snapshotProjection!.serialize(state.projector.snapshot())
    const snapshot: LedgerProjectorSnapshot = { head, byteLength: state.size, projection }
    writeProjectorSnapshotFile(this.projectorSnapshotPath, snapshot, this.codec)
    state.snapshotSequence = head.sequence
  }

  /** Seed a fresh verified state from the cached projector snapshot, or null
   * when there is none this reader can use — a missing or out-of-reach
   * cache, never something this instance found actually wrong. Everything it
   * DOES accept is checked against the real bytes: rows 0 through the
   * checkpoint are read and chain-verified exactly as `admitEntry` would
   * verify them (self-consistent hash, correct sequence, linked previousHash,
   * unique eventId), just without this codec's own `parseEntry` or
   * `apply` — the checkpoint row itself still goes through both, through the
   * ordinary `parseRow`, so it is exactly as trustworthy as any entry a full
   * replay would produce. Any mismatch found along the way throws the same
   * `integrityError` a full replay of the same bytes would raise, because it
   * is the same tampering either path would have found; this is never turned
   * into a quiet fallback that would just re-read the same bytes differently
   * and risk reporting a different, more confusing failure — or none. */
  private seedFromSnapshot(
    fd: number,
    size: number,
  ): VerifiedJournal<LedgerEntryOf<Header, Event>, Projection> | null {
    const restore = this.codec.snapshotProjection
    if (restore === undefined) return null
    const cached = readProjectorSnapshotFile(this.projectorSnapshotPath, this.codec)
    if (cached === null) return null
    // Only a cache the CURRENT pin can vouch for is trusted. A pin moves
    // forward only past history that has already chain-verified (sync
    // verifies every appended row before a pinning append can move it), so a
    // cache at or behind the pin names a real, already-proven checkpoint; one
    // ahead of it — or present with no pin at all — names history nothing
    // external currently vouches for, and is ignored rather than trusted.
    const pin = readTrustedHeadFile(this.trustedHeadPath, this.codec)
    if (pin === null || cached.head.sequence > pin.sequence) return null
    if (cached.byteLength <= 0 || cached.byteLength > size) return null

    const prefix = readRange(fd, 0, cached.byteLength)
    const rows = splitRows(prefix, this.path, this.codec)
    if (rows.length !== cached.head.sequence + 1) {
      throw this.codec.integrityError(
        `${this.codec.subject} ${this.path} projector snapshot ${this.projectorSnapshotPath} expects ${cached.head.sequence + 1} entries in its first ${cached.byteLength} bytes but the journal has ${rows.length}`,
      )
    }

    const offsets: number[] = []
    const sequenceByEventId = new Map<string, number>()
    let previousHash: LedgerHash | null = null
    for (let index = 0; index < rows.length - 1; index += 1) {
      const row = rows[index]!
      offsets.push(row.start)
      let raw: unknown
      try {
        raw = JSON.parse(row.text)
      } catch (error) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} has invalid JSON at line ${index + 1}`,
          { cause: error },
        )
      }
      if (canonicalString(raw) !== row.text) {
        throw this.codec.integrityError(
          `${this.codec.subject} ${this.path} has non-canonical bytes at line ${index + 1}`,
        )
      }
      const fields = raw as {
        sequence?: unknown
        previousHash?: unknown
        entryHash?: unknown
        event?: { eventId?: unknown }
      }
      if (fields.sequence !== index) {
        throw this.codec.integrityError(
          `entry at line ${index + 1} has sequence ${String(fields.sequence)}, expected ${index}`,
        )
      }
      if ((fields.previousHash ?? null) !== previousHash) {
        throw this.codec.integrityError(
          `entry at line ${index + 1} does not extend the previous hash`,
        )
      }
      const { entryHash, ...material } = raw as Record<string, unknown>
      const expected = hashCanonical(material)
      if (entryHash !== expected) {
        throw this.codec.integrityError(
          `entry at line ${index + 1} hash mismatch: expected ${expected}, got ${String(entryHash)}`,
        )
      }
      const eventId = fields.event?.eventId
      if (typeof eventId !== 'string' || eventId === '') {
        throw this.codec.integrityError(`entry at line ${index + 1} has no eventId`)
      }
      if (sequenceByEventId.has(eventId)) {
        throw this.codec.integrityError(`duplicate eventId ${eventId} in durable ledger`)
      }
      sequenceByEventId.set(eventId, index)
      previousHash = entryHash as LedgerHash
    }

    // The checkpoint row itself carries this codec's own validation, exactly
    // like any other entry — the cache never substitutes for parsing it.
    const boundary = rows[rows.length - 1]!
    offsets.push(boundary.start)
    const entry = parseRow(
      boundary.text,
      { path: this.path, line: cached.head.sequence + 1 },
      this.codec,
    )
    const { entryHash: _boundaryHash, ...boundaryMaterial } = entry
    if (
      entry.sequence !== cached.head.sequence ||
      entry.previousHash !== previousHash ||
      entry.entryHash !== cached.head.entryHash ||
      hashCanonical(boundaryMaterial) !== cached.head.entryHash
    ) {
      throw this.codec.integrityError(
        `${this.codec.subject} ${this.path} projector snapshot ${this.projectorSnapshotPath} does not match the journal at sequence ${cached.head.sequence}`,
      )
    }
    this.codec.checkEntryHeader(entry, cached.head.sequence)
    if (sequenceByEventId.has(entry.event.eventId)) {
      throw this.codec.integrityError(`duplicate eventId ${entry.event.eventId} in durable ledger`)
    }
    sequenceByEventId.set(entry.event.eventId, entry.sequence)

    let projector: LedgerProjector<LedgerEntryOf<Header, Event>, Projection>
    try {
      projector = restore.restore(cached.projection)
    } catch (error) {
      throw this.codec.integrityError(
        `${this.codec.subject} ${this.path} projector snapshot ${this.projectorSnapshotPath} could not be restored`,
        { cause: error },
      )
    }

    return {
      identity: null,
      size: cached.byteLength,
      offsets,
      head: { entry, row: Buffer.from(`${boundary.text}\n`, 'utf8') },
      sequenceByEventId,
      projector,
      pin: null,
      snapshotSequence: cached.head.sequence,
    }
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
    snapshotSequence: null,
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
