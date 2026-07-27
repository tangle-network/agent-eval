import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileLedgerJournal, type LedgerEntryOf, type LedgerJournalCodec } from './journal'

interface TickEvent {
  eventId: string
  value: number
}

interface TickHeader {
  journal: 'tick'
}

class TickIntegrityError extends Error {
  override readonly name = 'TickIntegrityError'
}

type TickEntry = LedgerEntryOf<TickHeader, TickEvent>

function tickCodec(): LedgerJournalCodec<TickHeader, TickEvent, TickEvent[]> {
  return {
    subject: 'tick journal',
    integrityError: (message, options) => new TickIntegrityError(message, options),
    header: { journal: 'tick' },
    conflictError: (message) => new Error(message),
    parseEntry: (raw, context) => {
      const entry = raw as TickEntry
      if (typeof entry?.event?.eventId !== 'string') {
        throw new TickIntegrityError(`malformed entry at ${context.path}:${context.line}`)
      }
      return entry
    },
    checkEntryHeader: (entry, index) => {
      if (entry.journal !== 'tick') {
        throw new TickIntegrityError(`entry ${index} belongs to another journal`)
      }
    },
    createProjector: () => {
      const events: TickEvent[] = []
      return { apply: (entry) => events.push(entry.event), finish: () => events }
    },
  }
}

const directories: string[] = []

function journalPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-head-'))
  directories.push(directory)
  return join(directory, 'journal.jsonl')
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function open(path: string, options: { requireTrustedHead?: boolean } = {}) {
  return new FileLedgerJournal(path, tickCodec(), options)
}

async function seed(
  path: string,
  count: number,
  options: { pinHead?: boolean } = {},
): Promise<void> {
  const journal = open(path)
  for (let index = 0; index < count; index += 1) {
    await journal.append({ eventId: `evt-${index}`, value: index }, options)
  }
}

function rows(path: string): string[] {
  return readFileSync(path, 'utf8').trimEnd().split('\n')
}

describe('deletion detection', () => {
  it('refuses a pinned journal truncated to a valid shorter prefix', async () => {
    const path = journalPath()
    await seed(path, 5, { pinHead: true })
    const lines = rows(path)
    expect(lines).toHaveLength(5)

    // The survivors are an internally perfect 3-entry chain: only the pin can
    // tell that two entries were removed.
    writeFileSync(path, `${lines.slice(0, 3).join('\n')}\n`)

    await expect(open(path).replay()).rejects.toThrow(TickIntegrityError)
    await expect(open(path).replay()).rejects.toThrow(
      /pins sequence 4 .* but the journal has 3 entries/,
    )
  })

  it('never extends a journal whose pinned history is missing', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    writeFileSync(path, `${rows(path).slice(0, 1).join('\n')}\n`)

    await expect(open(path).append({ eventId: 'evt-9', value: 9 })).rejects.toThrow(
      TickIntegrityError,
    )
    expect(rows(path)).toHaveLength(1)
  })

  it('refuses a journal rewritten from sequence 0 with recomputed hashes', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })

    const forgedPath = journalPath()
    const forged = open(forgedPath)
    await forged.append({ eventId: 'evt-0', value: 0 })
    await forged.append({ eventId: 'evt-1', value: 999 })
    await forged.append({ eventId: 'evt-2', value: 2 })
    await expect(forged.replay()).resolves.toMatchObject({ entries: expect.any(Array) })
    writeFileSync(path, readFileSync(forgedPath))

    await expect(open(path).replay()).rejects.toThrow(/the journal was rewritten/)
  })

  it('still refuses a byte tampered inside a retained entry', async () => {
    const path = journalPath()
    await seed(path, 5, { pinHead: true })
    const lines = rows(path)
    lines[1] = lines[1]!.replace('"value":1', '"value":9')
    writeFileSync(path, `${lines.join('\n')}\n`)

    await expect(open(path).replay()).rejects.toThrow(TickIntegrityError)
  })
})

describe('backward compatibility', () => {
  it('opens an unpinned journal and detects nothing about its length', async () => {
    const path = journalPath()
    await seed(path, 5)
    expect(() => readFileSync(`${path}.head`)).toThrow()

    const before = await open(path).replay()
    expect(before.entries).toHaveLength(5)

    writeFileSync(path, `${rows(path).slice(0, 3).join('\n')}\n`)
    const after = await open(path).replay()
    expect(after.entries).toHaveLength(3)
    await expect(open(path).trustedHead()).resolves.toBeNull()
  })

  it('adopts a pin for an existing unpinned journal without rewriting it', async () => {
    const path = journalPath()
    await seed(path, 3)
    const bytesBefore = readFileSync(path)

    const head = await open(path).pinTrustedHead()
    expect(head.sequence).toBe(2)
    expect(readFileSync(path)).toEqual(bytesBefore)
    await expect(open(path).trustedHead()).resolves.toEqual(head)

    writeFileSync(path, `${rows(path).slice(0, 2).join('\n')}\n`)
    await expect(open(path).replay()).rejects.toThrow(TickIntegrityError)
  })

  it('refuses to pin an empty journal', async () => {
    await expect(open(journalPath()).pinTrustedHead()).rejects.toThrow(/there is no head to pin/)
  })
})

