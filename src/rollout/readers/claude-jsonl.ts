/**
 * Backfill reader over Claude Code project transcripts
 * (~/.claude/projects/<cwd-slug>/<sessionId>.jsonl) → canonical
 * chat-with-tools messages plus per-session token usage.
 *
 * Transcript lines consumed: type:"user" (string content or content blocks —
 * text + tool_result) and type:"assistant" (content blocks — thinking, text,
 * tool_use; message.usage carries tokens). Sidechain lines (isSidechain=true,
 * subagent threads) are separate invocations and are excluded from the main
 * transcript. Everything else (queue-operation, attachment, last-prompt…) is
 * transport metadata, not conversation.
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ChatToolCall } from '../schema'

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
  /** Timestamp of the first conversation line; null = empty transcript. */
  startedAt: string | null
  endedAt: string | null
  model: string | null
  /** Every parse or usage gap retained beside this semantic projection. */
  gaps: string[]
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * One conversation line of a transcript, still in Claude Code's own shape.
 *
 * This is the single line-level parse of the format. `readClaudeTranscript`
 * projects it to canonical messages + usage; the supervision-tree reader
 * (`src/supervisor-run/claude-code-reader.ts`) projects the SAME entries to
 * spawn/settle/steer instants. Two projections, one parser — a second
 * transcript parser is how the two views silently disagree.
 */
export interface ClaudeEntry {
  readonly type: 'user' | 'assistant'
  /** ISO instant of the line; null when the line carried none. */
  readonly timestamp: string | null
  /** The Anthropic message body (`role`, `content`, `model`, `usage`). */
  readonly message: Record<string, unknown>
  /** Claude Code's structured tool result, when the line carries one. */
  readonly toolUseResult: unknown
  /** True on subagent threads — a separate invocation, not this transcript's turn. */
  readonly isSidechain: boolean
  /** Subagent id Claude Code stamps on sidechain lines; null on main-thread lines. */
  readonly agentId: string | null
}

