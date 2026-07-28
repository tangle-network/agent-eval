import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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

/** Block the fixed temporary path `writeLedgerFileAtomically` uses, so the pin
 * write fails the way a full disk, a read-only mount, or a permission fault
 * fails it: after the journal row is already fsynced. */
function blockPinWrite(path: string): () => void {
  mkdirSync(`${path}.head.tmp`)
  return () => rmSync(`${path}.head.tmp`, { recursive: true, force: true })
}

describe('a pin write that fails after the row is durable', () => {
  it('is healed by the retry of the same event, which re-pins the acknowledged entry', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    const journal = open(path)

    const unblock = blockPinWrite(path)
    await expect(journal.append({ eventId: 'evt-3', value: 3 }, { pinHead: true })).rejects.toThrow(
      TickIntegrityError,
    )
    unblock()
    // The row is durable and acknowledged to nobody: the caller saw an error.
    expect(rows(path)).toHaveLength(4)
    await expect(journal.trustedHead()).resolves.toMatchObject({ sequence: 2 })

    // Retrying the same eventId is what idempotency is for. It must not leave
    // the last entry unpinned.
    const retry = await journal.append({ eventId: 'evt-3', value: 3 }, { pinHead: true })
    expect(retry.appended).toBe(false)
    await expect(journal.trustedHead()).resolves.toEqual({
      sequence: 3,
      entryHash: retry.entry.entryHash,
    })

    writeFileSync(path, `${rows(path).slice(0, 3).join('\n')}\n`)
    await expect(open(path).replay()).rejects.toThrow(
      /pins sequence 3 .* but the journal has 3 entries/,
    )
  })

  it('is healed by the retry of the first event, which had no pin to lag behind', async () => {
    const path = journalPath()
    const journal = open(path)

    const unblock = blockPinWrite(path)
    await expect(journal.append({ eventId: 'evt-0', value: 0 }, { pinHead: true })).rejects.toThrow(
      TickIntegrityError,
    )
    unblock()
    await expect(journal.trustedHead()).resolves.toBeNull()

    const retry = await journal.append({ eventId: 'evt-0', value: 0 }, { pinHead: true })
    expect(retry.appended).toBe(false)
    await expect(journal.trustedHead()).resolves.toEqual({
      sequence: 0,
      entryHash: retry.entry.entryHash,
    })
  })

  it('requires explicit recovery when the first pin write fails in strict mode', async () => {
    const path = journalPath()
    const journal = open(path, { requireTrustedHead: true })

    const unblock = blockPinWrite(path)
    await expect(journal.append({ eventId: 'evt-0', value: 0 }, { pinHead: true })).rejects.toThrow(
      TickIntegrityError,
    )
    unblock()

    await expect(journal.append({ eventId: 'evt-0', value: 0 }, { pinHead: true })).rejects.toThrow(
      /no trusted head/,
    )
    await expect(journal.pinTrustedHead()).resolves.toMatchObject({ sequence: 0 })
    await expect(
      journal.append({ eventId: 'evt-0', value: 0 }, { pinHead: true }),
    ).resolves.toMatchObject({ appended: false })
  })

  it('reports the write fault in the codec taxonomy, not as a raw fs error', async () => {
    const path = journalPath()
    await seed(path, 1, { pinHead: true })
    const unblock = blockPinWrite(path)
    await expect(
      open(path).append({ eventId: 'evt-1', value: 1 }, { pinHead: true }),
    ).rejects.toThrow(/trusted head .* could not be written/)
    unblock()
  })

  it('reports an unreadable pin in the codec taxonomy, not as a raw fs error', async () => {
    const path = journalPath()
    await seed(path, 1, { pinHead: true })
    rmSync(`${path}.head`)
    mkdirSync(`${path}.head`)

    await expect(open(path).replay()).rejects.toThrow(TickIntegrityError)
    await expect(open(path).replay()).rejects.toThrow(/trusted head .* could not be read/)
  })

  it('leaves the pin alone when the caller did not ask to pin', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    const journal = open(path)
    await journal.append({ eventId: 'evt-3', value: 3 })

    const retry = await journal.append({ eventId: 'evt-3', value: 3 })
    expect(retry.appended).toBe(false)
    await expect(journal.trustedHead()).resolves.toMatchObject({ sequence: 2 })
  })
})

