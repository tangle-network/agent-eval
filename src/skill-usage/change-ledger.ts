/**
 * The change ledger: one row per commit or pull request a session made, written
 * by the session's own harness at the moment the call returned, and the reader
 * that joins those rows to recorded sessions.
 *
 * A transcript names a pull request only when its output prints the URL, and
 * names no commit. The ledger is the harness's own record: each row carries the
 * tool call's id, so a change belongs to the typed turn whose span holds the
 * call, and the session's own commits and merges are counted, not guessed from
 * output text.
 *
 * Row format (JSON lines, `v` 1; a writer adds no other field the reader needs):
 *
 * | Field | Meaning |
 * |---|---|
 * | `at` | ISO time the call returned |
 * | `harness` | the harness that wrote it, as the session reader names it (`claude-code`) |
 * | `sessionId`, `agentId` | the session; inside a subagent, the subagent's id too (the id its own transcript carries) |
 * | `toolUseId` | the id of the tool call that made the change; null when the harness gave none |
 * | `action` | `commit`, `pr-create`, `pr-merge`, or `observed` |
 * | `remote` | the repository as `owner/repo` (or `host/path`); null when the writer could not find it |
 * | `sha`, `pr` | the commit or the pull request number; null when the call did not name it |
 *
 * `observed` is written once per session or subagent, at its first call. It says
 * the writer was running, which is the only thing that lets "no change rows"
 * mean "no change". A session with no row of any action is unknown, never none.
 */

import { readFile } from 'node:fs/promises'
import { errorMessage, ValidationError } from '../errors'
import type { SessionChange, SkillSessionRead, SkillSessionSource } from './session-record'

export const CHANGE_LEDGER_ACTIONS = ['observed', 'commit', 'pr-create', 'pr-merge'] as const
export type ChangeLedgerAction = (typeof CHANGE_LEDGER_ACTIONS)[number]

export interface ChangeLedgerRow {
  v: 1
  at: string
  harness: string
  sessionId: string
  agentId: string | null
  toolUseId: string | null
  action: ChangeLedgerAction
  remote: string | null
  sha: string | null
  pr: number | null
}

/** What the ledger holds for one session or subagent. */
export interface ChangeLedgerSession {
  /** The writer ran in this session, so an empty `changes` is none. */
  observed: boolean
  changes: SessionChange[]
  /** Changes the writer saw but could not name: no repository, or no commit or pull request number. */
  unnamed: number
}

export interface ChangeLedger {
  /** By `harness`, a NUL, and the subagent's id or else the session's. */
  sessions: ReadonlyMap<string, ChangeLedgerSession>
  rows: number
  /** Lines that are not a row of this format. */
  malformed: number
}

const key = (harness: string, id: string): string => `${harness}\u0000${id}`

function parseRow(line: string): ChangeLedgerRow | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const text = (field: string): string | null => {
    const raw = row[field]
    return typeof raw === 'string' && raw !== '' ? raw : null
  }
  const optional = (field: string): string | null | undefined => {
    const raw = row[field]
    if (raw === null || raw === undefined) return null
    return typeof raw === 'string' && raw !== '' ? raw : undefined
  }
  const action = row.action
  const toolUseId = optional('toolUseId')
  const agentId = optional('agentId')
  const remote = optional('remote')
  const sha = optional('sha')
  const pr = row.pr ?? null
  const at = text('at')
  const harness = text('harness')
  const sessionId = text('sessionId')
  if (
    row.v !== 1 ||
    at === null ||
    harness === null ||
    sessionId === null ||
    !(CHANGE_LEDGER_ACTIONS as readonly unknown[]).includes(action) ||
    toolUseId === undefined ||
    agentId === undefined ||
    remote === undefined ||
    sha === undefined ||
    (pr !== null && !(typeof pr === 'number' && Number.isInteger(pr) && pr > 0))
  ) {
    return null
  }
  return {
    v: 1,
    at,
    harness,
    sessionId,
    agentId,
    toolUseId,
    action: action as ChangeLedgerAction,
    remote,
    sha,
    pr: pr as number | null,
  }
}

/** The reference the registry's outcome source names a change by: `owner/repo#123` or `owner/repo@<sha>`. */
function refOf(row: ChangeLedgerRow): string | null {
  if (row.remote === null) return null
  if (row.action === 'commit') return row.sha === null ? null : `${row.remote}@${row.sha}`
  if (row.action === 'pr-create' || row.action === 'pr-merge') {
    return row.pr === null ? null : `${row.remote}#${row.pr}`
  }
  return null
}

/** Read ledger text. A line that is not a row is counted, not skipped silently, and no row is guessed from it. */
export function parseChangeLedger(text: string): ChangeLedger {
  const sessions = new Map<string, ChangeLedgerSession>()
  let rows = 0
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const row = parseRow(line)
    if (row === null) {
      malformed += 1
      continue
    }
    rows += 1
    const id = key(row.harness, row.agentId ?? row.sessionId)
    let session = sessions.get(id)
    if (session === undefined) {
      session = { observed: false, changes: [], unnamed: 0 }
      sessions.set(id, session)
    }
    if (row.action === 'observed') {
      session.observed = true
      continue
    }
    // A writer that records a change has run in the session, whatever its first row was.
    session.observed = true
    const ref = refOf(row)
    if (ref === null) session.unnamed += 1
    else session.changes.push({ ref, callId: row.toolUseId ?? '', at: row.at })
  }
  return { sessions, rows, malformed }
}

/** Read one or more ledger files as one ledger. A file that cannot be read throws: a missing ledger is not an empty one. */
export async function readChangeLedger(paths: readonly string[]): Promise<ChangeLedger> {
  const texts: string[] = []
  for (const path of paths) {
    try {
      texts.push(await readFile(path, 'utf8'))
    } catch (error) {
      throw new ValidationError(`readChangeLedger: cannot read ${path}: ${errorMessage(error)}`)
    }
  }
  return parseChangeLedger(texts.join('\n'))
}

function joinRead(read: SkillSessionRead, ledger: ChangeLedger): SkillSessionRead {
  if (!read.succeeded) return read
  const { value } = read
  const held = ledger.sessions.get(key(value.harness, value.sessionId))
  const seen = new Set<string>()
  const changes: SessionChange[] = []
  for (const change of [...(value.changes ?? []), ...(held?.changes ?? [])]) {
    const id = `${change.ref}\u0000${change.callId}`
    if (seen.has(id)) continue
    seen.add(id)
    changes.push(change)
  }
  const gaps = [...value.gaps]
  if (held !== undefined && held.unnamed > 0) {
    gaps.push(
      `${held.unnamed} changes the change ledger recorded could not be named (no repository, or no commit or pull request number)`,
    )
  }
  const { changes: _transcriptChanges, ...rest } = value
  // Observed: the ledger writer ran here, so no row means no change. Otherwise a
  // transcript that shows no change proves nothing about commits, and stays unknown.
  const known = held?.observed === true || changes.length > 0
  return { ...read, value: { ...rest, gaps, ...(known ? { changes } : {}) } }
}

/**
 * The sessions of `source` with their changes taken from the ledger as well as
 * from the transcript. A session the ledger never observed keeps only the
 * changes its transcript shows, and has none recorded when it shows none.
 */
export async function* withChangeLedger(
  source: SkillSessionSource,
  ledger: ChangeLedger,
): AsyncGenerator<SkillSessionRead> {
  for await (const read of source) yield joinRead(read, ledger)
}
