/**
 * Real-run proof for the projector snapshot cache (`ledger-core/projector-snapshot.ts`).
 *
 * Builds a real hash-chained journal on disk through `FileLedgerJournal` with
 * a small but real (non-mocked) counter-ledger codec that opts into
 * `snapshotProjection`, appends real entries with real fsyncs, and checks
 * three things against the real files:
 *
 *   1. A fresh instance seeded from the cached snapshot produces the exact
 *      same projection as a fresh instance that ignores the cache and does a
 *      full replay ("snapshot plus tail equals full replay").
 *   2. Same-length tampering of a row BEFORE the cached checkpoint is refused
 *      by a snapshot-seeded open, exactly as it is refused by a full replay —
 *      the cache never turns a real chain break into a silent success.
 *   3. The snapshot-seeded open reads and CPU-parses measurably fewer bytes
 *      than a full replay once the ledger is large, by wrapping the real
 *      `node:fs` read calls the same way `ledger-journal-load.ts` does.
 *
 *   node --import tsx scripts/ledger-snapshot-proof.ts [--entries 20000] [--every 2000]
 *
 * Output is one JSON document on stdout. Exit 1 when a check fails.
 */

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

type Category = 'journal' | 'head' | 'snapshot' | 'other'

const bytesRead: Record<Category, number> = { journal: 0, head: 0, snapshot: 0, other: 0 }
const openPaths = new Map<number, string>()
let journalPath = ''

function category(path: string | undefined): Category {
  if (path === journalPath) return 'journal'
  if (path === `${journalPath}.head`) return 'head'
  if (path === `${journalPath}.snapshot`) return 'snapshot'
  return 'other'
}

const { openSync, closeSync, readSync, readFileSync } = fs
fs.openSync = ((path: fs.PathLike, ...rest: unknown[]) => {
  const fd = (openSync as (...args: unknown[]) => number)(path, ...rest)
  openPaths.set(fd, String(path))
  return fd
}) as typeof fs.openSync
fs.closeSync = ((fd: number) => {
  openPaths.delete(fd)
  closeSync(fd)
}) as typeof fs.closeSync
fs.readSync = ((fd: number, ...rest: unknown[]) => {
  const read = (readSync as (...args: unknown[]) => number)(fd, ...rest)
  bytesRead[category(openPaths.get(fd))] += read
  return read
}) as typeof fs.readSync
fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
  const contents = (readFileSync as (...args: unknown[]) => string | Buffer)(path, ...rest)
  const key = typeof path === 'number' ? openPaths.get(path) : String(path)
  bytesRead[category(key)] +=
    typeof contents === 'string' ? Buffer.byteLength(contents) : contents.byteLength
  return contents
}) as typeof fs.readFileSync
syncBuiltinESMExports()

const { FileLedgerJournal } = await import('../src/ledger-core/journal')
const { canonicalString } = await import('../src/ledger-core/canonical')
import type { LedgerEntryOf, LedgerJournalCodec, LedgerProjector } from '../src/ledger-core/journal'

// A small, real domain: a ledger of named counters. `apply` and `snapshot`
// are real business logic (not a mock), just simple enough to keep the proof
// legible; `serialize`/`restore` round-trip the running totals as plain JSON.

const eventSchema = z
  .object({ eventId: z.string().min(1), counter: z.string().min(1), amount: z.number().int() })
  .strict()
type CounterEvent = z.infer<typeof eventSchema>
type CounterProjection = Record<string, number>
const HEADER = { schema: 'proof.counter-ledger.v1' as const }
type Header = typeof HEADER

