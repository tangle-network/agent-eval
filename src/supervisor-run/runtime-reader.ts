/**
 * Reader for agent-runtime's file-backed supervision context.
 *
 * Runtime stores multiple recursive trees in one `spawn-journal.jsonl`.
 * Each line is an envelope whose `root` identifies the local tree. A nested
 * driver is represented twice: once as a child spawn in its parent's tree and
 * once as the parentless root marker of its own tree. This reader removes only
 * that duplicate root marker and passes the remaining events to the existing
 * supervisor-run analyzer.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SourceLimits,
  SupervisorRunReader,
  SupervisorRunSources,
  WorkerLogSource,
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
    const markerDigest = nonEmptyString(marker[0]?.event.profileDigest)
    const parentDigest = nonEmptyString(parentSpawn.event.profileDigest)
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
    .map((entry) => entry.event)

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
    journal: `${normalized.map((event) => JSON.stringify(event)).join('\n')}\n`,
    events: normalized,
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
  const spendRows = [
    ...rootMeters.map((event) => spendRecord(event.spend)),
    ...closes.filter((event) => event.kind === 'settled').map((event) => spendRecord(event.spent)),
  ].filter((spend): spend is Record<string, unknown> => spend !== null)
  const unknownUsd = spendRows.some((spend) => spend.usdKnown === false)
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
    spendUsd:
      rootMeterReason !== null
        ? rootMeterReason
        : unknownUsd
          ? 'Runtime recorded usdKnown:false for at least one spend'
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
  const resultKind =
    result?.kind === 'completed' || result?.kind === 'interrupted' ? result.kind : null
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

  let status: string | null = null
  if (resultKind === 'completed') status = 'completed'
  else if (resultKind === 'interrupted') status = 'interrupted'
  else if (Array.isArray(trajectory?.nodes)) {
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

/**
 * Read one agent-runtime `createFileRunContext(dir)` directory.
 *
 * The reader translates storage envelopes only. It does not assign research
 * roles, interpret artifacts, or turn process completion into a quality
 * verdict.
 */
export async function readRuntimeSupervisorRun(runDir: string): Promise<SupervisorRunSources> {
  const journalPath = join(runDir, JOURNAL_FILE)
  const rawJournal = await readFile(journalPath, 'utf8')
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
export function runtimeSupervisorRunReader(runDir: string): SupervisorRunReader {
  return { runRef: runDir, read: () => readRuntimeSupervisorRun(runDir) }
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
