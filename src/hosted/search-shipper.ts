/**
 * Ship a search ledger to a hosted store while the search runs, or after.
 *
 * The local ledger is the source of truth and the search never waits on the
 * network: the shipper reads the ledger file the recorder already made
 * durable, uploads the blobs each entry names, then posts the entries. It
 * starts from the store's head, so a restarted process, a lost response, or a
 * second shipper continues where the store's chain ends instead of resending
 * the search. A store that holds a different chain for the same search stops
 * the shipper with `SearchShipConflictError`; nothing is overwritten.
 */

import { createHash } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { SearchLedgerEntry, SearchLedgerHash } from '../campaign/search-ledger-types'
import { createHostedClient, type HostedClient, type HostedTenant } from './client'
import {
  SEARCH_LEDGER_BATCH_MAX_BYTES,
  SEARCH_LEDGER_BATCH_MAX_LINES,
  type SearchLedgerConflict,
  type SearchLedgerHead,
  type SearchRunKind,
  searchLedgerArtifactRefs,
} from './search-ledger-wire'
import { HOSTED_WIRE_VERSION } from './types'

export interface SearchShipOptions {
  tenant: HostedTenant
  ledger: { path: string; searchId: string }
  runKind: SearchRunKind
  /** `full` (default) uploads every blob an entry names; `digests` ships the
   * entries alone, so the store holds refs and digests without content. */
  content?: 'full' | 'digests'
  signal?: AbortSignal
}

/** A blob an entry names that was not uploaded, and why. */
export interface SearchShipMissingBlob {
  sha256: SearchLedgerHash
  uri: string
  reason: string
}

export interface SearchShipResult {
  searchId: string
  /** The store's head after the last accepted batch. */
  head: SearchLedgerHead
  /** Local complete lines, which the store now holds when `head` reaches them. */
  localLines: number
  /** Ledger lines posted, counting resends after a gap. */
  linesPosted: number
  batches: number
  /** Resends after the store answered `sequence_gap`. */
  gapResends: number
  blobs: {
    content: 'full' | 'digests'
    uploaded: number
    stored: number
    masked: number
    withheld: number
    missing: SearchShipMissingBlob[]
  }
}

/** The store holds a different chain for this search. */
export class SearchShipConflictError extends Error {
  readonly conflict: SearchLedgerConflict
  constructor(conflict: SearchLedgerConflict) {
    super(
      `search ${conflict.head.searchId}: ${conflict.error}: ${conflict.message} (store head ${conflict.head.nextSequence} ${conflict.head.headHash ?? 'empty'})`,
    )
    this.name = 'SearchShipConflictError'
    this.conflict = conflict
  }
}

/** Ship every complete line of the ledger file now, then return. */
export async function shipSearchLedger(options: SearchShipOptions): Promise<SearchShipResult> {
  return new SearchLedgerTail(options).ship()
}

export interface SearchShipper {
  /** Ship what is in the file now without waiting for the next tick. */
  flush(): Promise<SearchShipResult>
  /** Stop tailing, ship the rest of the file, and return the final result. */
  stop(): Promise<SearchShipResult>
  /** The last transient failure, cleared by the next successful tick. */
  readonly lastError: Error | null
}

/**
 * Tail the ledger: ship new lines every `intervalMs` (default 2 s) until
 * `stop()`. A transient failure is kept on `lastError` and retried on the next
 * tick; a conflict stops tailing and is thrown by `stop()`.
 */
export function startSearchShipper(
  options: SearchShipOptions & { intervalMs?: number },
): SearchShipper {
  const tail = new SearchLedgerTail(options)
  const intervalMs = options.intervalMs ?? 2000
  const stopping = new AbortController()
  let lastError: Error | null = null
  let conflict: SearchShipConflictError | null = null
  let running: Promise<unknown> = Promise.resolve()

  const tick = (): Promise<unknown> => {
    running = running.then(async () => {
      if (conflict) return
      try {
        await tail.ship()
        lastError = null
      } catch (error) {
        if (error instanceof SearchShipConflictError) conflict = error
        else lastError = error instanceof Error ? error : new Error(String(error))
      }
    })
    return running
  }

  const loop = (async () => {
    while (!stopping.signal.aborted && !conflict) {
      await tick()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs)
        stopping.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
    }
  })()

  return {
    get lastError() {
      return lastError
    },
    async flush() {
      await tick()
      if (conflict) throw conflict
      if (lastError) throw lastError
      return tail.result()
    },
    async stop() {
      stopping.abort()
      await loop
      await running
      if (conflict) throw conflict
      return tail.ship()
    },
  }
}

/** One full batch of lines with their newlines, plus a byte to see where a
 * maximal line ends. */
const READ_CHUNK_BYTES = SEARCH_LEDGER_BATCH_MAX_BYTES + SEARCH_LEDGER_BATCH_MAX_LINES + 1

interface LocalLine {
  text: string
  entry: SearchLedgerEntry
  bytes: number
}

