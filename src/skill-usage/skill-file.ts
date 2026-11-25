/**
 * A skill's version is the hash of the body an agent is given. A session
 * record and the skill file both yield that body, so one invocation's version
 * can be compared with the file as it is now.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { errorMessage } from '../errors'

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

/** The body an agent is given: the file without its frontmatter block, trimmed. */
function skillBody(text: string): string {
  return text.replace(FRONTMATTER, '').trim()
}

/** sha256 of {@link skillBody}, as lowercase hex. */
export function skillBodySha256(text: string): string {
  return createHash('sha256').update(skillBody(text)).digest('hex')
}

/** A skill file read when the report ran, or why it could not be read. */
export type SkillFileRead =
  | {
      succeeded: true
      path: string
      /** sha256 of the file's bytes, the key a ledger of skill files uses. */
      fileSha256: string
      /** sha256 of the body, comparable with an invocation's version. */
      bodySha256: string
    }
  | { succeeded: false; path: string; error: string }

/** Read one skill file. A missing or unreadable file is a typed failure, never an empty body. */
export function readSkillFile(path: string): SkillFileRead {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return { succeeded: false, path, error: typeof code === 'string' ? code : errorMessage(error) }
  }
  return {
    succeeded: true,
    path,
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    bodySha256: skillBodySha256(bytes.toString('utf8')),
  }
}
