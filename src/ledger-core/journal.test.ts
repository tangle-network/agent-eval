import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileLedgerJournal, type LedgerJournalCodec } from './journal'

interface MetricEvent {
  eventId: string
  metrics: Record<string, number>
}

interface MetricHeader {
  journal: 'metric'
}

class MetricIntegrityError extends Error {
  override readonly name = 'MetricIntegrityError'
}

function metricCodec(): LedgerJournalCodec<MetricHeader, MetricEvent, MetricEvent[]> {
  return {
    subject: 'metric journal',
    integrityError: (message, options) => new MetricIntegrityError(message, options),
    header: { journal: 'metric' },
    conflictError: (message) => new Error(message),
    parseEntry: (raw) => raw as never,
    checkEntryHeader: () => {},
    createProjector: () => {
      const events: MetricEvent[] = []
      return { apply: (entry) => events.push(entry.event), finish: () => events }
    },
  }
}

/** Row bytes as a sorted-key `JSON.stringify` encoder produces them. Object
 * property enumeration puts array-index-like keys first in numeric order, so
 * the sort does not survive the round trip through a plain object. */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}

function sortedStringifyRow(event: MetricEvent): string {
  const material = { journal: 'metric', sequence: 0, previousHash: null, event }
  const encode = (value: unknown) => JSON.stringify(sortKeysDeep(value))
  const entryHash = `sha256:${createHash('sha256').update(encode(material)).digest('hex')}`
  return `${encode({ ...material, entryHash })}\n`
}

const directories: string[] = []

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function journalPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-canon-'))
  directories.push(directory)
  return join(directory, 'journal.jsonl')
}

describe('durable rows must be canonical bytes', () => {
  it('refuses a row whose keys are ordered by property enumeration, not by sort', () => {
    const row = sortedStringifyRow({ eventId: 'evt-0', metrics: { '10': 1, '2': 2 } })
    expect(row).toContain('"metrics":{"2":2,"10":1}')

    const path = journalPath()
    writeFileSync(path, row)
    return expect(new FileLedgerJournal(path, metricCodec()).replay()).rejects.toThrow(
      /non-canonical bytes at line 1/,
    )
  })

  it('accepts a row whose keys carry no array-index-like names', async () => {
    const row = sortedStringifyRow({ eventId: 'evt-0', metrics: { score: 1, accuracy: 2 } })
    const path = journalPath()
    writeFileSync(path, row)

    const replayed = await new FileLedgerJournal(path, metricCodec()).replay()
    expect(replayed.entries).toHaveLength(1)
    expect(replayed.entries[0]!.event.metrics).toEqual({ score: 1, accuracy: 2 })
  })
})
