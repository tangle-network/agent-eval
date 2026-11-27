/**
 * Claude Code transcripts as skill session records.
 *
 * The shared session reader decides what a transcript's tool calls, model calls
 * and usage are. A transcript also says how each skill started, in records the
 * normalized session does not keep, so this module reads those from the same
 * parsed lines:
 *
 * | Invoker | Record |
 * |---|---|
 * | agent | an `assistant` record with a `tool_use` named `Skill` |
 * | user | a `user` record that opens with a `command-name` tag, written by a person, whose first reply is the prompt the command expanded to |
 * | harness | the same tag in a record the harness wrote (`isMeta`) or inside a subagent (`isSidechain`): a preload |
 *
 * A typed command the CLI answers itself (its reply is command output) is not a
 * skill and is left out. The text a skill was loaded with is the `isMeta`
 * record that names the call in `sourceToolUseID`; its hash is the version that
 * ran, whatever the skill file holds today.
 */

import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readSessionInput, type SessionToolCall } from '@tangle-network/harness-sessions'
import { record, stringField } from '../contract/intake/code-agent-fields'
import { parseCodeAgentJsonlFile } from '../contract/intake/code-agent-jsonl'
import { errorMessage, ValidationError } from '../errors'
import type { TraceContract } from '../trace-contracts/types'
import { githubPullRequestRefs } from './change-refs'
import { checkSessionContracts } from './contract-checks'
import {
  type LoadedSkillText,
  type MessageSkillInvocation,
  skillSessionFromHarnessSession,
} from './harness-session'
import type { SkillSessionRead, SkillSessionRecord } from './session-record'
import { type TranscriptWalk, walkTranscripts } from './transcript-walk'

const SKILL_TOOL = 'Skill'
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
const BASE_DIRECTORY = 'Base directory for this skill: '
const COMMAND_OUTPUT = '<local-command-'

interface CommandTag {
  name: string
  args: string | null
}

function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    const part = record(block)
    if (part !== null && part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text)
    }
  }
  return texts
}

/** A `command-name` tag that opens the text, alone or after its `command-message`. */
function commandTag(text: string): CommandTag | null {
  const head = text.trimStart()
  if (!head.startsWith('<command-name>') && !head.startsWith('<command-message>')) return null
  const name = COMMAND_NAME.exec(head)?.[1]?.trim().replace(/^\//, '')
  if (!name) return null
  const args = COMMAND_ARGS.exec(head)?.[1]
  return { name, args: args === undefined || args.trim() === '' ? null : args }
}

/**
 * The body a skill was loaded with. The harness frames it with the skill's
 * directory on the first line and appends the caller's arguments; both are
 * removed so two calls of one version hash the same.
 */
function loadedSkillText(text: string, args: string | null): LoadedSkillText | null {
  if (!text.startsWith(BASE_DIRECTORY)) return null
  const lineEnd = text.indexOf('\n')
  const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd)
  const directory = firstLine.slice(BASE_DIRECTORY.length).trim()
  let body = lineEnd === -1 ? '' : text.slice(lineEnd + 1)
  const trailer = args === null ? null : `\n\nARGUMENTS: ${args}`
  if (trailer !== null && body.endsWith(trailer)) body = body.slice(0, -trailer.length)
  return { body, skillFile: directory === '' ? null : join(directory, 'SKILL.md') }
}

function firstLoadedSkillText(
  texts: readonly string[],
  args: string | null,
): LoadedSkillText | null {
  for (const text of texts) {
    const loaded = loadedSkillText(text, args)
    if (loaded !== null) return loaded
  }
  return null
}

/** Claude Code's subagent tools: `Agent`, and `Task` in older versions. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

/** The subagent type a Claude Code tool call starts, or null when it names none. */
function subagentOfToolCall(call: SessionToolCall): string | null {
  if (!SUBAGENT_TOOLS.has(call.name)) return null
  const type = record(call.input)?.subagent_type
  return typeof type === 'string' && type !== '' ? type : null
}

/** The skill a Claude Code tool call invokes, or null. */
function skillOfToolCall(call: SessionToolCall): string | null {
  if (call.name !== SKILL_TOOL) return null
  const skill = record(call.input)?.skill
  return typeof skill === 'string' && skill !== '' ? skill : null
}

interface SkillMarkers {
  loadedByCallId: Map<string, LoadedSkillText>
  invocationsByMessageId: Map<string, MessageSkillInvocation>
}

/**
 * Read how skills started from parsed transcript lines. `subagent` is true for
 * a subagent's own transcript; in a top-level transcript, sidechain records
 * belong to subagents and are skipped, as the shared reader skips them.
 */
