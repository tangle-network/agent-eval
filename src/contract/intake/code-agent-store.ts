/**
 * A RUN-SCOPED finder over a coding agent's own session store.
 *
 * `observeCodeAgentSession` projects one session a caller already holds. Nothing in this package
 * answered the question before it — "which sessions belong to THIS run" — so every caller that
 * needed a count wrote its own directory scan, and the scan they wrote pointed at the ambient host
 * store because that is where the harness writes by default.
 *
 * MEASURED MOTIVE. A discovery-lab run (`q-zk-coral-alloc-superlinear`, 2026-09-01) captured ZERO
 * rollouts of its own and reported `subagentActions: 903`. The 903 came from whatever else ran on
 * the host inside the same time window, including the operator's own interactive codex sessions. A
 * second run in the same fleet held one captured rollout and reported `sessions: 0`, missing the
 * file it owned. The scan was attributing by modification time over `~/.codex/sessions`, which is
 * every run's store at once. (discovery#80, defect 4.)
 *
 * Three rules follow from that, and they are what this module enforces mechanically:
 *
 *   1. `root` is the ONLY directory read, and it has no default. A caller must name the run's own
 *      captured store. There is no code path here that can reach a host store on its own.
 *   2. A session is attributed only when the store's own records place it inside the run — its
 *      recorded working directory under `workspaceRoot`, its start inside `window`. A session that
 *      records neither, while a filter asks for one, is REJECTED. Fail closed: an unattributable
 *      session is exactly the file that produced the 903.
 *   3. A scope that attributes nothing returns `status: 'unavailable'` and CARRIES NO COUNTS. The
 *      union makes it impossible to read a `0` as "this run used no subagents", which is a
 *      different fact from "this run captured nothing to look at".
 */

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  CodeAgentSessionActionSurface,
  CodeAgentSessionObservation,
  CodeAgentSessionSource,
} from './code-agent-observation'
import { observeCodeAgentSession } from './code-agent-observation'
import { parseCodeAgentJsonlFile } from './code-agent-session'

/** Which store to read, and what makes a session in it belong to this run. */
export interface CodeAgentStoreScope {
  /**
   * Absolute path to the run's OWN captured session store. Required, with no default: a default
   * would be the host store, and the host store is another run's evidence.
   */
  readonly root: string
  /** The harness family that wrote it. */
  readonly source: CodeAgentSessionSource
  /**
   * Attribute only a session whose recorded working directory is this path or below it. A session
   * recording no working directory is rejected while this is set.
   */
  readonly workspaceRoot?: string
  /**
   * Attribute only a session that started inside the run. A session recording no start is rejected
   * while this is set.
   */
  readonly window?: {
    readonly startedAtMs: number
    /** Absent leaves the window open-ended, for a run still in flight. */
    readonly finishedAtMs?: number
  }
}

/** Why a file under `root` was not attributed to the run. */
export type CodeAgentStoreRejection =
  | 'outside-workspace'
  | 'no-workspace-recorded'
  | 'before-run'
  | 'after-run'
  | 'no-start-recorded'
  | 'no-entries'
  | 'unreadable'

/** One attributed session, named so a caller can cite the file the numbers came from. */
export interface CodeAgentStoreSession {
  readonly path: string
  readonly sessionId: string
  readonly workspace?: string
  readonly startedAtMs?: number
  readonly observation: CodeAgentSessionObservation
}

/** Every file the scan looked at and could not attribute. */
export interface CodeAgentStoreRejections {
  readonly total: number
  readonly byReason: Readonly<Partial<Record<CodeAgentStoreRejection, number>>>
  /** The first few rejected paths with their reason, for a caller that must explain a zero. */
  readonly sample: ReadonlyArray<{
    readonly path: string
    readonly reason: CodeAgentStoreRejection
  }>
}

/**
 * What one store scan found.
 *
 * The union is the point. An `unavailable` result carries NO action counts, so no caller can print
 * a `0` — or a number from another run — as this run's measurement.
 */
export type CodeAgentStoreObservation =
  | {
      readonly status: 'observed'
      readonly scope: CodeAgentStoreScope
      readonly filesScanned: number
      readonly sessions: readonly CodeAgentStoreSession[]
      /** Total actions across the attributed sessions. */
      readonly actions: number
      /** Actions on the `subagent` surface — harness-native fan-out this run performed. */
      readonly subagentActions: number
      /** Sessions carrying at least one `subagent` action. */
      readonly sessionsWithSubagentActions: number
      readonly bySurface: Readonly<Partial<Record<CodeAgentSessionActionSurface, number>>>
      readonly rejections: CodeAgentStoreRejections
    }
  | {
      readonly status: 'unavailable'
      readonly scope: CodeAgentStoreScope
      readonly filesScanned: number
      /** Why nothing could be counted, in the terms a report can print verbatim. */
      readonly reason: string
      readonly rejections: CodeAgentStoreRejections
    }

const SESSION_SUFFIX = '.jsonl'
const REJECTION_SAMPLE_LIMIT = 8

/**
 * Read every session this run captured under `scope.root` and project them.
 *
 * A store directory that does not exist, or that holds no session the scope attributes, returns
 * `status: 'unavailable'`. That is not an error: a run whose harness store was never synced back
 * has no evidence, and saying so is the correct answer.
 */
