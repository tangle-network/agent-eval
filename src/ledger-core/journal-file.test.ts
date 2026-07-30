import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendLedgerLine, type LedgerFileContext } from './journal-file'

const context: LedgerFileContext = {
  subject: 'test journal',
  integrityError(message, options) {
    return new Error(message, options)
  },
}

describe('appendLedgerLine', () => {
  it('replaces only a torn final row before appending the next durable row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-journal-tail-'))
    const path = join(directory, 'events.jsonl')
    const initial = '{"sequence":0}\n{"secret":"partial'
    const next = '{"sequence":1}\n'
    writeFileSync(path, initial, 'utf8')
    const initialBytes = statSync(path).size

    try {
      appendLedgerLine(path, next, context)

      const repaired = readFileSync(path, 'utf8')
      expect(Buffer.byteLength(repaired)).toBe(initialBytes + Buffer.byteLength(next))
      expect(repaired.split('\n')).toEqual([
        '{"sequence":0}',
        ' '.repeat(Buffer.byteLength('{"secret":"partial') - 1),
        '{"sequence":1}',
        '',
      ])
      expect(repaired).not.toContain('partial')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