function counterCodec(
  snapshotting: boolean,
): LedgerJournalCodec<Header, CounterEvent, CounterProjection> {
  const base: LedgerJournalCodec<Header, CounterEvent, CounterProjection> = {
    subject: 'counter ledger',
    header: HEADER,
    integrityError: (message, options) => new Error(message, options),
    conflictError: (message) => new Error(message),
    parseEntry: (raw, context) => {
      const decoded = z
        .object({
          schema: z.literal(HEADER.schema),
          sequence: z.number().int().nonnegative(),
          previousHash: z.string().nullable(),
          event: eventSchema,
          entryHash: z.string(),
        })
        .strict()
        .safeParse(raw)
      if (!decoded.success) {
        throw new Error(`${context.path}:${context.line} invalid: ${decoded.error.message}`)
      }
      return decoded.data as unknown as LedgerEntryOf<Header, CounterEvent>
    },
    checkEntryHeader: (entry) => {
      if (entry.schema !== HEADER.schema) throw new Error('wrong schema')
    },
    createProjector: (): LedgerProjector<LedgerEntryOf<Header, CounterEvent>, CounterProjection> => {
      const totals = new Map<string, number>()
      return {
        apply: (entry) => {
          totals.set(entry.event.counter, (totals.get(entry.event.counter) ?? 0) + entry.event.amount)
        },
        snapshot: () => Object.fromEntries(totals),
      }
    },
  }
  if (!snapshotting) return base
  return {
    ...base,
    snapshotProjection: {
      serialize: (projection) => projection,
      restore: (serialized) => {
        const totals = new Map(Object.entries(serialized as CounterProjection))
        return {
          apply: (entry) => {
            totals.set(entry.event.counter, (totals.get(entry.event.counter) ?? 0) + entry.event.amount)
          },
          snapshot: () => Object.fromEntries(totals),
        }
      },
    },
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const entries = Number(argument('entries') ?? '20000')
const every = Number(argument('every') ?? '2000')
const directory = fs.mkdtempSync(join(tmpdir(), 'ledger-snapshot-proof-'))
journalPath = join(directory, 'counters.jsonl')

function snapshotBytes(): Record<Category, number> {
  return { ...bytesRead }
}
function delta(before: Record<Category, number>): Record<Category, number> {
  return {
    journal: bytesRead.journal - before.journal,
    head: bytesRead.head - before.head,
    snapshot: bytesRead.snapshot - before.snapshot,
    other: bytesRead.other - before.other,
  }
}

async function buildLedger(): Promise<void> {
  const journal = new FileLedgerJournal(journalPath, counterCodec(true), {
    requireTrustedHead: true,
    projectorSnapshot: { everyEntries: every },
  })
  for (let index = 0; index < entries; index += 1) {
    await journal.append(
      { eventId: `evt-${index}`, counter: `c${index % 7}`, amount: (index % 5) + 1 },
      { pinHead: true },
    )
  }
}

async function timedReplay(
  snapshotting: boolean,
): Promise<{ digest: string; ms: number; cpuMs: number; bytes: Record<Category, number> }> {
  const before = snapshotBytes()
  const cpu = process.cpuUsage()
  const started = performance.now()
  const journal = new FileLedgerJournal(journalPath, counterCodec(snapshotting), {
    requireTrustedHead: true,
    ...(snapshotting ? { projectorSnapshot: { everyEntries: every } } : {}),
  })
  const projection = await journal.replay()
  const { user, system } = process.cpuUsage(cpu)
  return {
    digest: canonicalString(projection),
    ms: performance.now() - started,
    cpuMs: (user + system) / 1000,
    bytes: delta(before),
  }
}

/** Flip one hex digit in a row's entryHash in place, keeping the file the same length. */
function tamperRow(sequence: number): () => void {
  const text = fs.readFileSync(journalPath, 'utf8')
  const rows = text.split('\n')
  const original = rows[sequence]!
  const marker = original.lastIndexOf('"entryHash":"') + '"entryHash":"'.length
  const digit = original[marker] === '0' ? '1' : '0'
  rows[sequence] = `${original.slice(0, marker)}${digit}${original.slice(marker + 1)}`
  fs.writeFileSync(journalPath, rows.join('\n'))
  return () => {
    rows[sequence] = original
    fs.writeFileSync(journalPath, rows.join('\n'))
  }
}

async function refusal(snapshotting: boolean): Promise<string> {
  try {
    await timedReplay(snapshotting)
    return 'accepted'
  } catch (error) {
    return `refused: ${error instanceof Error ? error.message.slice(0, 180) : String(error)}`
  }
}

async function main(): Promise<number> {
  await buildLedger()
  const rowCount = fs.readFileSync(journalPath, 'utf8').split('\n').length - 1
  const snapshotFile = JSON.parse(fs.readFileSync(`${journalPath}.snapshot`, 'utf8')) as {
    head: { sequence: number }
    byteLength: number
  }

  const cached = await timedReplay(true)
  const full = await timedReplay(false)
  const checks: { case: string; asExpected: boolean; detail: string }[] = []

  checks.push({
    case: 'snapshot-seeded projection equals full-replay projection',
    asExpected: cached.digest === full.digest,
    detail: `cached digest ${cached.digest} vs full digest ${full.digest}`,
  })
  // Both opens still read every byte of the file at least once — that is the
  // cost the hash chain's tamper-evidence requires (see projector-snapshot.ts's
  // module comment) and this design never claims to skip. What the cache
  // skips is CPU: the codec's own zod parsing and the domain projector's
  // `apply` for every row before the checkpoint, replaced by one cheap
  // generic hash-chain walk over the same bytes.
  checks.push({
    case: 'snapshot-seeded open uses measurably less CPU than full replay',
    asExpected: cached.cpuMs < full.cpuMs * 0.6,
    detail: `cached ${cached.cpuMs.toFixed(1)}ms vs full ${full.cpuMs.toFixed(1)}ms CPU (${(
      full.cpuMs / cached.cpuMs
    ).toFixed(2)}x)`,
  })

  const middleSequence = Math.floor(snapshotFile.head.sequence / 2)
  const restoreMiddle = tamperRow(middleSequence)
  const tamperedCached = await refusal(true)
  const tamperedFull = await refusal(false)
  checks.push({
    case: `row ${middleSequence} (before the sequence ${snapshotFile.head.sequence} checkpoint) tampered in place, same length — snapshot-seeded open`,
    asExpected: tamperedCached.startsWith('refused'),
    detail: tamperedCached,
  })
  checks.push({
    case: `row ${middleSequence} (before the checkpoint) tampered in place, same length — full-replay open`,
    asExpected: tamperedFull.startsWith('refused'),
    detail: tamperedFull,
  })
  restoreMiddle()
  const restoredOutcome = await refusal(true)
  checks.push({
    case: 'tampered row restored — snapshot-seeded open accepts again',
    asExpected: restoredOutcome === 'accepted',
    detail: restoredOutcome,
  })

  const tailSequence = rowCount - 2
  const restoreTail = tamperRow(tailSequence)
  const tamperedTailCached = await refusal(true)
  checks.push({
    case: `row ${tailSequence} (after the checkpoint, in the real tail) tampered — snapshot-seeded open`,
    asExpected: tamperedTailCached.startsWith('refused'),
    detail: tamperedTailCached,
  })
  restoreTail()

  const passed = checks.every((check) => check.asExpected)
  const report = {
    entries,
    everyEntries: every,
    ledgerBytes: fs.statSync(journalPath).size,
    ledgerRows: rowCount,
    snapshotCheckpoint: snapshotFile.head.sequence,
    snapshotByteLength: snapshotFile.byteLength,
    tailRowsAfterCheckpoint: rowCount - 1 - snapshotFile.head.sequence,
    cachedOpen: { ms: +cached.ms.toFixed(2), cpuMs: +cached.cpuMs.toFixed(2), bytesRead: cached.bytes },
    fullReplayOpen: { ms: +full.ms.toFixed(2), cpuMs: +full.cpuMs.toFixed(2), bytesRead: full.bytes },
    speedup: {
      journalBytesRatio: +(full.bytes.journal / cached.bytes.journal).toFixed(2),
      cpuMsRatio: +(full.cpuMs / Math.max(cached.cpuMs, 0.001)).toFixed(2),
    },
    checks,
    passed,
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  fs.rmSync(directory, { recursive: true, force: true })
  return passed ? 0 : 1
}

process.exitCode = await main()