class SearchLedgerTail {
  private readonly client: HostedClient
  private readonly options: SearchShipOptions
  private readonly content: 'full' | 'digests'
  /** Where the store's chain ends, and the byte offset of that line locally. */
  private head: SearchLedgerHead | null = null
  private offset = 0
  private localLines = 0
  private readonly uploaded = new Set<string>()
  private readonly missing = new Map<string, SearchShipMissingBlob>()
  private readonly counts = {
    linesPosted: 0,
    batches: 0,
    gapResends: 0,
    uploaded: 0,
    stored: 0,
    masked: 0,
    withheld: 0,
  }

  constructor(options: SearchShipOptions) {
    this.options = options
    this.content = options.content ?? 'full'
    this.client = createHostedClient(options.tenant)
  }

  result(): SearchShipResult {
    const { linesPosted, batches, gapResends, uploaded, stored, masked, withheld } = this.counts
    return {
      searchId: this.options.ledger.searchId,
      head: this.head ?? {
        searchId: this.options.ledger.searchId,
        nextSequence: 0,
        headHash: null,
      },
      localLines: this.localLines,
      linesPosted,
      batches,
      gapResends,
      blobs: {
        content: this.content,
        uploaded,
        stored,
        masked,
        withheld,
        missing: [...this.missing.values()],
      },
    }
  }

  async ship(): Promise<SearchShipResult> {
    const { signal } = this.options
    if (this.head === null) {
      await this.syncTo(await this.client.searchLedgerHead(this.options.ledger.searchId, signal))
    }
    for (;;) {
      const lines = await this.readChunk(this.offset, this.head!)
      if (lines.length === 0) return this.result()
      const batch = takeBatch(lines)
      if (this.content === 'full') await this.uploadBlobs(batch)
      const fromSequence = this.head!.nextSequence
      const outcome = await this.client.ingestSearchLedger(
        {
          wireVersion: HOSTED_WIRE_VERSION,
          searchId: this.options.ledger.searchId,
          runKind: this.options.runKind,
          fromSequence,
          lines: batch.map((line) => line.text),
        },
        signal,
      )
      this.counts.batches++
      this.counts.linesPosted += batch.length
      if (outcome.status === 'conflict') {
        if (outcome.conflict.error === 'chain_conflict') {
          throw new SearchShipConflictError(outcome.conflict)
        }
        this.counts.gapResends++
        await this.syncTo(outcome.conflict.head)
        continue
      }
      const last = batch.at(-1)!.entry
      if (
        outcome.head.nextSequence < last.sequence + 1 ||
        (outcome.head.nextSequence === last.sequence + 1 &&
          outcome.head.headHash !== last.entryHash)
      ) {
        throw new Error(
          `store acknowledged sequence ${fromSequence}..${last.sequence} with head ${outcome.head.nextSequence} ${outcome.head.headHash}`,
        )
      }
      await this.syncTo(outcome.head)
    }
  }

  /** Move the cursor to the store's head, checking that the local ledger holds
   * the same entry there. A different entry is a fork; a store ahead of the
   * local file holds lines this ledger never wrote. */
  private async syncTo(head: SearchLedgerHead): Promise<void> {
    if (head.searchId !== this.options.ledger.searchId) {
      throw new Error(`store answered for search ${head.searchId}`)
    }
    const fork = (message: string) =>
      new SearchShipConflictError({ error: 'chain_conflict', message, head })
    const empty: SearchLedgerHead = { searchId: head.searchId, nextSequence: 0, headHash: null }
    const forward = this.head !== null && head.nextSequence >= this.head.nextSequence
    let offset = forward ? this.offset : 0
    let cursor = forward ? this.head! : empty
    while (cursor.nextSequence < head.nextSequence) {
      const lines = await this.readChunk(offset, cursor)
      if (lines.length === 0) {
        throw fork(
          `the store holds ${head.nextSequence} entries; the local ledger holds ${cursor.nextSequence}`,
        )
      }
      const take = Math.min(lines.length, head.nextSequence - cursor.nextSequence)
      for (let index = 0; index < take; index++) offset += lines[index]!.bytes
      const last = lines[take - 1]!.entry
      cursor = {
        searchId: head.searchId,
        nextSequence: last.sequence + 1,
        headHash: last.entryHash,
      }
    }
    if (cursor.headHash !== head.headHash) {
      throw fork(`the store's entry ${head.nextSequence - 1} differs from the local ledger's`)
    }
    this.offset = offset
    this.head = head
  }

