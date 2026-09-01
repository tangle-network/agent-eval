/**
 * Reader for agent-runtime's file-backed supervision context.
 *
 * Runtime stores multiple recursive trees in one `spawn-journal.jsonl`.
 * Each line is an envelope whose `root` identifies the local tree. A nested
 * driver is represented twice: once as a child spawn in its parent's tree and
 * once as the parentless root marker of its own tree. This reader removes only
 * that duplicate root marker and preserves the remaining envelopes for the
 * supervisor-run analyzer. Runtime stores profile identity below `identity`
 * and does not emit Eval's role field, so this boundary projects those fields
 * without changing Runtime's journal dialect.
 *
 * The run's terminal status is Runtime's own `result.json` `kind` — `winner`,
 * `no-winner`, or whatever a later arm is called — read verbatim. The reader
 * does not decide which kinds count: a kind it refuses is a run that recorded
 * its outcome and got reported as having none.
 *
 * `usdKnown: false` / `tokensKnown: false` on ONE record is not a limit of this
 * store. The store recorded every other record completely, so the flags travel
 * through to the analyzer per record, which reports the measured nodes and
 * names the unreported ones.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  NO_SOURCE_LIMITS,
  type SourceLimits,
  type SupervisorRunReader,
  type SupervisorRunSources,
  type WorkerLogSource,
} from './types'

const JOURNAL_FILE = 'spawn-journal.jsonl'
const RESULT_FILE = 'result.json'
const TRAJECTORY_FILE = 'trajectory.json'

interface BeginRecord {
  readonly root: string
  readonly at: string
  readonly line: number
}

interface EventRecord {
  readonly root: string
  readonly event: Record<string, unknown>
  readonly line: number
}

interface NormalizedRuntimeJournal {
  readonly root: string
  readonly startedAt: string
  readonly journal: string
  readonly events: readonly Record<string, unknown>[]
}

async function readMaybe(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function profileDigest(event: Record<string, unknown>): string | null {
  const direct = nonEmptyString(event.profileDigest)
  if (direct !== null) return direct
  const identity = record(event.identity)
  return identity === null ? null : nonEmptyString(identity.profileDigest)
}

function formatError(path: string, line: number, detail: string): Error {
  return new Error(`${path}:${line}: invalid Runtime spawn journal: ${detail}`)
}

function parseEnvelopeJournal(text: string, path: string): NormalizedRuntimeJournal {
  const begins: BeginRecord[] = []
  const events: EventRecord[] = []
  const begun = new Map<string, BeginRecord>()

  for (const [index, sourceLine] of text.split('\n').entries()) {
    const line = index + 1
    const trimmed = sourceLine.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw formatError(path, line, 'line is not JSON')
    }
    const envelope = record(parsed)
    if (envelope === null) throw formatError(path, line, 'line is not an object')
    const kind = nonEmptyString(envelope.kind)
    const root = nonEmptyString(envelope.root)
    if (root === null) throw formatError(path, line, 'root must be a non-empty string')

    if (kind === 'begin') {
      const at = nonEmptyString(envelope.at)
      if (at === null || !Number.isFinite(Date.parse(at))) {
        throw formatError(path, line, 'begin.at must be an ISO timestamp')
      }
      if (begun.has(root)) throw formatError(path, line, `tree ${JSON.stringify(root)} began twice`)
      const begin = { root, at, line }
      begun.set(root, begin)
      begins.push(begin)
      continue
    }

    if (kind !== 'event') {
      throw formatError(path, line, "kind must be 'begin' or 'event'")
    }
    if (!begun.has(root)) {
      throw formatError(path, line, `event for tree ${JSON.stringify(root)} precedes begin`)
    }
    const event = record(envelope.event)
    if (event === null) throw formatError(path, line, 'event must be an object')
    if (nonEmptyString(event.kind) === null) {
      throw formatError(path, line, 'event.kind must be a non-empty string')
    }
    events.push({ root, event: { ...event }, line })
  }

  if (begins.length === 0) throw formatError(path, 1, 'no begin record')

  const parentSpawnsById = new Map<string, EventRecord[]>()
  const rootMarkersByTree = new Map<string, EventRecord[]>()
  for (const entry of events) {
    if (entry.event.kind !== 'spawned') continue
    const id = nonEmptyString(entry.event.id)
    if (id === null) continue
    if (nonEmptyString(entry.event.parent) !== null) {
      const matches = parentSpawnsById.get(id) ?? []
      matches.push(entry)
      parentSpawnsById.set(id, matches)
    }
    if (entry.root === id && entry.event.parent === undefined) {
      const markers = rootMarkersByTree.get(entry.root) ?? []
      markers.push(entry)
      rootMarkersByTree.set(entry.root, markers)
    }
  }

  const nestedRoots = new Set<string>()
  const nestedParentSpawns = new Map<string, EventRecord>()
  for (const begin of begins) {
    const parentSpawns = (parentSpawnsById.get(begin.root) ?? []).filter(
      (entry) => entry.root !== begin.root,
    )
    if (parentSpawns.length > 1) {
      throw formatError(
        path,
        begin.line,
        `tree ${JSON.stringify(begin.root)} has ${parentSpawns.length} parent spawns`,
      )
    }
    if (parentSpawns.length === 1) {
      nestedRoots.add(begin.root)
      nestedParentSpawns.set(begin.root, parentSpawns[0] as EventRecord)
    }
  }

  const topRoots = begins.filter((begin) => !nestedRoots.has(begin.root))
  if (topRoots.length !== 1) {
    throw formatError(
      path,
      topRoots[0]?.line ?? 1,
      `expected one top-level tree, found ${topRoots.length}`,
    )
  }
  const top = topRoots[0] as BeginRecord

  for (const nestedRoot of nestedRoots) {
    const marker = rootMarkersByTree.get(nestedRoot) ?? []
    if (marker.length !== 1) {
      throw formatError(
        path,
        begun.get(nestedRoot)?.line ?? 1,
        `nested tree ${JSON.stringify(nestedRoot)} must contain one root marker`,
      )
    }
    const parentSpawn = nestedParentSpawns.get(nestedRoot)
    if (parentSpawn === undefined) {
      throw formatError(
        path,
        begun.get(nestedRoot)?.line ?? 1,
        `nested tree ${JSON.stringify(nestedRoot)} has no parent spawn`,
      )
    }
    const markerDigest = profileDigest(marker[0]?.event ?? {})
    const parentDigest = profileDigest(parentSpawn.event)
    if (markerDigest !== null && parentDigest !== null && markerDigest !== parentDigest) {
      throw formatError(
        path,
        marker[0]?.line ?? 1,
        `nested tree ${JSON.stringify(nestedRoot)} disagrees with its parent profile digest`,
      )
    }
    if (parentDigest === null && markerDigest !== null) {
      parentSpawn.event.profileDigest = markerDigest
    }
  }

  // Runtime's recursive atom has no supervisor/worker role field. A tree root
  // is a supervisor; a child without its own tree is a worker.
  const supervisorIds = new Set([top.root, ...nestedRoots])
  const normalized = events
    .filter(
      (entry) =>
        !(
          nestedRoots.has(entry.root) &&
          entry.event.kind === 'spawned' &&
          entry.event.id === entry.root &&
          entry.event.parent === undefined
        ),
    )
    .map((entry) => {
      const event = { ...entry.event }
      if (event.kind === 'spawned') {
        const digest = profileDigest(event)
        if (event.profileDigest === undefined && digest !== null) {
          event.profileDigest = digest
        }
        if (event.role === undefined) {
          event.role = supervisorIds.has(nonEmptyString(event.id) ?? '') ? 'supervisor' : 'worker'
        }
      }
      return { root: entry.root, event }
    })

  const rootMarkers = rootMarkersByTree.get(top.root) ?? []
  if (rootMarkers.length !== 1) {
    throw formatError(
      path,
      top.line,
      `top-level tree ${JSON.stringify(top.root)} must contain one root marker`,
    )
  }

  return {
    root: top.root,
    startedAt: top.at,
    // Keep Runtime's event envelope intact. The pure source parser uses the envelope to
    // distinguish an understood-but-unmodeled Runtime event from an unreadable flat record.
    journal: `${normalized
      .map((entry) => JSON.stringify({ kind: 'event', root: entry.root, event: entry.event }))
      .join('\n')}\n`,
    events: normalized.map((entry) => entry.event),
  }
}

function parseOptionalRecord(text: string | null, path: string): Record<string, unknown> | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path}: invalid JSON`)
  }
  const value = record(parsed)
  if (value === null) throw new Error(`${path}: expected a JSON object`)
  return value
}

function spendRecord(value: unknown): Record<string, unknown> | null {
  const spend = record(value)
  if (spend === null) return null
  const tokens = record(spend.tokens)
  if (
    tokens === null ||
    typeof tokens.input !== 'number' ||
    !Number.isFinite(tokens.input) ||
    tokens.input < 0 ||
    typeof tokens.output !== 'number' ||
    !Number.isFinite(tokens.output) ||
    tokens.output < 0 ||
    typeof spend.usd !== 'number' ||
    !Number.isFinite(spend.usd) ||
    spend.usd < 0 ||
    (spend.usdKnown !== undefined && typeof spend.usdKnown !== 'boolean')
  ) {
    return null
  }
  return spend
}

function sourceLimits(
  root: string,
  events: readonly Record<string, unknown>[],
  workerIds: ReadonlySet<string>,
): SourceLimits {
  const rootMeters = events.filter((event) => event.kind === 'metered' && event.id === root)
  const invalidRootMeters = rootMeters.filter((event) => spendRecord(event.spend) === null)
  const rootMeterReason =
    rootMeters.length === 0
      ? 'Runtime journal has no root metered event'
      : invalidRootMeters.length > 0
        ? `${invalidRootMeters.length} root metered event(s) lack complete spend`
        : null
  const closes = events.filter(
    (event) =>
      workerIds.has(nonEmptyString(event.id) ?? '') &&
      (event.kind === 'settled' || event.kind === 'cancelled'),
  )
  const settledById = new Map<string, Record<string, unknown>[]>()
  for (const event of closes) {
    const id = nonEmptyString(event.id)
    if (id === null) continue
    const matches = settledById.get(id) ?? []
    matches.push(event)
    settledById.set(id, matches)
  }
  const incompleteWorkers = [...workerIds].filter((id) => {
    const terminal = settledById.get(id)
    return (
      terminal?.length !== 1 ||
      terminal[0]?.kind !== 'settled' ||
      spendRecord(terminal[0]?.spent) === null
    )
  })
  const missingVerdicts = [...workerIds].filter((id) => {
    const terminal = settledById.get(id)?.[0]
    if (terminal?.kind !== 'settled') return true
    const verdict = record(terminal.verdict)
    return typeof verdict?.valid !== 'boolean'
  })

  return {
    managerTokens: rootMeterReason,
    workerTokens:
      incompleteWorkers.length === 0
        ? null
        : `${incompleteWorkers.length}/${workerIds.size} child invocation(s) lack one settled spend record`,
    // `usdKnown: false` on ONE record is not a limit of this store: the store priced every
    // other record, and a limit here discards them all. The analyzer folds the flag per
    // record instead, and reports a partial total with the unpriced nodes named.
    spendUsd:
      rootMeterReason !== null
        ? rootMeterReason
        : incompleteWorkers.length > 0
          ? 'at least one child invocation lacks a settled spend record'
          : null,
    workerVerdicts:
      missingVerdicts.length === 0
        ? null
        : `${missingVerdicts.length}/${workerIds.size} child invocation(s) lack a structured validity verdict`,
    deliverables:
      workerIds.size === 0
        ? null
        : 'Runtime FileRunContext does not retain per-child delivered patches',
  }
}

function runtimeState(
  root: string,
  startedAt: string,
  result: Record<string, unknown> | null,
  trajectory: Record<string, unknown> | null,
  resultPath: string,
  trajectoryPath: string,
): string {
  // Runtime's own terminal discriminant, read verbatim: `winner` when a child delivered,
  // `no-winner` when none did, and whatever a later arm is named. The reader translates the
  // envelope; it does not decide which kinds count, because a kind it fails to recognize is
  // reported as a missing status on a run that recorded one.
  const resultKind = result === null ? null : nonEmptyString(result.kind)
  if (resultKind !== null && result !== null) {
    const resultRoot = nonEmptyString(record(result.tree)?.root)
    if (resultRoot === null) {
      throw new Error(`${resultPath}: Runtime ${resultKind} result has no tree.root`)
    }
    if (resultRoot !== root) {
      throw new Error(
        `${resultPath}: root ${JSON.stringify(resultRoot)} does not match journal root ${JSON.stringify(root)}`,
      )
    }
  }

  if (trajectory !== null && nonEmptyString(trajectory.root) === null) {
    throw new Error(`${trajectoryPath}: Runtime trajectory has no root`)
  }
  if (typeof trajectory?.root === 'string' && trajectory.root !== root) {
    throw new Error(
      `${trajectoryPath}: root ${JSON.stringify(trajectory.root)} does not match journal root ${JSON.stringify(root)}`,
    )
  }
  if (trajectory !== null && !Array.isArray(trajectory.nodes)) {
    throw new Error(`${trajectoryPath}: Runtime trajectory nodes must be an array`)
  }

  let status: string | null = resultKind
  if (status === null && Array.isArray(trajectory?.nodes)) {
    const rootNodes = trajectory.nodes
      .map((node) => record(node))
      .filter((node) => node?.id === root)
    if (rootNodes.length > 1) {
      throw new Error(`${trajectoryPath}: Runtime trajectory contains duplicate root nodes`)
    }
    status = nonEmptyString(rootNodes[0]?.status)
  }

  return JSON.stringify({
    id: root,
    startedAt,
    ...(status === null ? {} : { status }),
  })
}

export interface RuntimeReaderOptions {
  /**
   * Throw on a missing spawn journal instead of returning absent-shaped
   * sources. The default (false) models a journal-less run dir — a
   * pre-supervise death, a backfilled zombie — as a readable absence.
   */
  readonly strict?: boolean
}