export async function observeCodeAgentStore(
  scope: CodeAgentStoreScope,
): Promise<CodeAgentStoreObservation> {
  if (!isAbsolute(scope.root)) {
    throw new TypeError(
      `observeCodeAgentStore: scope.root must be an absolute path to this run's own store, received ${JSON.stringify(scope.root)}`,
    )
  }
  const workspaceRoot = scope.workspaceRoot === undefined ? undefined : resolve(scope.workspaceRoot)
  const paths = await listSessionFiles(resolve(scope.root))
  const sessions: CodeAgentStoreSession[] = []
  const byReason = new Map<CodeAgentStoreRejection, number>()
  const sample: Array<{ path: string; reason: CodeAgentStoreRejection }> = []
  const reject = (path: string, reason: CodeAgentStoreRejection): void => {
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    if (sample.length < REJECTION_SAMPLE_LIMIT) sample.push({ path, reason })
  }

  for (const path of paths) {
    let entries: unknown[]
    try {
      entries = (await parseCodeAgentJsonlFile(path)).entries
    } catch {
      reject(path, 'unreadable')
      continue
    }
    if (entries.length === 0) {
      reject(path, 'no-entries')
      continue
    }
    const workspace = sessionWorkspace(entries)
    if (workspaceRoot !== undefined) {
      if (workspace === undefined) {
        reject(path, 'no-workspace-recorded')
        continue
      }
      if (!isSameOrBelow(workspaceRoot, workspace)) {
        reject(path, 'outside-workspace')
        continue
      }
    }
    const startedAtMs = sessionStartedAtMs(entries)
    if (scope.window !== undefined) {
      if (startedAtMs === undefined) {
        reject(path, 'no-start-recorded')
        continue
      }
      if (startedAtMs < scope.window.startedAtMs) {
        reject(path, 'before-run')
        continue
      }
      if (scope.window.finishedAtMs !== undefined && startedAtMs > scope.window.finishedAtMs) {
        reject(path, 'after-run')
        continue
      }
    }
    const observation = observeCodeAgentSession({
      source: scope.source,
      entries,
      sourcePath: path,
    })
    sessions.push({
      path,
      sessionId: observation.sessionId,
      ...(workspace === undefined ? {} : { workspace }),
      ...(startedAtMs === undefined ? {} : { startedAtMs }),
      observation,
    })
  }

  const rejections: CodeAgentStoreRejections = {
    total: [...byReason.values()].reduce((sum, count) => sum + count, 0),
    byReason: Object.fromEntries(byReason),
    sample,
  }
  if (sessions.length === 0) {
    return {
      status: 'unavailable',
      scope,
      filesScanned: paths.length,
      reason: unavailableReason(paths.length, rejections),
      rejections,
    }
  }

  const bySurface = new Map<CodeAgentSessionActionSurface, number>()
  let actions = 0
  let subagentActions = 0
  let sessionsWithSubagentActions = 0
  for (const session of sessions) {
    let sessionSubagents = 0
    for (const action of session.observation.actions) {
      actions += 1
      bySurface.set(action.surface, (bySurface.get(action.surface) ?? 0) + 1)
      if (action.surface === 'subagent') sessionSubagents += 1
    }
    subagentActions += sessionSubagents
    if (sessionSubagents > 0) sessionsWithSubagentActions += 1
  }
  return {
    status: 'observed',
    scope,
    filesScanned: paths.length,
    sessions,
    actions,
    subagentActions,
    sessionsWithSubagentActions,
    bySurface: Object.fromEntries(bySurface),
    rejections,
  }
}

function unavailableReason(filesScanned: number, rejections: CodeAgentStoreRejections): string {
  if (filesScanned === 0) return 'the run captured no session files in this store'
  const reasons = Object.entries(rejections.byReason)
    .map(([reason, count]) => `${count} ${reason}`)
    .sort()
    .join(', ')
  return `no session in this store belongs to the run: ${filesScanned} file(s) scanned, all rejected (${reasons})`
}

async function listSessionFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // A store that was never written is not an error; it is an unavailable observation.
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith(SESSION_SUFFIX)) found.push(path)
    }
  }
  await walk(root)
  // A directory that exists but holds no session file is still an empty store, and a path that is
  // itself one session file is a legitimate single-file scope.
  if (found.length === 0 && (await isSessionFile(root))) found.push(root)
  return found.sort()
}

async function isSessionFile(path: string): Promise<boolean> {
  if (!path.endsWith(SESSION_SUFFIX)) return false
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * The working directory the session RECORDED, from the first entry that states one.
 *
 * codex writes it on `session_meta.payload.cwd`; claude-code writes `cwd` on every line. Neither is
 * inferred from the file's own location: where a captured file was copied to says nothing about
 * where the agent ran.
 */
function sessionWorkspace(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    const record = plainRecord(entry)
    if (record === undefined) continue
    const direct = stringOf(record.cwd)
    if (direct !== undefined) return direct
    const payload = plainRecord(record.payload)
    const nested = stringOf(payload?.cwd)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** When the session itself says it started, from the first entry carrying a parseable timestamp. */
function sessionStartedAtMs(entries: readonly unknown[]): number | undefined {
  for (const entry of entries) {
    const record = plainRecord(entry)
    if (record === undefined) continue
    const payload = plainRecord(record.payload)
    for (const candidate of [payload?.timestamp, record.timestamp]) {
      const text = stringOf(candidate)
      if (text === undefined) continue
      const parsed = Date.parse(text)
      if (Number.isFinite(parsed)) return parsed
    }
    const epochMs = numberOf(record.timestampMs) ?? numberOf(payload?.timestampMs)
    if (epochMs !== undefined) return epochMs
  }
  return undefined
}

function isSameOrBelow(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