function skillMarkers(records: readonly unknown[], subagent: boolean): SkillMarkers {
  const loadedByCallId = new Map<string, LoadedSkillText>()
  const invocationsByMessageId = new Map<string, MessageSkillInvocation>()
  /** Arguments of each `Skill` call seen so far, by call id. */
  const skillCallArgs = new Map<string, string | null>()
  /** Typed commands whose first reply has not been read yet, by record id. */
  const typedCommands = new Map<string, CommandTag>()
  const seenRecords = new Set<string>()

  for (const value of records) {
    const entry = record(value)
    if (entry === null) continue
    if (!subagent && entry.isSidechain === true) continue
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const id = stringField(entry, 'uuid')
    if (id !== undefined) {
      if (seenRecords.has(id)) continue
      seenRecords.add(id)
    }
    const content = record(entry.message)?.content

    if (entry.type === 'assistant') {
      for (const block of Array.isArray(content) ? content : []) {
        const part = record(block)
        if (part === null || part.type !== 'tool_use' || part.name !== SKILL_TOOL) continue
        if (typeof part.id !== 'string') continue
        const args = record(part.input)?.args
        skillCallArgs.set(part.id, typeof args === 'string' && args !== '' ? args : null)
      }
      continue
    }

    const texts = textBlocks(content)
    const first = texts[0]
    if (first === undefined) continue

    const answers = stringField(entry, 'sourceToolUseID')
    if (answers !== undefined && skillCallArgs.has(answers)) {
      if (!loadedByCallId.has(answers)) {
        const loaded = firstLoadedSkillText(texts, skillCallArgs.get(answers) ?? null)
        if (loaded !== null) loadedByCallId.set(answers, loaded)
      }
      continue
    }

    const parent = stringField(entry, 'parentUuid')
    const typed = parent === undefined ? undefined : typedCommands.get(parent)
    if (parent !== undefined && typed !== undefined) {
      typedCommands.delete(parent)
      // A command that is a skill expands to a prompt the harness writes; one
      // the CLI handles itself answers with its own output and is not a skill.
      if (entry.isMeta === true && !first.trimStart().startsWith(COMMAND_OUTPUT)) {
        invocationsByMessageId.set(parent, {
          skill: typed.name,
          invoker: 'user',
          loaded: firstLoadedSkillText(texts, typed.args),
        })
      }
      continue
    }

    const tag = commandTag(first)
    if (tag === null || id === undefined) continue
    if (entry.isMeta === true || entry.isSidechain === true || subagent) {
      invocationsByMessageId.set(id, {
        skill: tag.name,
        invoker: 'harness',
        loaded: firstLoadedSkillText(texts.slice(1), tag.args),
      })
    } else {
      typedCommands.set(id, tag)
    }
  }

  return { loadedByCallId, invocationsByMessageId }
}

interface SessionIdentity {
  sessionId: string
  /** The session that spawned this transcript; null for a top-level one. */
  parentSessionId: string | null
}

/**
 * Whose transcript this is, from its own records: a subagent's records are all
 * sidechain and name the agent, whatever folder the file sits in.
 */
function transcriptIdentity(records: readonly unknown[], fallbackId: string): SessionIdentity {
  for (const value of records) {
    const entry = record(value)
    if (entry === null || (entry.type !== 'user' && entry.type !== 'assistant')) continue
    const sessionId = stringField(entry, 'sessionId')
    if (entry.isSidechain === true) {
      return {
        sessionId: stringField(entry, 'agentId') ?? fallbackId,
        parentSessionId: sessionId ?? fallbackId,
      }
    }
    return { sessionId: sessionId ?? fallbackId, parentSessionId: null }
  }
  return { sessionId: fallbackId, parentSessionId: null }
}

/** One transcript's parsed lines as a skill session record. */
function skillSession(
  records: readonly unknown[],
  identity: SessionIdentity,
  contracts: readonly TraceContract[] | undefined,
): SkillSessionRecord {
  const session = readSessionInput(
    'claude-code',
    { records },
    { nativeSessionId: identity.sessionId, parentNativeSessionId: identity.parentSessionId },
  )
  const value = skillSessionFromHarnessSession(session, {
    skillOfToolCall,
    subagentOfToolCall,
    changesOfToolCall: githubPullRequestRefs,
    ...skillMarkers(records, identity.parentSessionId !== null),
  })
  if (contracts !== undefined) value.contractChecks = checkSessionContracts(session, contracts)
  return value
}

export interface ClaudeCodeSkillSessionsOptions {
  /** Skip transcripts not written since this instant (epoch ms): they hold nothing newer. */
  sinceMs?: number
  /** Check each session against these contracts; the counts land on `contractChecks`. */
  contracts?: readonly TraceContract[]
}

/**
 * Every transcript under a Claude Code projects directory, one read per file:
 * top-level sessions and each subagent's own file. A file or folder that cannot
 * be read is a failed read with its reason, so it is counted and never mistaken
 * for a session with no skills. Throws when the directory itself cannot be read.
 */
export async function* claudeCodeSkillSessions(
  directory: string,
  options: ClaudeCodeSkillSessionsOptions = {},
): AsyncGenerator<SkillSessionRead> {
  const walk: TranscriptWalk = { files: [], unreadable: [] }
  try {
    await walkTranscripts(directory, walk)
  } catch (error) {
    throw new ValidationError(
      `claudeCodeSkillSessions: cannot read ${directory}: ${errorMessage(error)}`,
    )
  }
  for (const failure of walk.unreadable) yield { succeeded: false, ...failure }
  for (const path of walk.files) {
    try {
      if (options.sinceMs !== undefined && (await stat(path)).mtimeMs < options.sinceMs) continue
      const parsed = await parseCodeAgentJsonlFile(path)
      const value = skillSession(
        parsed.entries,
        transcriptIdentity(parsed.entries, basename(path, '.jsonl').replace(/^agent-/, '')),
        options.contracts,
      )
      if (parsed.malformedLines > 0) {
        value.gaps.push(`${parsed.malformedLines} lines are not JSON`)
      }
      yield { succeeded: true, source: path, value }
    } catch (error) {
      yield { succeeded: false, source: path, error: errorMessage(error) }
    }
  }
}