/**
 * Sources for a run dir whose spawn journal does not exist. Mirrors the
 * absent shape `readLoopsSupervisorRun` returns for a missing store: every
 * journal-dependent metric downstream reads `unavailable`, never 0.
 */
function absentRuntimeSupervisorRun(
  runDir: string,
  resultText: string | null,
): SupervisorRunSources {
  const reason = `no Runtime spawn journal (${JOURNAL_FILE}) under ${runDir}`
  return {
    runRef: runDir,
    instanceId: null,
    arm: null,
    supRunDir: null,
    journal: null,
    journalMissingReason: reason,
    brainLog: null,
    brainLogMissingReason:
      'Runtime FileRunContext records spend but not model completion finish reasons',
    state: null,
    progress: null,
    workers: null,
    workersMissingReason: reason,
    result: resultText,
    judge: null,
    judgeSource: null,
    patch: null,
    driverLog: null,
    harnessWorkerTokens: null,
    harnessMissingReason: 'Runtime FileRunContext has no external worker-token join',
    limits: NO_SOURCE_LIMITS,
    rootTranscriptRef: null,
    traceCommand: 'unavailable — Runtime FileRunContext records no provider-session trace identity',
  }
}

/**
 * Read one agent-runtime `createFileRunContext(dir)` directory.
 *
 * A run dir without `spawn-journal.jsonl` returns the same absent-shaped
 * sources `readLoopsSupervisorRun` returns for a missing store: `journal` and
 * `workers` null, each with its reason, so every dependent metric reads
 * `unavailable` — never 0 and never a throw. Pass `strict: true` to throw on
 * the missing journal instead. A journal that exists but cannot be parsed
 * always throws: a corrupt journal is a defect, not an absence.
 *
 * The reader translates storage envelopes only. It does not assign research
 * roles, interpret artifacts, or turn process completion into a quality
 * verdict.
 */
