/**
 * Codex rollouts as skill session records.
 *
 * `@tangle-network/harness-sessions` owns what a rollout's tool calls, model
 * calls, typed turns and usage are. This module adds what the rollout says about
 * skills and changes:
 *
 * | Fact | Record |
 * |---|---|
 * | a skill invocation | a shell call that reads a `skills/<name>/SKILL.md` file with a viewer (`cat`, `sed`, `head`, `nl`...); Codex has no skill tool, so the read is the invocation |
 * | the skill's version | none from the session: the read is often partial (`head -70`), so the report reads the skill file as it is now and says so |
 * | a change | a pull request a shell call opened or merged, as for Claude Code; the change ledger adds commits |
 *
 * Inside Codex's code-mode `exec` tool a script runs shell commands, and the
 * hook that wrote a change ledger row saw the command's own id (`exec-<uuid>`),
 * not the id of the `exec` call. The rollout records that id on the command's
 * completion event, between the call and its output, so it names the call when
 * exactly one `exec` call is open. With none or several open it names none, and
 * the session says how many ids it could not place.
 */

import { stat } from 'node:fs/promises'
import {
  codexRefForFile,
  readSessionInput,
  type SessionToolCall,
} from '@tangle-network/harness-sessions'
import { record, stringField } from '../contract/intake/code-agent-fields'
import { parseCodeAgentJsonlFile } from '../contract/intake/code-agent-jsonl'
import { errorMessage, ValidationError } from '../errors'
import type { TraceContract } from '../trace-contracts/types'
import { githubPullRequestRefs, shellCommandText } from './change-refs'
import { checkSessionContracts } from './contract-checks'
import { skillSessionFromHarnessSession } from './harness-session'
import type { SkillSessionRead, SkillSessionRecord } from './session-record'
import { type TranscriptWalk, walkTranscripts } from './transcript-walk'

/** A viewer reading a skill file: `cat path`, `sed -n '1,80p' path`, `head -70 path`. */
const SKILL_READ =
  /\b(?:cat|head|tail|sed|nl|bat|less|more|awk)\b[^\n;&|]*?(?:^|[\s'"=])((?:[\w~.$/-]*\/)?skills\/([\w.-]+)\/SKILL\.md)\b/

/** The skill a shell call reads, and the file it reads it from. */
function skillRead(call: SessionToolCall): { skill: string; file: string } | null {
  const command = shellCommandText(call)
  if (command === null) return null
  const match = SKILL_READ.exec(command)
  if (match === null) return null
  return { skill: match[2] as string, file: match[1] as string }
}

/** The ids hooks name nested commands by, mapped to the `exec` call that ran them. */
function execCallAliases(records: readonly unknown[]): {
  aliases: Record<string, string>
  unplaced: number
} {
  const aliases: Record<string, string> = {}
  const open = new Set<string>()
  let unplaced = 0
  for (const value of records) {
    const entry = record(value)
    const payload = record(entry?.payload)
    if (entry === null || payload === null) continue
    if (entry.type === 'response_item') {
      const callId = stringField(payload, 'call_id')
      if (callId === undefined) continue
      if (payload.type === 'custom_tool_call' && payload.name === 'exec') open.add(callId)
      else if (payload.type === 'custom_tool_call_output') open.delete(callId)
    } else if (entry.type === 'event_msg' && payload.type === 'item_completed') {
      const item = record(payload.item)
      if (item === null || item.type !== 'CommandExecution') continue
      const id = stringField(item, 'id')
      if (id === undefined || !id.startsWith('exec-')) continue
      const [only] = open
      if (open.size === 1 && only !== undefined) aliases[id] = only
      else unplaced += 1
    }
  }
  return { aliases, unplaced }
}

/** One rollout's parsed lines as a skill session record. */
function rolloutSession(
  records: readonly unknown[],
  path: string,
  contracts: readonly TraceContract[] | undefined,
): SkillSessionRecord {
  const session = readSessionInput('codex', { records }, codexRefForFile(path))
  const { aliases, unplaced } = execCallAliases(records)
  const value = skillSessionFromHarnessSession(session, {
    skillOfToolCall: (call) => skillRead(call)?.skill ?? null,
    skillFileOfToolCall: (call) => skillRead(call)?.file ?? null,
    changesOfToolCall: githubPullRequestRefs,
    callAliases: aliases,
  })
  if (contracts !== undefined) value.contractChecks = checkSessionContracts(session, contracts)
  if (unplaced > 0) {
    value.gaps.push(
      `${unplaced} commands run inside code-mode scripts name no single script, so a change ledger row for them cannot be placed`,
    )
  }
  return value
}

export interface CodexSkillSessionsOptions {
  /** Skip rollouts not written since this instant (epoch ms): they hold nothing newer. */
  sinceMs?: number
  /** Check each session against these contracts; the counts land on `contractChecks`. */
  contracts?: readonly TraceContract[]
}

/**
 * Every rollout under a Codex sessions directory (`~/.codex/sessions`, or one
 * account's), one read per file: top-level threads and each subagent's own. A
 * file or folder that cannot be read is a failed read with its reason. Throws
 * when the directory itself cannot be read.
 */
export async function* codexSkillSessions(
  directory: string,
  options: CodexSkillSessionsOptions = {},
): AsyncGenerator<SkillSessionRead> {
  const walk: TranscriptWalk = { files: [], unreadable: [] }
  try {
    await walkTranscripts(
      directory,
      walk,
      (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
    )
  } catch (error) {
    throw new ValidationError(
      `codexSkillSessions: cannot read ${directory}: ${errorMessage(error)}`,
    )
  }
  for (const failure of walk.unreadable) yield { succeeded: false, ...failure }
  for (const path of walk.files) {
    try {
      if (options.sinceMs !== undefined && (await stat(path)).mtimeMs < options.sinceMs) continue
      const parsed = await parseCodeAgentJsonlFile(path)
      const value = rolloutSession(parsed.entries, path, options.contracts)
      if (parsed.malformedLines > 0) value.gaps.push(`${parsed.malformedLines} lines are not JSON`)
      yield { succeeded: true, source: path, value }
    } catch (error) {
      yield { succeeded: false, source: path, error: errorMessage(error) }
    }
  }
}
