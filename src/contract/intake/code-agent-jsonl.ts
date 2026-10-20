import { createReadStream } from 'node:fs'
import type { CodeAgentJsonlLine, ParsedCodeAgentJsonl } from './code-agent-session-types'

/** The single per-line rule. Both the string path and the file path call this,
 *  so malformed-line handling and entry validation cannot drift apart. */
function readCodeAgentJsonlLine(line: string, lineNumber: number): CodeAgentJsonlLine | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    return { kind: 'entry', lineNumber, entry: JSON.parse(trimmed) }
  } catch {
    return { kind: 'malformed', lineNumber }
  }
}

export function parseCodeAgentJsonl(jsonl: string): ParsedCodeAgentJsonl {
  const entries: unknown[] = []
  let malformedLines = 0
  let lineNumber = 0
  for (const line of jsonl.split('\n')) {
    lineNumber += 1
    const read = readCodeAgentJsonlLine(line, lineNumber)
    if (!read) continue
    if (read.kind === 'malformed') malformedLines += 1
    else entries.push(read.entry)
  }
  return { entries, malformedLines }
}

/** Reads a transcript one line at a time and never holds the file as a single
 *  string. `parseCodeAgentJsonl` needs the whole file in one string, so a
 *  session above V8's ~512MB string ceiling throws `ERR_STRING_TOO_LONG` and
 *  cannot be ingested at all; the largest real Codex rollout on record is 695MB.
 *
 *  Lines break on `\n` only, which is what the string path's `split('\n')` does.
 *  `node:readline` also breaks on a bare `\r`, so it is deliberately not used
 *  here: a lone carriage return inside a line must stay inside that line for the
 *  two paths to report the same malformed count. */
export async function* streamCodeAgentJsonlFile(path: string): AsyncGenerator<CodeAgentJsonlLine> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  let pending = ''
  let lineNumber = 0
  try {
    for await (const chunk of stream) {
      pending += chunk
      let start = 0
      for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n', start)) {
        lineNumber += 1
        const read = readCodeAgentJsonlLine(pending.slice(start, at), lineNumber)
        if (read) yield read
        start = at + 1
      }
      // Only the unterminated tail is retained, so live memory is bounded by
      // the longest single line rather than by the file size.
      pending = pending.slice(start)
    }
  } finally {
    stream.destroy()
  }
  const last = readCodeAgentJsonlLine(pending, lineNumber + 1)
  if (last) yield last
}

/** Streaming counterpart to `parseCodeAgentJsonl` for a transcript on disk.
 *  It returns the same shape, so a caller that holds every entry keeps working
 *  above the string ceiling. The entry array still grows with the transcript;
 *  consume `streamCodeAgentJsonlFile` directly when memory must stay flat. */
export async function parseCodeAgentJsonlFile(path: string): Promise<ParsedCodeAgentJsonl> {
  const entries: unknown[] = []
  let malformedLines = 0
  for await (const read of streamCodeAgentJsonlFile(path)) {
    if (read.kind === 'malformed') malformedLines += 1
    else entries.push(read.entry)
  }
  return { entries, malformedLines }
}