export async function readRuntimeSupervisorRun(
  runDir: string,
  opts: RuntimeReaderOptions = {},
): Promise<SupervisorRunSources> {
  const journalPath = join(runDir, JOURNAL_FILE)
  const rawJournal =
    opts.strict === true ? await readFile(journalPath, 'utf8') : await readMaybe(journalPath)
  if (rawJournal === null) {
    return absentRuntimeSupervisorRun(runDir, await readMaybe(join(runDir, RESULT_FILE)))
  }
  const normalized = parseEnvelopeJournal(rawJournal, journalPath)
  const resultText = await readMaybe(join(runDir, RESULT_FILE))
  const trajectoryText = await readMaybe(join(runDir, TRAJECTORY_FILE))
  const result = parseOptionalRecord(resultText, join(runDir, RESULT_FILE))
  const trajectory = parseOptionalRecord(trajectoryText, join(runDir, TRAJECTORY_FILE))
  const resultPath = join(runDir, RESULT_FILE)
  const trajectoryPath = join(runDir, TRAJECTORY_FILE)

  const spawns = normalized.events.filter(
    (event) => event.kind === 'spawned' && nonEmptyString(event.id) !== null,
  )
  const childSpawns = spawns.filter((event) => event.id !== normalized.root)
  const workerIds = new Set(
    childSpawns.map((event) => nonEmptyString(event.id)).filter((id): id is string => id !== null),
  )
  const workers: WorkerLogSource[] = childSpawns.map((event) => ({
    workerId: nonEmptyString(event.id) as string,
    label: nonEmptyString(event.label) ?? String(event.id),
    events: null,
    inbox: null,
    patchBytes: null,
    transcriptRef: null,
    patchPath: null,
  }))

  return {
    runRef: runDir,
    instanceId: normalized.root,
    arm: null,
    supRunDir: runDir,
    journal: normalized.journal,
    brainLog: null,
    brainLogMissingReason:
      'Runtime FileRunContext records spend but not model completion finish reasons',
    state: runtimeState(
      normalized.root,
      normalized.startedAt,
      result,
      trajectory,
      resultPath,
      trajectoryPath,
    ),
    progress: null,
    workers,
    workersMissingReason: null,
    result: resultText,
    judge: null,
    judgeSource: null,
    patch: null,
    driverLog: null,
    harnessWorkerTokens: null,
    harnessMissingReason: 'Runtime FileRunContext has no external worker-token join',
    limits: sourceLimits(normalized.root, normalized.events, workerIds),
    rootTranscriptRef: null,
    traceCommand: 'unavailable — Runtime FileRunContext records no provider-session trace identity',
  }
}

/** The agent-runtime file-backed layout as a `SupervisorRunReader`. */
export function runtimeSupervisorRunReader(
  runDir: string,
  opts: RuntimeReaderOptions = {},
): SupervisorRunReader {
  return { runRef: runDir, read: () => readRuntimeSupervisorRun(runDir, opts) }
}

/** True when a directory contains Runtime's canonical file-backed journal. */
export async function isRuntimeSupervisorRunDir(runDir: string): Promise<boolean> {
  return stat(join(runDir, JOURNAL_FILE))
    .then((entry) => entry.isFile())
    .catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ((error as { code: unknown }).code === 'ENOENT' ||
          (error as { code: unknown }).code === 'ENOTDIR')
      ) {
        return false
      }
      throw error
    })
}
