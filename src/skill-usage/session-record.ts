/**
 * The session record the skill-usage report reads.
 *
 * One record is one agent session: a top-level conversation, or one subagent's
 * own thread. Its events are in the order the session recorded them, so "after
 * the first invocation" is a position in the list and needs no clock. A reader
 * for any harness or trace store produces this shape; nothing here names a
 * harness's record layout.
 */

import type { CostUsage } from '../cost-ledger/contract'

/**
 * Who started a skill.
 *  - `agent`: the model called it as a tool.
 *  - `user`: a person typed it as a command.
 *  - `harness`: the harness loaded it without either, for example the skills
 *    an agent definition preloads into a subagent.
 */
export type SkillInvoker = 'agent' | 'user' | 'harness'

/** Which version of a skill an invocation ran. */
export interface SkillVersionEvidence {
  /** sha256 of the skill body the agent was given: the file without its
   *  frontmatter, surrounding whitespace trimmed. The same text hashes the
   *  same whether it is read from a session record or from the skill file. */
  bodySha256: string
  /**
   * `session`: the session recorded the loaded text with the call, so this is
   * the version that ran. `file`: read from the skill file when the report
   * ran, so it can be newer than the call.
   */
  source: 'session' | 'file'
}

export interface SkillInvocationEvent {
  kind: 'skill'
  /** The tool-call id, or the id of the record that carries a typed command
   *  or a preload. One id is one invocation, however often it is recorded. */
  callId: string
  skill: string
  invoker: SkillInvoker
  at: string | null
  /** null when the session recorded no loaded text for this invocation. */
  version: SkillVersionEvidence | null
  /** The skill file the harness loaded from, when the session names it. */
  skillFile: string | null
  /** True when the harness refused the call; null when no result is recorded. */
  failed: boolean | null
}

export interface ToolCallEvent {
  kind: 'tool'
  id: string
  name: string
  at: string | null
  /** null while the call has no recorded result. */
  failed: boolean | null
}

export interface ModelCallEvent {
  kind: 'model'
  id: string
  at: string | null
  /** The model that answered, when the session says. */
  model: string | null
  /** null when the response recorded no usage: unknown, not zero. */
  usage: CostUsage | null
}

export type SkillSessionEvent = SkillInvocationEvent | ToolCallEvent | ModelCallEvent

/**
 * A change the session produced, named by a reference the caller's outcome
 * source also uses, for example `owner/repo#123` for a pull request. The
 * reference is opaque here: this package never reads what it names.
 */
export interface SessionChange {
  ref: string
  /** The tool call that named the change. */
  callId: string
  at: string | null
}

export interface SkillSessionRecord {
  harness: string
  sessionId: string
  /** The session that spawned this one; null for a top-level session. */
  parentSessionId: string | null
  endedAt: string | null
  /** Skill invocations, tool calls and model calls in recorded order. A skill
   *  invoked as a tool call appears once, as the invocation. */
  events: SkillSessionEvent[]
  /**
   * Changes the session produced, in recorded order. Undefined when the reader
   * does not look for them; an empty list when it looked and found none.
   */
  changes?: SessionChange[]
  /** What the reader could not read in this session, in its own words. */
  gaps: string[]
}

/** One attempt to read a session: the record, or why there is none. */
export type SkillSessionRead =
  | { succeeded: true; source: string; value: SkillSessionRecord }
  | { succeeded: false; source: string; error: string }

/** Any reader of session records: an array, a generator, or a store cursor. */
export type SkillSessionSource = AsyncIterable<SkillSessionRead> | Iterable<SkillSessionRead>