/** Parse transcript jsonl text into conversation lines. Non-conversation lines are dropped. */
export function parseClaudeEntries(raw: string, onGap?: (gap: string) => void): ClaudeEntry[] {
  const out: ClaudeEntry[] = []
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue
    const gap = (reason: string): void => {
      const detail = `line ${index + 1}: ${reason}`
      if (onGap) onGap(detail)
      else throw new Error(`Claude transcript ${detail}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      gap('malformed JSON')
      continue
    }
    if (!isRecord(parsed)) {
      gap('JSON value is not an object')
      continue
    }
    const entry = parsed
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const message = entry.message
    if (!isRecord(message)) {
      gap('conversation message is missing')
      continue
    }
    out.push({
      type: entry.type,
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
      message,
      toolUseResult: entry.toolUseResult,
      isSidechain: entry.isSidechain === true,
      agentId: typeof entry.agentId === 'string' ? entry.agentId : null,
    })
  }
  return out
}

export interface ReadClaudeTranscriptOptions {
  /**
   * Read the sidechain (subagent) thread instead of skipping it. Subagent
   * transcripts under `<session>/subagents/agent-<id>.jsonl` are sidechain
   * lines end to end, so their usage is invisible without this.
   */
  readonly includeSidechain?: boolean
  /** Parser diagnostics from the retained source; used by the shared reader. */
  readonly sourceGaps?: readonly string[]
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is Record<string, unknown> =>
        isRecord(b) && b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text as string)
    .join('\n')
}

/** Read one transcript file through the same parser used for retained source text. */
export async function readClaudeTranscript(
  path: string,
  options: ReadClaudeTranscriptOptions = {},
): Promise<ClaudeTranscript> {
  return parseClaudeTranscript(await readFile(path, 'utf8'), options)
}

/** Parse retained JSONL without another file or store; source gaps remain explicit. */
export function parseClaudeTranscript(
  raw: string,
  options: ReadClaudeTranscriptOptions = {},
): ClaudeTranscript {
  const gaps: string[] = []
  const entries = parseClaudeEntries(raw, (gap) => gaps.push(gap))
  return transcriptFromEntries(entries, { ...options, sourceGaps: gaps })
}

/** The messages+usage projection of already-parsed entries. */
export function transcriptFromEntries(
  entries: readonly ClaudeEntry[],
  options: ReadClaudeTranscriptOptions = {},
): ClaudeTranscript {
  const wantSidechain = options.includeSidechain === true
  const messages: ChatMessage[] = []
  const usage: ClaudeUsageTotals = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 }
  const gaps = [...(options.sourceGaps ?? [])]
  let usageObserved = false
  let startedAt: string | null = null
  let endedAt: string | null = null
  let model: string | null = null
  // Claude Code writes one jsonl line PER CONTENT BLOCK of an API message,
  // repeating message.id and usage on each — merge blocks into one canonical
  // assistant turn and count usage once per API message id.
  let lastAssistantApiId: string | null = null
  let lastAssistantIndex = -1

  for (const entry of entries) {
    if (entry.isSidechain !== wantSidechain) continue
    const message = entry.message
    if (entry.timestamp !== null) {
      if (startedAt === null) startedAt = entry.timestamp
      endedAt = entry.timestamp
    }

    if (entry.type === 'user') {
      lastAssistantApiId = null
      lastAssistantIndex = -1
      const content = message.content
      if (typeof content === 'string') {
        messages.push({ role: 'user', content })
        continue
      }
      if (!Array.isArray(content)) continue
      // A user line may interleave tool_result blocks (answers to the prior
      // assistant tool_use) with plain text; preserve order.
      let userText = ''
      for (const block of content) {
        if (!isRecord(block)) continue
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content:
              blockText(block.content) || (typeof block.content === 'string' ? block.content : ''),
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          userText += (userText.length > 0 ? '\n' : '') + block.text
        }
      }
      if (userText.length > 0) messages.push({ role: 'user', content: userText })
      continue
    }

    // assistant
    if (typeof message.model === 'string') model = message.model
    const apiId = typeof message.id === 'string' ? message.id : null
    const continuesTurn = apiId !== null && apiId === lastAssistantApiId && lastAssistantIndex >= 0
    const msgUsage = message.usage
    if (!continuesTurn) {
      usageObserved = true
      const fields = [
        ['tokensIn', 'input_tokens'],
        ['tokensOut', 'output_tokens'],
        ['cacheRead', 'cache_read_input_tokens'],
        ['cacheWrite', 'cache_creation_input_tokens'],
      ] as const
      for (const [target, source] of fields) {
        const value = isRecord(msgUsage) ? msgUsage[source] : undefined
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          usage[target] = null
          gaps.push(`assistant ${apiId ?? 'without id'}: ${source} unavailable`)
        } else if (usage[target] !== null) {
          usage[target] += value
        }
      }
    }
    const content = message.content
    if (!Array.isArray(content)) continue
    let reasoning = ''
    let text = ''
    const toolCalls: ChatToolCall[] = []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (
        block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        block.thinking.length > 0
      ) {
        reasoning += (reasoning.length > 0 ? '\n' : '') + block.thinking
      } else if (block.type === 'text' && typeof block.text === 'string') {
        text += (text.length > 0 ? '\n' : '') + block.text
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : 'unknown',
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      }
    }
    if (reasoning.length === 0 && text.length === 0 && toolCalls.length === 0) continue
    if (continuesTurn) {
      const prev = messages[lastAssistantIndex]!
      if (text.length > 0) prev.content = prev.content === null ? text : `${prev.content}\n${text}`
      if (reasoning.length > 0) {
        prev.reasoning_content =
          prev.reasoning_content === undefined
            ? reasoning
            : `${prev.reasoning_content}\n${reasoning}`
      }
      if (toolCalls.length > 0) prev.tool_calls = [...(prev.tool_calls ?? []), ...toolCalls]
      continue
    }
    messages.push({
      role: 'assistant',
      content: text.length > 0 ? text : null,
      ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    })
    lastAssistantApiId = apiId
    lastAssistantIndex = messages.length - 1
  }

  if (!usageObserved) {
    usage.tokensIn = null
    usage.tokensOut = null
    usage.cacheRead = null
    usage.cacheWrite = null
  }
  return { messages, usage, startedAt, endedAt, model, gaps }
}
