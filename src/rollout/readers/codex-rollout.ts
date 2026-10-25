/**
 * Codex rollout JSONL through the shared native-session reader. This module
 * projects its result onto rollout messages; it never parses native records,
 * discovers stores, judges an outcome, or makes an imported capture trainable.
 */
import {
  codexReader,
  codexRefForFile,
  type HarnessSession,
  type ReadOptions,
  readSessionInput,
  type SessionInputInit,
  toChatMessages,
} from '@tangle-network/harness-sessions'
import type { ChatMessage } from '../schema'

/** Normalized source evidence, with the existing canonical message projection. */
export type CodexRollout = Pick<
  HarnessSession,
  | 'nativeSessionId'
  | 'parentNativeSessionId'
  | 'startedAt'
  | 'endedAt'
  | 'usage'
  | 'ending'
  | 'integrity'
  | 'modelSource'
> & {
  messages: ChatMessage[]
  /** Null when only turn_context names a model; that is configuration, not a response. */
  model: string | null
  requestedModel: string | null
}

function rolloutFromSession(session: HarnessSession): CodexRollout {
  const answered = session.modelCalls.filter((call) => call.error === null)
  const trustedModel =
    session.modelSource === 'provider-response' || session.modelSource === 'session-record'
  return {
    nativeSessionId: session.nativeSessionId,
    parentNativeSessionId: session.parentNativeSessionId,
    messages: toChatMessages(session),
    usage: session.usage,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    model: trustedModel
      ? ([...answered].reverse().find((call) => call.servedModel !== null)?.servedModel ?? null)
      : null,
    requestedModel:
      [...session.modelCalls].reverse().find((call) => call.requestedModel !== null)
        ?.requestedModel ?? null,
    modelSource: session.modelSource,
    ending: session.ending,
    integrity: session.integrity,
  }
}

/** Read one already-resolved native file; strict/recover behavior belongs to the SDK. */
export async function readCodexRollout(
  path: string,
  options: ReadOptions = {},
): Promise<CodexRollout> {
  return rolloutFromSession(await codexReader.read(codexRefForFile(path), options))
}

/** Parse retained text through the same SDK fold, retaining source hashes and gaps. */
export function parseCodexRollout(
  raw: string,
  source: SessionInputInit = {},
  options: Pick<ReadOptions, 'corruption'> = {},
): CodexRollout {
  return rolloutFromSession(readSessionInput('codex', { text: raw }, source, options))
}