describe('a missing pin', () => {
  it('reads as unpinned by default', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    unlinkSync(`${path}.head`)

    await expect(open(path).trustedHead()).resolves.toBeNull()
    await expect(open(path).replay()).resolves.toMatchObject({ entries: expect.any(Array) })
  })

  it('is refused under requireTrustedHead', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    await expect(open(path, { requireTrustedHead: true }).replay()).resolves.toMatchObject({
      entries: expect.any(Array),
    })

    unlinkSync(`${path}.head`)
    await expect(open(path, { requireTrustedHead: true }).replay()).rejects.toThrow(
      /has 3 entries but no trusted head/,
    )
  })

  it('does not block the first append to an empty journal under requireTrustedHead', async () => {
    const path = journalPath()
    const journal = open(path, { requireTrustedHead: true })
    await journal.append({ eventId: 'evt-0', value: 0 }, { pinHead: true })
    await expect(journal.replay()).resolves.toMatchObject({ entries: expect.any(Array) })
  })

  it('can be re-pinned under requireTrustedHead without a chicken-and-egg deadlock', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    unlinkSync(`${path}.head`)

    const strict = open(path, { requireTrustedHead: true })
    await expect(strict.replay()).rejects.toThrow(/no trusted head/)
    await expect(strict.pinTrustedHead()).resolves.toMatchObject({ sequence: 2 })
    await expect(strict.replay()).resolves.toMatchObject({ entries: expect.any(Array) })
  })
})

describe('the pin file', () => {
  it('is a sibling of the journal, holding the sequence and hash of the last append', async () => {
    const path = journalPath()
    await seed(path, 2, { pinHead: true })
    const entries = (await open(path).replay()).entries

    expect(JSON.parse(readFileSync(`${path}.head`, 'utf8'))).toEqual({
      sequence: 1,
      entryHash: entries[1]!.entryHash,
    })
    expect(open(path).trustedHeadPath).toBe(`${path}.head`)
  })

  it('fails loudly when it exists but is not a valid trusted head', async () => {
    const path = journalPath()
    await seed(path, 2, { pinHead: true })

    writeFileSync(`${path}.head`, '{"sequence":1}\n')
    await expect(open(path).replay()).rejects.toThrow(/expected \[entryHash, sequence\]/)

    writeFileSync(`${path}.head`, 'not json\n')
    await expect(open(path).replay()).rejects.toThrow(/is not valid JSON/)
  })

  it('refuses a journal emptied out from under its pin', async () => {
    const path = journalPath()
    await seed(path, 2, { pinHead: true })
    writeFileSync(path, '')
    await expect(open(path).replay()).rejects.toThrow(
      /pins sequence 1 .* but the journal has 0 entries/,
    )
  })
})

describe('pin movement', () => {
  it('lags one entry after a crash between the two writes, and the next pinning append heals it', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    const journal = open(path)

    // A crash between the journal write and the pin write is exactly an
    // unpinned append: the chain grew past the anchor.
    await journal.append({ eventId: 'evt-3', value: 3 })
    await expect(journal.trustedHead()).resolves.toMatchObject({ sequence: 2 })
    const grown = await journal.replay()
    expect(grown.entries).toHaveLength(4)

    const healed = await journal.append({ eventId: 'evt-4', value: 4 }, { pinHead: true })
    await expect(journal.trustedHead()).resolves.toEqual({
      sequence: 4,
      entryHash: healed.entry.entryHash,
    })
  })

  it('does not move on the idempotent re-append of an older event', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    const journal = open(path)
    const before = await journal.trustedHead()

    const again = await journal.append({ eventId: 'evt-0', value: 0 }, { pinHead: true })
    expect(again.appended).toBe(false)
    await expect(journal.trustedHead()).resolves.toEqual(before)
  })

  it('refuses to pin over a journal whose existing pin already disagrees', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    writeFileSync(path, `${rows(path).slice(0, 2).join('\n')}\n`)

    await expect(open(path).pinTrustedHead()).rejects.toThrow(TickIntegrityError)
  })
})
