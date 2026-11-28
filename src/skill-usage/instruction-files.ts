/**
 * The instruction files a harness loaded into a session, read from the same
 * parsed lines as the rest of the record.
 *
 * | Harness | Record |
 * |---|---|
 * | Claude Code | an `attachment` of type `instructions` lists the files it loaded (`path`, `type`, `content`), at session start and again when one changes; an attachment of type `nested_memory` is one file it loaded when the agent read below that file's directory |
 * | Codex | a user message that opens `# AGENTS.md instructions for <directory>` holds the AGENTS.md text Codex loaded for that directory, inside `<INSTRUCTIONS>` tags; Codex joins the files it found into one text, so the record names the directory and no file |
 *
 * One file at one text is one entry, however often the session recorded it.
 */

import { createHash } from 'node:crypto'
import { record, stringField } from '../contract/intake/code-agent-fields'
import type { SessionInstructionFile } from './session-record'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function entry(
  path: string | null,
  directory: string | null,
  scope: string | null,
  text: string,
  at: string | null,
): SessionInstructionFile {
  return { path, directory, scope, sha256: sha256(text), text, at }
}

/** Keep the first entry for each file (or directory) and text. */
function distinct(files: readonly SessionInstructionFile[]): SessionInstructionFile[] {
  const seen = new Set<string>()
  return files.filter((file) => {
    const key = `${file.path ?? ''}\u0000${file.directory ?? ''}\u0000${file.sha256}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function claudeCodeFile(value: unknown, at: string | null): SessionInstructionFile | null {
  const file = record(value)
  const path = file === null ? undefined : stringField(file, 'path')
  const content = file?.content
  if (file === null || path === undefined || path === '' || typeof content !== 'string') return null
  return entry(path, null, stringField(file, 'type') ?? null, content, at)
}

/**
 * Instruction files in a Claude Code transcript. In a top-level transcript,
 * sidechain records belong to subagents and are skipped; `subagent` is true
 * for a subagent's own transcript.
 */
export function claudeCodeInstructionFiles(
  records: readonly unknown[],
  subagent: boolean,
): SessionInstructionFile[] {
  const files: SessionInstructionFile[] = []
  for (const value of records) {
    const line = record(value)
    if (line === null || line.type !== 'attachment') continue
    if (!subagent && line.isSidechain === true) continue
    const attachment = record(line.attachment)
    const at = stringField(line, 'timestamp') ?? null
    if (attachment?.type === 'instructions' && Array.isArray(attachment.files)) {
      for (const file of attachment.files) {
        const read = claudeCodeFile(file, at)
        if (read !== null) files.push(read)
      }
    } else if (attachment?.type === 'nested_memory') {
      const read = claudeCodeFile(attachment.content, at)
      if (read !== null) files.push(read)
    }
  }
  return distinct(files)
}

const CODEX_INSTRUCTIONS =
  /^# AGENTS\.md instructions for ([^\n]+)\n+<INSTRUCTIONS>\n?([\s\S]*?)\n?<\/INSTRUCTIONS>\s*$/

/** The AGENTS.md text a Codex rollout loaded, one entry per directory and text. */
export function codexInstructionFiles(records: readonly unknown[]): SessionInstructionFile[] {
  const files: SessionInstructionFile[] = []
  for (const value of records) {
    const line = record(value)
    const payload = record(line?.payload)
    if (line?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user')
      continue
    for (const block of Array.isArray(payload.content) ? payload.content : []) {
      const part = record(block)
      if (part?.type !== 'input_text' || typeof part.text !== 'string') continue
      const match = CODEX_INSTRUCTIONS.exec(part.text)
      if (match === null) continue
      files.push(
        entry(
          null,
          (match[1] as string).trim(),
          'AGENTS.md',
          match[2] as string,
          stringField(line, 'timestamp') ?? null,
        ),
      )
    }
  }
  return distinct(files)
}
