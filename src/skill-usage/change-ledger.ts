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
 * | `action` | `commit`, `pr-create`, `pr-merge`, `observed`, or, from a writer that sees whole turns, `turn` and `push` |
 * | `remote` | the repository as `owner/repo` (or `host/path`); null when the writer could not find it |
 * | `sha`, `pr` | the commit or the pull request number; null when the call did not name it |
 *
 * `observed` is written once per session or subagent, at its first call. It says
 * the writer was running, which is the only thing that lets "no change rows"
 * mean "no change". A session with no row of any action is unknown, never none.
 *
 * A writer outside the harness, such as a gateway that runs the harness for a
 * caller (CLI Bridge), sees turns, not tool calls, and adds fields to its rows:
 *
 * | Field | Meaning |
 * |---|---|
 * | `sessionId` | the gateway's session id |
 * | `nativeSessionId` | the harness's own session id, the id its transcript carries; rows are keyed by it when present |
 * | `turnId`, `runId` | the gateway's turn and run |
 * | `turnStartedAt` | ISO time the turn began; with `at`, the window the change was made in |
 * | `incomplete` | on a `turn` row: why that turn's change rows may not be all of its changes (a checkout shared with another running turn, an unread pull request list); null when they are |
 * | `headBefore`, `head` | on a `turn` row: the working repository's HEAD when the turn began and when it ended |
 * | `branch` | on a `push` row: the remote branch the turn pushed |
 *
 * Such a row has no `toolUseId`. The change belongs to the last tool call of the
 * session record whose time lies in [`turnStartedAt`, `at`], so a record with no
 * times, or none in the window, leaves the change unplaced. A `turn` row with a
 * non-null `incomplete` makes the session's changes unknown, with a gap that says why.
 *
 * A row's `toolUseId` is the id the harness's hook saw. Where the session record
 * holds the call under that id, or names it in `callAliases`, the change belongs
 * to the turn that made the call. A row that matches neither makes the whole
 * session unknown, with a gap that says so: the change happened, and which turn
 * made it cannot be said, so no turn may be called change-free.
 */

import { readFile } from 'node:fs/promises'
import { errorMessage, ValidationError } from '../errors'
import type { SessionChange, SkillSessionRead, SkillSessionRecord, SkillSessionSource } from './session-record'

export const CHANGE_LEDGER_ACTIONS = ['observed', 'commit', 'pr-create', 'pr-merge', 'turn', 'push'] as const
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
  /** The harness's own session id, from a writer that runs the harness for a caller. */
  nativeSessionId?: string | null
  /** ISO start of the turn a gateway-written row belongs to. */
  turnStartedAt?: string | null
  /** `turn` rows: why the turn's changes may not be complete; null or absent when they are. */
  incomplete?: string | null
}

/** A change a gateway saw in a turn, placed on the session record by the turn's time window. */
export interface TimedChange {
  ref: string
  from: string
  to: string
}

/** What the ledger holds for one session or subagent. */
export interface ChangeLedgerSession {
  /** The writer ran in this session, so an empty `changes` is none. */
  observed: boolean
  changes: SessionChange[]
  /** Changes the writer saw but could not name: no repository, or no commit or pull request number. */
  unnamed: number
  /** Changes of a writer that sees turns, which name no tool call; placed by time when the session is joined. */
  timed: TimedChange[]
  /** Reasons given by `turn` rows that said their changes may be incomplete, with how often. */
  incomplete: Map<string, number>
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
  const nativeSessionId = optional('nativeSessionId')
  const turnStartedAt = optional('turnStartedAt')
  const incomplete = optional('incomplete')
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
    nativeSessionId === undefined ||
    turnStartedAt === undefined ||
    incomplete === undefined ||
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
    nativeSessionId,
    turnStartedAt,
    incomplete,
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
    const id = key(row.harness, row.agentId ?? row.nativeSessionId ?? row.sessionId)
    let session = sessions.get(id)
    if (session === undefined) {
      session = { observed: false, changes: [], unnamed: 0, timed: [], incomplete: new Map() }
      sessions.set(id, session)
    }
    if (row.action === 'observed' || row.action === 'push') {
      session.observed = true
      continue
    }
    if (row.action === 'turn') {
      session.observed = true
      if (row.incomplete) session.incomplete.set(row.incomplete, (session.incomplete.get(row.incomplete) ?? 0) + 1)
      continue
    }
    // A writer that records a change has run in the session, whatever its first row was.
    session.observed = true
    const ref = refOf(row)
    if (ref === null) session.unnamed += 1
    else if (row.toolUseId === null && row.turnStartedAt) session.timed.push({ ref, from: row.turnStartedAt, to: row.at })
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

/** The last tool call or skill call of the record whose time lies in [from, to]; null when there is none. */
function callInWindow(record: SkillSessionRecord, from: string, to: string): string | null {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  let found: string | null = null
  for (const event of record.events) {
    if (event.kind === 'model' || event.at === null) continue
    const at = Date.parse(event.at)
    if (at >= start && at <= end) found = event.kind === 'tool' ? event.id : event.callId
  }
  return found
}

function joinRead(read: SkillSessionRead, ledger: ChangeLedger): SkillSessionRead {
  if (!read.succeeded) return read
  const { value } = read
  const held = ledger.sessions.get(key(value.harness, value.sessionId))
  const seen = new Set<string>()
  const changes: SessionChange[] = []
  const aliases = value.callAliases ?? {}
  const placeable = new Set(
    value.events.flatMap((event) =>
      event.kind === 'tool' ? [event.id] : event.kind === 'skill' ? [event.callId] : [],
    ),
  )
  let unplaced = 0
  const timed: SessionChange[] = []
  for (const change of held?.timed ?? []) {
    const callId = callInWindow(value, change.from, change.to)
    if (callId === null) unplaced += 1
    else timed.push({ ref: change.ref, callId, at: change.to })
  }
  for (const row of [...(value.changes ?? []), ...(held?.changes ?? []), ...timed]) {
    // A hook can name a call by an id the session recorded it under another way.
    const change = Object.hasOwn(aliases, row.callId)
      ? { ...row, callId: aliases[row.callId] as string }
      : row
    if (!placeable.has(change.callId)) unplaced += 1
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
  if (unplaced > 0) {
    gaps.push(
      `${unplaced} changes name a tool call this session record does not hold, so the turn that made them is unknown and no turn is reported as having made none`,
    )
  }
  const { changes: _transcriptChanges, ...rest } = value
  // Observed: the ledger writer ran here, so no row means no change. Otherwise a
  // transcript that shows no change proves nothing about commits, and stays unknown.
  // A change that cannot be placed in a turn makes every turn unknown.
  const incomplete = [...(held?.incomplete ?? [])]
  if (incomplete.length > 0) {
    gaps.push(
      `the change ledger's writer said some turns' changes may be incomplete (${incomplete.map(([why, n]) => `${why}: ${n}`).join(', ')}), so the session's changes are unknown`,
    )
  }
  const known = unplaced === 0 && incomplete.length === 0 && (held?.observed === true || changes.length > 0)
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
