import { record } from './runtime-artifacts'
import { nonEmptyString } from './source-facts'

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

function profileDigest(event: Record<string, unknown>): string | null {
  const direct = nonEmptyString(event.profileDigest)
  if (direct !== null) return direct
  const identity = record(event.identity)
  return identity === null ? null : nonEmptyString(identity.profileDigest)
}

function formatError(path: string, line: number, detail: string): Error {
  return new Error(`${path}:${line}: invalid Runtime spawn journal: ${detail}`)
}

export function parseEnvelopeJournal(text: string, path: string): NormalizedRuntimeJournal {
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
  const parentSpawnsByOwnedTreeRoot = new Map<string, EventRecord[]>()
  for (const entry of events) {
    if (entry.event.kind !== 'spawned') continue
    const id = nonEmptyString(entry.event.id)
    if (id === null) continue
    if (nonEmptyString(entry.event.parent) !== null) {
      const ownedTreeRoot = nonEmptyString(entry.event.ownedTreeRoot)
      if (ownedTreeRoot !== null) {
        const owners = parentSpawnsByOwnedTreeRoot.get(ownedTreeRoot) ?? []
        owners.push(entry)
        parentSpawnsByOwnedTreeRoot.set(ownedTreeRoot, owners)
      } else {
        const matches = parentSpawnsById.get(id) ?? []
        matches.push(entry)
        parentSpawnsById.set(id, matches)
      }
    }
  }

  const nestedRoots = new Set<string>()
  const nestedParentSpawns = new Map<string, EventRecord>()
  for (const begin of begins) {
    const parentSpawns = [
      ...new Set([
        ...(parentSpawnsByOwnedTreeRoot.get(begin.root) ?? []),
        ...(parentSpawnsById.get(begin.root) ?? []),
      ]),
    ].filter((entry) => entry.root !== begin.root)
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

  // A tree's root marker is a parentless spawn of the node that owns the tree: the top root
  // itself, or the parent spawn that owns a nested tree. An owned tree's key is a path, so
  // the owner's id is compared, never the tree key.
  const ownerIdByTree = new Map<string, string>([[top.root, top.root]])
  for (const [nestedRoot, parentSpawn] of nestedParentSpawns) {
    const ownerId = nonEmptyString(parentSpawn.event.id)
    if (ownerId !== null) ownerIdByTree.set(nestedRoot, ownerId)
  }
  const isRootMarker = (entry: EventRecord): boolean =>
    entry.event.kind === 'spawned' &&
    (entry.event.parent === undefined || entry.event.parent === null) &&
    nonEmptyString(entry.event.id) !== null &&
    entry.event.id === ownerIdByTree.get(entry.root)
  const rootMarkersByTree = new Map<string, EventRecord[]>()
  for (const entry of events) {
    if (!isRootMarker(entry)) continue
    const markers = rootMarkersByTree.get(entry.root) ?? []
    markers.push(entry)
    rootMarkersByTree.set(entry.root, markers)
  }

  for (const nestedRoot of nestedRoots) {
    const markers = rootMarkersByTree.get(nestedRoot) ?? []
    if (markers.length > 1) {
      throw formatError(
        path,
        begun.get(nestedRoot)?.line ?? 1,
        `nested tree ${JSON.stringify(nestedRoot)} contains ${markers.length} root markers`,
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
    const markerDigest = profileDigest(markers[0]?.event ?? {})
    const parentDigest = profileDigest(parentSpawn.event)
    if (markerDigest !== null && parentDigest !== null && markerDigest !== parentDigest) {
      throw formatError(
        path,
        markers[0]?.line ?? 1,
        `nested tree ${JSON.stringify(nestedRoot)} disagrees with its parent profile digest`,
      )
    }
    if (parentDigest === null && markerDigest !== null) {
      parentSpawn.event.profileDigest = markerDigest
    }
  }

  const ownedTreeBySupervisorId = new Map<string, string>([[top.root, top.root]])
  for (const [nestedRoot, parentSpawn] of nestedParentSpawns) {
    const supervisorId = nonEmptyString(parentSpawn.event.id)
    if (supervisorId === null) continue
    const priorTree = ownedTreeBySupervisorId.get(supervisorId)
    if (priorTree !== undefined && priorTree !== nestedRoot) {
      throw formatError(
        path,
        parentSpawn.line,
        `spawn ${JSON.stringify(supervisorId)} owns both ${JSON.stringify(priorTree)} and ${JSON.stringify(nestedRoot)}`,
      )
    }
    ownedTreeBySupervisorId.set(supervisorId, nestedRoot)
  }
  for (const entry of events) {
    if (entry.event.kind !== 'spawned') continue
    const parentId = nonEmptyString(entry.event.parent)
    if (parentId === null) continue
    const parentTree = ownedTreeBySupervisorId.get(parentId)
    if (parentTree === undefined) {
      throw formatError(
        path,
        entry.line,
        `spawn ${JSON.stringify(entry.event.id)} names parent ${JSON.stringify(parentId)}, which owns no journal tree`,
      )
    }
    if (entry.root !== parentTree) {
      throw formatError(
        path,
        entry.line,
        `spawn ${JSON.stringify(entry.event.id)} is in tree ${JSON.stringify(entry.root)}, but parent ${JSON.stringify(parentId)} owns tree ${JSON.stringify(parentTree)}`,
      )
    }
  }

  // Runtime's recursive atom has no supervisor/worker role field. A tree root
  // is a supervisor; a child without its own tree is a worker.
  const supervisorIds = new Set([
    top.root,
    ...[...nestedParentSpawns.values()]
      .map((entry) => nonEmptyString(entry.event.id))
      .filter((id): id is string => id !== null),
  ])
  const normalized = events
    .filter((entry) => !(nestedRoots.has(entry.root) && isRootMarker(entry)))
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
