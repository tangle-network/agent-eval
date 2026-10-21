import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { type CodeAgentJsonlLine, parseCodeAgentJsonl, parseCodeAgentJsonlFile, streamCodeAgentJsonlFile } from '../src/contract'

describe('streaming code-agent JSONL intake', () => {
  const dir = mkdtempSync(join(tmpdir(), 'code-agent-jsonl-'))
  const write = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('matches the string path on a real committed session fixture', async () => {
    const url = new URL('./fixtures/codex-exec-0.144.1.jsonl', import.meta.url)
    const fromString = parseCodeAgentJsonl(readFileSync(url, 'utf8'))
    const fromFile = await parseCodeAgentJsonlFile(fileURLToPath(url))

    expect(fromFile.entries).toHaveLength(15)
    expect(fromFile).toEqual(fromString)
  })

  it('counts malformed lines exactly as the string path does', async () => {
    const body = '{"type":"ok"}\nnot-json\n\n   \n{"type":"also-ok"}\n{"unterminated":\n'
    const path = write('malformed.jsonl', body)

    const fromFile = await parseCodeAgentJsonlFile(path)

    expect(fromFile.malformedLines).toBe(2)
    expect(fromFile).toEqual(parseCodeAgentJsonl(body))
  })

  it.each([
    ['no trailing newline', '{"a":1}\n{"b":2}'],
    ['CRLF line breaks', '{"a":1}\r\n{"b":2}\r\n'],
    ['blank and whitespace-only lines', '\n{"a":1}\n \t \n{"b":2}\n\n'],
    ['empty file', ''],
    ['only malformed content', 'nope\nalso nope\n'],
  ])('agrees with the string path on %s', async (name, body) => {
    const path = write(`${name.replace(/\s+/g, '-')}.jsonl`, body)

    expect(await parseCodeAgentJsonlFile(path)).toEqual(parseCodeAgentJsonl(body))
  })

  it('keeps a bare carriage return inside its line, as split by newline does', async () => {
    // `node:readline` breaks on a lone `\r`, which would report two malformed
    // lines here instead of one and silently diverge from the string path.
    const body = '{"a":1}\nbroken\rline\n{"b":2}\n'
    const path = write('bare-cr.jsonl', body)

    const fromFile = await parseCodeAgentJsonlFile(path)

    expect(fromFile.malformedLines).toBe(1)
    expect(fromFile).toEqual(parseCodeAgentJsonl(body))
  })

  it('reassembles entries that span read-stream chunk boundaries', async () => {
    // Each line is far larger than the 64KB default chunk, so a splitter that
    // does not retain the unterminated tail loses or corrupts every entry.
    const long = Array.from({ length: 8 }, (_, i) =>
      JSON.stringify({ index: i, filler: 'x'.repeat(200_000) }),
    ).join('\n')
    const path = write('chunked.jsonl', `${long}\n`)

    const fromFile = await parseCodeAgentJsonlFile(path)

    expect(fromFile.entries).toHaveLength(8)
    expect(fromFile.entries.map((e) => (e as { index: number }).index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ])
    expect(fromFile).toEqual(parseCodeAgentJsonl(long))
  })

  it('reports line numbers and stops reading when the consumer stops', async () => {
    const path = write('numbered.jsonl', '\n{"a":1}\nnot-json\n{"b":2}\n')

    const seen: CodeAgentJsonlLine[] = []
    for await (const line of streamCodeAgentJsonlFile(path)) {
      seen.push(line)
      if (seen.length === 2) break
    }

    expect(seen).toEqual([
      { kind: 'entry', lineNumber: 2, entry: { a: 1 } },
      { kind: 'malformed', lineNumber: 3 },
    ])
  })
})
