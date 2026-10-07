/**
 * Claude Code project transcripts (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl) as canonical
 * chat-with-tools messages plus per-session token usage.
 *
 * The transcript is read by @tangle-network/harness-sessions, the one reader of harness sessions
 * shared with Discovery, agent-record, traces and the blog: one model call per API response
 * (`message.id`, its usage counted once), the served model from the response, tool calls with
 * their results. This module only projects that session. Sidechain lines (subagent threads in the
 * main file) are separate invocations and are excluded unless `includeSidechain` asks for a
 * subagent's own transcript.
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  claudeCodeReader,
  claudeCodeRefForFile,
  type HarnessSession,
  readSessionInput,
  toChatMessages,
} from '@tangle-network/harness-sessions'
import type { ChatMessage } from '../schema'

export const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** Claude Code's project-directory slug for a working directory. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-')
}

export interface ClaudeTranscriptRef {
  sessionId: string
  path: string
}

/** Transcript files recorded for sessions launched from `cwd`. */
export async function findClaudeTranscripts(
  cwd: string,
  projectsDir: string = DEFAULT_CLAUDE_PROJECTS_DIR,
): Promise<ClaudeTranscriptRef[]> {
  const dir = join(projectsDir, claudeProjectSlug(cwd))
  const names = await readdir(dir).catch(() => [])
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .map((n) => ({ sessionId: n.replace(/\.jsonl$/, ''), path: join(dir, n) }))
}

export interface ClaudeUsageTotals {
  tokensIn: number | null
  tokensOut: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

export interface ClaudeTranscript {
  messages: ChatMessage[]
  usage: ClaudeUsageTotals
  /** Timestamp of the first conversation record; null = empty transcript. */
  startedAt: string | null
  endedAt: string | null
  /** The model that answered the last response (never Claude Code's `<synthetic>` error turn). */
  model: string | null
  /** Every parse or usage gap retained beside this semantic projection. */
  gaps: string[]
}

export interface ReadClaudeTranscriptOptions {
  /**
   * Read a subagent's own transcript (`<session>/subagents/agent-<id>.jsonl`), whose records are
   * sidechain end to end, instead of skipping sidechain records.
   */
  readonly includeSidechain?: boolean
}

const USAGE_FIELDS = [
  ['tokensIn', 'input'],
  ['tokensOut', 'output'],
  ['cacheRead', 'cacheRead'],
  ['cacheWrite', 'cacheWrite'],
] as const

/**
 * The messages+usage projection of a normalized session. A usage field is null when any answered
 * model call did not report it, so a partial sum is never mistaken for the session's usage.
 */
export function transcriptFromSession(session: HarnessSession): ClaudeTranscript {
  const gaps = session.integrity.gaps.filter((gap) =>
    /is not a JSON record|still being written/u.test(gap),
  )
  const answered = session.modelCalls.filter((call) => call.error === null)
  const usage: ClaudeUsageTotals = {
    tokensIn: null,
    tokensOut: null,
    cacheRead: null,
    cacheWrite: null,
  }
  if (answered.length > 0) {
    for (const [target, field] of USAGE_FIELDS) {
      let total: number | null = 0
      for (const call of answered) {
        const value = call.usage?.[field] ?? null
        if (value === null) {
          total = null
          gaps.push(`model call ${call.id}: ${field} usage unavailable`)
          break
        }
        total += value
      }
      usage[target] = total
    }
  }
  const model =
    [...answered].reverse().find((call) => call.servedModel !== null)?.servedModel ?? null
  return {
    messages: toChatMessages(session),
    usage,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    model,
    gaps,
  }
}

/** Read one transcript file. */
export async function readClaudeTranscript(
  path: string,
  options: ReadClaudeTranscriptOptions = {},
): Promise<ClaudeTranscript> {
  const session = await claudeCodeReader.read(
    claudeCodeRefForFile(path, options.includeSidechain === true ? 'parent' : null),
  )
  return transcriptFromSession(session)
}

/** Parse retained JSONL text without another file or store; source gaps remain explicit. */
export function parseClaudeTranscript(
  raw: string,
  options: ReadClaudeTranscriptOptions = {},
): ClaudeTranscript {
  const session = readSessionInput(
    'claude-code',
    { text: raw },
    {
      parentNativeSessionId: options.includeSidechain === true ? 'parent' : null,
      label: 'retained transcript',
    },
  )
  return transcriptFromSession(session)
}