  /** The complete lines in one read chunk from `offset`, checked to continue
   * the chain at `head`. A chunk holds at least one full batch. */
  private async readChunk(offset: number, head: SearchLedgerHead): Promise<LocalLine[]> {
    const bytes = await readRange(this.options.ledger.path, offset, READ_CHUNK_BYTES)
    const lines: LocalLine[] = []
    let start = 0
    let expectedSequence = head.nextSequence
    let previousHash = head.headHash
    for (;;) {
      const newline = bytes.indexOf(0x0a, start)
      // A line without its newline is still being written, or continues in
      // the next chunk.
      if (newline < 0) break
      const text = bytes.toString('utf8', start, newline)
      const entry = JSON.parse(text) as SearchLedgerEntry
      if (
        entry.searchId !== this.options.ledger.searchId ||
        entry.sequence !== expectedSequence ||
        entry.previousHash !== previousHash
      ) {
        throw new Error(
          `${this.options.ledger.path} line ${expectedSequence + 1} does not continue the chain at sequence ${expectedSequence}`,
        )
      }
      lines.push({ text, entry, bytes: newline + 1 - start })
      expectedSequence++
      previousHash = entry.entryHash
      start = newline + 1
    }
    if (lines.length === 0 && bytes.byteLength === READ_CHUNK_BYTES) {
      throw new Error(
        `${this.options.ledger.path} line ${expectedSequence + 1} is longer than ${SEARCH_LEDGER_BATCH_MAX_BYTES} bytes; one request carries at most that`,
      )
    }
    this.localLines = Math.max(this.localLines, expectedSequence)
    return lines
  }

  private async uploadBlobs(batch: LocalLine[]): Promise<void> {
    for (const line of batch) {
      for (const ref of searchLedgerArtifactRefs(line.entry.event)) {
        if (this.uploaded.has(ref.sha256) || this.missing.has(ref.sha256)) continue
        const bytes = await readBlob(ref.uri)
        if (typeof bytes === 'string') {
          this.missing.set(ref.sha256, { sha256: ref.sha256, uri: ref.uri, reason: bytes })
          continue
        }
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
        if (digest !== ref.sha256 || bytes.byteLength !== ref.byteLength) {
          this.missing.set(ref.sha256, {
            sha256: ref.sha256,
            uri: ref.uri,
            reason: `local bytes are ${digest} (${bytes.byteLength} bytes), not the ref's ${ref.sha256} (${ref.byteLength} bytes)`,
          })
          continue
        }
        const stored = await this.client.putSearchBlob(
          ref.sha256,
          new Uint8Array(bytes),
          ref.uri.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          this.options.signal,
        )
        this.uploaded.add(ref.sha256)
        this.counts.uploaded++
        this.counts[stored.state]++
      }
    }
  }
}

/** The longest prefix of `lines` within one request's limits. */
function takeBatch(lines: LocalLine[]): LocalLine[] {
  const batch: LocalLine[] = []
  let bytes = 0
  for (const line of lines) {
    const size = line.bytes - 1
    if (size > SEARCH_LEDGER_BATCH_MAX_BYTES) {
      throw new Error(
        `ledger line ${line.entry.sequence} holds ${size} bytes; one request carries at most ${SEARCH_LEDGER_BATCH_MAX_BYTES}`,
      )
    }
    if (
      batch.length === SEARCH_LEDGER_BATCH_MAX_LINES ||
      bytes + size > SEARCH_LEDGER_BATCH_MAX_BYTES
    )
      break
    batch.push(line)
    bytes += size
  }
  return batch
}

/** Up to `limit` bytes of the file from `offset`; empty before the recorder
 * created the file. */
async function readRange(path: string, offset: number, limit: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && offset === 0) return Buffer.alloc(0)
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size < offset) throw new Error(`${path} shrank below byte ${offset}`)
    const bytes = Buffer.alloc(Math.min(limit, size - offset))
    let read = 0
    while (read < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, read, bytes.byteLength - read, offset + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return bytes.subarray(0, read)
  } finally {
    await handle.close()
  }
}

/** The bytes at a `file:` ref, or why there are none. */
async function readBlob(uri: string): Promise<Buffer | string> {
  if (!uri.startsWith('file:'))
    return `the shipper reads only file: refs, not ${uri.split(':')[0]}:`
  try {
    return await readFile(fileURLToPath(uri))
  } catch (error) {
    return `unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`
  }
}

/**
 * Run a ship that must never fail its caller, such as the one a loop runs at
 * its end. A failure, a store short of the local ledger, or a blob that did
 * not upload is logged with the command that resumes it.
 */
export async function shipBestEffort(
  ship: () => Promise<SearchShipResult>,
  ledgerPath: string,
): Promise<SearchShipResult | undefined> {
  const resume = `agent-eval search ship ${ledgerPath}`
  try {
    const shipped = await ship()
    if (shipped.head.nextSequence < shipped.localLines) {
      console.warn(
        `[agent-eval] search ${shipped.searchId}: the store holds ${shipped.head.nextSequence} of ${shipped.localLines} ledger entries; resume with ${resume}`,
      )
    }
    if (shipped.blobs.missing.length > 0) {
      console.warn(
        `[agent-eval] search ${shipped.searchId}: ${shipped.blobs.missing.length} blob(s) were not uploaded, first: ${shipped.blobs.missing[0]!.reason}`,
      )
    }
    return shipped
  } catch (error) {
    console.warn(
      `[agent-eval] search ledger ship failed (continuing; resume with ${resume}): ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}
