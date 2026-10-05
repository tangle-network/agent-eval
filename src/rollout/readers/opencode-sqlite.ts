/**
 * OpenCode's SQLite store (~/.local/share/opencode/opencode.db) as canonical chat-with-tools
 * messages, through @tangle-network/harness-sessions: the one reader of harness sessions shared
 * with Discovery, agent-record, traces and the blog. The store is read from a private copy, never
 * in place, and a tool part that errored or never finished is read as what it is rather than
 * refused.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type HarnessSession,
  opencodeReader,
  opencodeSessionsInStore,
  type SessionRef,
  toChatMessages,
} from '@tangle-network/harness-sessions'
import type { ChatMessage } from '../schema'

export const DEFAULT_OPENCODE_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')

/** Sessions whose cwd is `directory` (the worker-clone join key), oldest first. */
export async function findOpencodeSessionsByDirectory(
  directory: string,
  db: string = DEFAULT_OPENCODE_DB,
): Promise<SessionRef[]> {
  const refs = await opencodeSessionsInStore(db, null, { cwd: directory })
  return refs.filter((ref) => ref.cwd === directory).reverse()
}

/** One session, normalized. */
export async function readOpencodeSession(
  sessionId: string,
  db: string = DEFAULT_OPENCODE_DB,
): Promise<HarnessSession> {
  const [ref] = await opencodeSessionsInStore(db, null, { nativeSessionId: sessionId })
  if (ref === undefined) throw new Error(`OpenCode session ${sessionId} is not in ${db}`)
  return opencodeReader.read(ref)
}

/** One session's canonical messages: each model step, then the results of its tool calls. */
export async function readOpencodeSessionMessages(
  sessionId: string,
  db: string = DEFAULT_OPENCODE_DB,
): Promise<ChatMessage[]> {
  return toChatMessages(await readOpencodeSession(sessionId, db))
}