describe('a pin left behind by a deleted journal', () => {
  it('refuses every read, naming the sidecar and the way out', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    unlinkSync(path)
    const journal = open(path)

    for (const read of [() => journal.replay(), () => journal.append({ eventId: 'a', value: 0 })]) {
      await expect(read()).rejects.toThrow(TickIntegrityError)
      await expect(read()).rejects.toThrow(new RegExp(`trusted head ${path}\\.head`))
      await expect(read()).rejects.toThrow(/clearTrustedHead/)
    }
  })

  it('is recovered by clearing the pin, which reports what it discarded', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    const pinned = await open(path).trustedHead()
    unlinkSync(path)

    const journal = open(path)
    await expect(journal.clearTrustedHead()).resolves.toEqual({ removed: true, head: pinned })
    expect(existsSync(`${path}.head`)).toBe(false)

    await journal.append({ eventId: 'fresh-0', value: 0 }, { pinHead: true })
    await expect(journal.replay()).resolves.toMatchObject({ entries: expect.any(Array) })
    await expect(journal.trustedHead()).resolves.toMatchObject({ sequence: 0 })
  })

  it('reports that nothing was removed when there was no pin', async () => {
    const path = journalPath()
    await seed(path, 2)
    await expect(open(path).clearTrustedHead()).resolves.toEqual({ removed: false })
    await expect(open(path).replay()).resolves.toMatchObject({ entries: expect.any(Array) })
  })

  it('clears a pin file that no longer parses, and says why it could not name it', async () => {
    const path = journalPath()
    await seed(path, 2, { pinHead: true })
    writeFileSync(`${path}.head`, 'not json\n')
    await expect(open(path).replay()).rejects.toThrow(/is not valid JSON/)

    await expect(open(path).clearTrustedHead()).resolves.toEqual({
      removed: true,
      head: null,
      unreadable: expect.stringMatching(/is not valid JSON/),
    })
    await expect(open(path).replay()).resolves.toMatchObject({ entries: expect.any(Array) })
  })

  it('clears a pin path occupied by something that is not a pin at all', async () => {
    const path = journalPath()
    await seed(path, 2, { pinHead: true })
    rmSync(`${path}.head`)
    mkdirSync(`${path}.head`)
    await expect(open(path).replay()).rejects.toThrow(/could not be read/)

    await expect(open(path).clearTrustedHead()).resolves.toEqual({
      removed: true,
      head: null,
      unreadable: expect.stringMatching(/could not be read/),
    })
    await expect(open(path).replay()).resolves.toMatchObject({ entries: expect.any(Array) })
  })

  it('removes the atomic writer temporary sibling along with the pin', async () => {
    const path = journalPath()
    await seed(path, 2, { pinHead: true })
    writeFileSync(`${path}.head.tmp`, 'stale\n')

    await expect(open(path).clearTrustedHead()).resolves.toMatchObject({ removed: true })
    expect(existsSync(`${path}.head.tmp`)).toBe(false)
  })
})

describe('an unpinned journal is not given a misleading pin', () => {
  it('refuses to pin a middle entry when there is no pin to repair', async () => {
    const path = journalPath()
    await seed(path, 20)
    const journal = open(path)

    // The pin file was deleted, or the journal predates pinning. Pinning the
    // retried entry here would read as protection while 19 entries stayed
    // truncatable.
    const retry = await journal.append({ eventId: 'evt-0', value: 0 }, { pinHead: true })
    expect(retry.appended).toBe(false)
    await expect(journal.trustedHead()).resolves.toBeNull()

    await expect(journal.pinTrustedHead()).resolves.toMatchObject({ sequence: 19 })
  })

  it('still repairs the head entry of an unpinned journal', async () => {
    const path = journalPath()
    await seed(path, 3)
    const journal = open(path)

    const retry = await journal.append({ eventId: 'evt-2', value: 2 }, { pinHead: true })
    expect(retry.appended).toBe(false)
    await expect(journal.trustedHead()).resolves.toEqual({
      sequence: 2,
      entryHash: retry.entry.entryHash,
    })
  })

  it('keeps the pin monotone when concurrent retries of the same event race', async () => {
    const path = journalPath()
    await seed(path, 3, { pinHead: true })
    const journal = open(path)
    const unblock = blockPinWrite(path)
    await expect(journal.append({ eventId: 'evt-3', value: 3 }, { pinHead: true })).rejects.toThrow(
      TickIntegrityError,
    )
    unblock()

    const retries = await Promise.all(
      Array.from({ length: 8 }, () =>
        journal.append({ eventId: 'evt-3', value: 3 }, { pinHead: true }),
      ),
    )
    expect(retries.every((result) => result.appended === false)).toBe(true)
    await expect(journal.trustedHead()).resolves.toEqual({
      sequence: 3,
      entryHash: retries[0]!.entry.entryHash,
    })
    expect(rows(path)).toHaveLength(4)
  })
})
