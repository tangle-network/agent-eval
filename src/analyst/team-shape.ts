/**
 * team-shape — classify how a supervision tree was organized, from a Runtime
 * spawn journal and its coordination log.
 *
 * Input rows come in either of two shapes, read by the same parser:
 *   - Runtime envelopes, as `readRuntimeSupervisorRun` returns them in
 *     `SupervisorRunSources.journal` and `.coordinationLog`
 *     (`teamShapeInputFromSources`);
 *   - the structure-only reduction under `tests/fixtures/team-shape`
 *     (`extract.py`): spawn rows `{ kind, journal, id, at }`, coordination
 *     rows `{ at, type, owner, toWorker?, from?, by?, delivered? }`.
 *
 * Three edge sets over the agents:
 *   - E, command, parent → child. The parent is the child id minus its last
 *     `:sN` segment (`R:s1:s0` is child `s0` of `R:s1`); the spawn journal has
 *     no parent field. An id outside that path is an unplaced agent: its E
 *     edge is not observable, and it is never read as depth 1.
 *   - G, governance, receiver → child: the agent whose journal holds the
 *     child's `settled` row, plus the sender of each `steer`.
 *   - C, communication, sender → receiver: coordination rows that name a
 *     receiver (`toWorker`). The sender is `from`/`by` when the row names an
 *     agent, else the log owner's digest, which no record joins to an agent.
 *     `instruction` and `delivery-attempt` rows are the queue and transport
 *     stages of the steer row that follows them, so they are not counted.
 *
 * Classes, version 1, checked in order; the first the record shows wins:
 *   1. single              — one agent.
 *   2. governed-swarm      — E runs between peers, or a team's governor
 *                            changes over the run.
 *   3. fleet               — one dispatcher, and governance from a non-parent
 *                            agent inside the team or lateral C ≥ 20%.
 *   4. partition           — two or more lead subtrees with no C or G between
 *                            them, and no lead settles to the root.
 *   5. hive                — depth ≥ 2 and at least half the root's children
 *                            delegate (`hive depth N`).
 *   6. star-with-sub-leads — depth ≥ 2, fewer than half delegate.
 *   7. flat-star           — depth 1; qualified by root integration share.
 * The thresholds are provisional and travel in `method.version`. A check the
 * record cannot decide (an owner digest is not an agent id, so lateral C and
 * steer governance often are not) reads `not observable from this record`,
 * never `no`, and the classification moves on to the next class.
 */

import type { SupervisorRunSources } from '../supervisor-run/types'
import type { Analyst } from './types'
import { makeFinding } from './types'

export const TEAM_SHAPE_ANALYST_ID = 'team-shape'

const TEAM_SHAPE_THRESHOLDS = {
  /** Share of the root's children that delegate at or above which depth ≥ 2 is a hive. */
  hiveDelegatingShare: 0.5,
  /** Lateral share of C edges at or above which a one-dispatcher team is a fleet. */
  fleetLateralCShare: 0.2,
  /** Root share of integrating commits at or above which a flat star reads `root integrates`. */
  rootIntegrationShare: 0.5,
} as const

/** Version 1, provisional, with the thresholds it was decided at. */
export const TEAM_SHAPE_VERSION = `1-provisional;hive-delegating=${TEAM_SHAPE_THRESHOLDS.hiveDelegatingShare};fleet-lateral-c=${TEAM_SHAPE_THRESHOLDS.fleetLateralCShare};root-integration=${TEAM_SHAPE_THRESHOLDS.rootIntegrationShare}`

export const TEAM_SHAPE_CLASSES = [
  'single',
  'governed-swarm',
  'fleet',
  'partition',
  'hive',
  'star-with-sub-leads',
  'flat-star',
] as const

export type TeamShapeClass = (typeof TEAM_SHAPE_CLASSES)[number]

export const NOT_OBSERVABLE = 'not observable from this record'
export type NotObservable = typeof NOT_OBSERVABLE
export type TeamShapeObserved<T> = T | NotObservable

export interface TeamIntegration {
  commit: string
  /** Agent id, in the record's id space, that authored the integrating commit. */
  by: string
}

export interface TeamShapeInput {
  /** The run the record came from, cited as the finding's evidence. */
  runRef: string
  /** Spawn journal JSONL. */
  spawnJournal: string
  /** Coordination log JSONL; null or absent when the run kept none. */
  coordinationLog?: string | null
  /** The release's integrating commits; disco derives them from commit trailers. */
  integrations?: readonly TeamIntegration[]
}

export interface TeamShapeEdge {
  from: string
  to: string
  count: number
}

export interface TeamShapeFeatures {
  agents: number
  /** Agents other than the root. */
  tasks: number
  /** Agents whose id is outside the root's `:sN` path; their E edge is not observable. */
  unplacedAgents: number
  depth: number
  fanOut: { root: number; max: number }
  /** Root's children that delegate ÷ root's children; null when the root has none. */
  delegatingShare: number | null
  /** Spawns after the first settlement. */
  reHires: number
  settlementsByReceiver: Record<string, number>
  steers: { sent: number; delivered: number }
  /** Coordination messages per task; null with no tasks or no coordination log. */
  messagesPerTask: number | null
  /** Lateral C edges ÷ C edges. */
  lateralCShare: TeamShapeObserved<number>
  /** G edges from a non-parent agent ÷ G edges. */
  nonParentGShare: TeamShapeObserved<number>
  /** Root-authored integrating commits ÷ integrating commits. */
  rootIntegrationShare: TeamShapeObserved<number>
}

export interface TeamShapeCheck {
  result: 'yes' | 'no' | NotObservable
  reason: string
}

export interface TeamShape {
  class: TeamShapeClass
  depth: number
  /** Only a flat star carries one: `root integrates`, `root does not integrate` or `integration unknown`. */
  qualifier: string | null
  /** Class in words: `hive depth 2`, `flat-star (integration unknown)`. */
  label: string
  rootId: string
  features: TeamShapeFeatures
  /** Every class's rule against this record, in check order. */
  checks: Record<TeamShapeClass, TeamShapeCheck>
  graph: { command: TeamShapeEdge[]; governance: TeamShapeEdge[]; communication: TeamShapeEdge[] }
  invalidRows: { spawn: number; coordination: number }
  window: { from: string; to: string } | null
}

export type TeamShapeOutcome =
  | { succeeded: true; value: TeamShape }
  | { succeeded: false; error: { message: string } }

interface SpawnRow {
  kind: 'spawned' | 'settled'
  /** Agent whose journal holds the row: the last segment of the journal key. */
  owner: string
  /** The whole journal key, to find the root marker. */
  journal: string
  id: string
  at: number
}

interface CoordinationRow {
  at: number | null
  type: string
  owner: string | null
  toWorker?: string
  from?: string
  by?: string
  delivered?: boolean
}

/** Team-shape input for a run read through a supervisor-run reader. */
export function teamShapeInputFromSources(
  sources: SupervisorRunSources,
  integrations?: readonly TeamIntegration[],
): { succeeded: true; value: TeamShapeInput } | { succeeded: false; error: { message: string } } {
  if (sources.journal === null) {
    return {
      succeeded: false,
      error: { message: sources.journalMissingReason ?? `no spawn journal for ${sources.runRef}` },
    }
  }
  return {
    succeeded: true,
    value: {
      runRef: sources.runRef,
      spawnJournal: sources.journal,
      coordinationLog: sources.coordinationLog ?? null,
      ...(integrations === undefined ? {} : { integrations }),
    },
  }
}

export function classifyTeamShape(input: TeamShapeInput): TeamShapeOutcome {
  const spawnLog = parseSpawnRows(input.spawnJournal)
  const coordination =
    typeof input.coordinationLog === 'string' ? parseCoordinationRows(input.coordinationLog) : null
  const spawnedAt = new Map<string, number>()
  for (const row of spawnLog.rows) {
    if (row.kind !== 'spawned') continue
    spawnedAt.set(row.id, Math.min(row.at, spawnedAt.get(row.id) ?? Number.POSITIVE_INFINITY))
  }
  const rootIds = [
    ...new Set(
      spawnLog.rows
        .filter((row) => row.kind === 'spawned' && row.journal === row.id)
        .map((r) => r.id),
    ),
  ]
  if (rootIds.length !== 1) {
    return {
      succeeded: false,
      error: {
        message: `spawn journal for ${input.runRef} has ${rootIds.length} root markers; team-shape needs exactly one`,
      },
    }
  }
  const rootId = rootIds[0]!
  const agents = new Set(spawnedAt.keys())

  // E: the id path. A parent outside the record leaves the agent unplaced.
  const parentOf = new Map<string, string>()
  let unplacedAgents = 0
  for (const id of agents) {
    if (id === rootId) continue
    const parent = pathParent(id)
    if (parent !== null && agents.has(parent) && id.startsWith(`${rootId}:`)) {
      parentOf.set(id, parent)
    } else unplacedAgents += 1
  }
  const children = new Map<string, string[]>()
  const command = new Map<string, TeamShapeEdge>()
  for (const [child, parent] of parentOf) {
    children.set(parent, [...(children.get(parent) ?? []), child])
    addEdge(command, parent, child)
  }
  const depthOf = (id: string): number => {
    let hops = 0
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) hops += 1
    return hops
  }
  const depth = Math.max(0, ...[...parentOf.keys()].map(depthOf))
  const rootChildren = children.get(rootId) ?? []
  const leads = rootChildren.filter((child) => (children.get(child)?.length ?? 0) > 0)
  const delegatingShare = rootChildren.length === 0 ? null : leads.length / rootChildren.length
  const subtreeOf = (id: string): string | null => {
    let at: string | undefined = id
    while (at !== undefined && parentOf.get(at) !== rootId) at = parentOf.get(at)
    return at ?? null
  }

  // A spawn row in a journal that belongs to neither the parent nor the child itself.
  let peerSpawns = 0
  for (const row of spawnLog.rows) {
    if (row.kind !== 'spawned' || row.id === rootId) continue
    if (row.owner !== row.id && row.owner !== parentOf.get(row.id)) peerSpawns += 1
  }

  // G: settlements, receiver → child.
  const governance = new Map<string, TeamShapeEdge>()
  const settlementsByReceiver: Record<string, number> = {}
  const governorsByParent = new Map<string, { agents: Set<string>; digests: Set<string> }>()
  const governorsOf = (child: string) => {
    const parent = parentOf.get(child) ?? `unplaced:${child}`
    const entry = governorsByParent.get(parent) ?? { agents: new Set(), digests: new Set() }
    governorsByParent.set(parent, entry)
    return entry
  }
  let gResolved = 0
  let gUnresolved = 0
  let gNonParent = 0
  let firstSettlement = Number.POSITIVE_INFINITY
  for (const row of spawnLog.rows) {
    if (row.kind !== 'settled' || row.owner === row.id) continue
    firstSettlement = Math.min(firstSettlement, row.at)
    settlementsByReceiver[row.owner] = (settlementsByReceiver[row.owner] ?? 0) + 1
    addEdge(governance, row.owner, row.id)
    governorsOf(row.id).agents.add(row.owner)
    gResolved += 1
    if (parentOf.get(row.id) !== row.owner) gNonParent += 1
  }
  const reHires = [...spawnedAt.entries()].filter(
    ([id, at]) => id !== rootId && at > firstSettlement,
  ).length

  // C, and G from steers.
  const communication = new Map<string, TeamShapeEdge>()
  let messages = 0
  let cResolved = 0
  let cUnresolved = 0
  let cLateral = 0
  let cCrossSubtree = 0
  let gCrossSubtree = 0
  const steers = { sent: 0, delivered: 0 }
  const isAgent = (value: string | undefined): value is string =>
    value !== undefined && agents.has(value)
  for (const row of coordination?.rows ?? []) {
    if (row.type === 'instruction' || row.type === 'delivery-attempt') continue
    if (row.toWorker === undefined && row.from === undefined && row.by === undefined) continue
    messages += 1
    if (row.type === 'steer') {
      steers.sent += 1
      if (row.delivered === true) steers.delivered += 1
    }
    // A refused steer reached nobody: it is counted as sent, not as an edge.
    if (!isAgent(row.toWorker) || row.delivered === false) continue
    const receiver = row.toWorker
    const agentSender = [row.from, row.by].find(isAgent)
    const sender = agentSender ?? (row.owner === null ? null : `owner:${row.owner}`)
    if (sender === null) continue
    addEdge(communication, sender, receiver)
    if (agentSender === undefined) cUnresolved += 1
    else {
      cResolved += 1
      const parent = parentOf.get(receiver)
      if (parent !== undefined && parent === parentOf.get(agentSender)) cLateral += 1
      if (crosses(subtreeOf(agentSender), subtreeOf(receiver))) cCrossSubtree += 1
    }
    if (row.type === 'steer') {
      addEdge(governance, sender, receiver)
      if (agentSender === undefined) {
        gUnresolved += 1
        governorsOf(receiver).digests.add(sender)
      } else {
        gResolved += 1
        governorsOf(receiver).agents.add(agentSender)
        if (parentOf.get(receiver) !== agentSender) gNonParent += 1
        if (crosses(subtreeOf(agentSender), subtreeOf(receiver))) gCrossSubtree += 1
      }
    }
  }
  for (const [child, receiver] of spawnLog.rows
    .filter((row) => row.kind === 'settled' && row.owner !== row.id)
    .map((row) => [row.id, row.owner] as const)) {
    if (crosses(subtreeOf(receiver), subtreeOf(child))) gCrossSubtree += 1
  }

  const cTotal = cResolved + cUnresolved
  const gTotal = gResolved + gUnresolved
  const lateralCShare: TeamShapeObserved<number> =
    coordination === null || cTotal === 0 || cUnresolved > 0 ? NOT_OBSERVABLE : cLateral / cTotal
  const nonParentGShare: TeamShapeObserved<number> =
    gTotal === 0 || gUnresolved > 0 ? NOT_OBSERVABLE : gNonParent / gTotal
  const integrations = input.integrations ?? []
  const rootIntegrationShare: TeamShapeObserved<number> =
    integrations.length === 0
      ? NOT_OBSERVABLE
      : integrations.filter((row) => row.by === rootId).length / integrations.length

  const features: TeamShapeFeatures = {
    agents: agents.size,
    tasks: agents.size - 1,
    unplacedAgents,
    depth,
    fanOut: {
      root: rootChildren.length,
      max: Math.max(0, ...[...children.values()].map((c) => c.length)),
    },
    delegatingShare,
    reHires,
    settlementsByReceiver,
    steers,
    messagesPerTask: coordination === null || agents.size < 2 ? null : messages / (agents.size - 1),
    lateralCShare,
    nonParentGShare,
    rootIntegrationShare,
  }

  const checks = {} as Record<TeamShapeClass, TeamShapeCheck>
  checks.single = verdict(agents.size === 1, `${agents.size} agents`)

  const rotating = [...governorsByParent.entries()].find(([, g]) => g.agents.size > 1)
  const digestTeams = [...governorsByParent.values()].filter((g) => g.digests.size > 1).length
  checks['governed-swarm'] =
    peerSpawns > 0
      ? { result: 'yes', reason: `${peerSpawns} spawns recorded by a peer, not the parent` }
      : rotating !== undefined
        ? {
            result: 'yes',
            reason: `children of ${rotating[0]} are governed by ${[...rotating[1].agents].join(', ')}`,
          }
        : digestTeams > 0
          ? {
              result: NOT_OBSERVABLE,
              reason: `${digestTeams} teams were steered by more than one owner digest; a digest is not an agent id, so a rotating governor cannot be told from the operator`,
            }
          : {
              result: 'no',
              reason: 'every E edge runs parent to child and no team changed governor',
            }

  const dispatchers = [...children.keys()]
  if (dispatchers.length !== 1 || unplacedAgents > 0) {
    checks.fleet = {
      result: unplacedAgents > 0 && dispatchers.length <= 1 ? NOT_OBSERVABLE : 'no',
      reason:
        unplacedAgents > 0 && dispatchers.length <= 1
          ? `${unplacedAgents} unplaced agents hide who dispatched their work`
          : `${dispatchers.length} agents dispatch work`,
    }
  } else if (gNonParent > 0) {
    checks.fleet = { result: 'yes', reason: `${gNonParent} G edges come from a non-parent agent` }
  } else if (cLateral / Math.max(cTotal, 1) >= TEAM_SHAPE_THRESHOLDS.fleetLateralCShare) {
    checks.fleet = { result: 'yes', reason: `lateral C ${cLateral} of ${cTotal}` }
  } else if (gUnresolved > 0 || lateralCShare === NOT_OBSERVABLE) {
    checks.fleet = {
      result: NOT_OBSERVABLE,
      reason: `one dispatcher; ${gUnresolved} steer G and ${cUnresolved} C edges are sent from owner digests that no record joins to an agent${coordination === null ? ', and the run has no coordination log' : ''}`,
    }
  } else {
    checks.fleet = verdict(
      false,
      `one dispatcher, no non-parent G, lateral C ${cLateral} of ${cTotal}`,
    )
  }

  const rootSettledByLeads = spawnLog.rows.filter(
    (row) => row.kind === 'settled' && row.owner === rootId && leads.includes(row.id),
  ).length
  if (leads.length < 2 || rootSettledByLeads > 0 || gCrossSubtree > 0 || cCrossSubtree > 0) {
    checks.partition = verdict(
      false,
      `${leads.length} lead subtrees, ${rootSettledByLeads} lead settlements to the root, ${gCrossSubtree + cCrossSubtree} edges between subtrees`,
    )
  } else if (gUnresolved > 0 || cUnresolved > 0 || coordination === null) {
    checks.partition = {
      result: NOT_OBSERVABLE,
      reason: `${leads.length} lead subtrees and no lead settles to the root, but edges sent from owner digests cannot be placed in a subtree`,
    }
  } else {
    checks.partition = verdict(true, `${leads.length} lead subtrees with no C or G between them`)
  }

  const delegating = `${leads.length} of ${rootChildren.length} root children delegate`
  const hive = depth >= 2 && (delegatingShare ?? 0) >= TEAM_SHAPE_THRESHOLDS.hiveDelegatingShare
  checks.hive = verdict(hive, `depth ${depth}; ${delegating}`)
  checks['star-with-sub-leads'] = verdict(depth >= 2 && !hive, `depth ${depth}; ${delegating}`)
  checks['flat-star'] = verdict(depth === 1, `depth ${depth}`)

  const shapeClass = TEAM_SHAPE_CLASSES.find((name) => checks[name].result === 'yes')
  if (shapeClass === undefined) {
    return {
      succeeded: false,
      error: { message: `no team-shape class matches ${input.runRef} (depth ${depth})` },
    }
  }
  const qualifier =
    shapeClass !== 'flat-star'
      ? null
      : rootIntegrationShare === NOT_OBSERVABLE
        ? 'integration unknown'
        : rootIntegrationShare >= TEAM_SHAPE_THRESHOLDS.rootIntegrationShare
          ? 'root integrates'
          : 'root does not integrate'
  const label =
    shapeClass === 'hive'
      ? `hive depth ${depth}`
      : qualifier === null
        ? shapeClass
        : `${shapeClass} (${qualifier})`

  const times = [
    ...spawnLog.rows.map((row) => row.at),
    ...(coordination?.rows ?? []).flatMap((row) => (row.at === null ? [] : [row.at])),
  ]
  return {
    succeeded: true,
    value: {
      class: shapeClass,
      depth,
      qualifier,
      label,
      rootId,
      features,
      checks,
      graph: {
        command: [...command.values()],
        governance: [...governance.values()],
        communication: [...communication.values()],
      },
      invalidRows: { spawn: spawnLog.invalid, coordination: coordination?.invalid ?? 0 },
      window:
        times.length === 0
          ? null
          : {
              from: new Date(Math.min(...times)).toISOString(),
              to: new Date(Math.max(...times)).toISOString(),
            },
    },
  }
}

function verdict(holds: boolean, reason: string): TeamShapeCheck {
  return { result: holds ? 'yes' : 'no', reason }
}

function crosses(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b
}

function pathParent(id: string): string | null {
  const match = /^(.+):s\d+$/.exec(id)
  return match ? match[1]! : null
}

function addEdge(edges: Map<string, TeamShapeEdge>, from: string, to: string): void {
  const key = JSON.stringify([from, to])
  const edge = edges.get(key)
  if (edge) edge.count += 1
  else edges.set(key, { from, to, count: 1 })
}

function jsonLines(text: string): Array<Record<string, unknown> | null> {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line)
        return typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null
      } catch {
        return null
      }
    })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * Spawned and settled rows from a Runtime envelope (`{ root, event }`) or a
 * reduced row (`{ kind, journal, id, at }`). Other Runtime event kinds are
 * read and skipped; a spawned or settled row without an id, journal or time
 * is invalid.
 */
function parseSpawnRows(text: string): { rows: SpawnRow[]; invalid: number } {
  const rows: SpawnRow[] = []
  let invalid = 0
  for (const line of jsonLines(text)) {
    if (line === null) {
      invalid += 1
      continue
    }
    const event = asRecord(line.event) ?? line
    const journal = event === line ? line.journal : line.root
    const { kind, id } = event
    if (kind !== 'spawned' && kind !== 'settled') continue
    const at = epochMs(event.at)
    if (typeof id !== 'string' || typeof journal !== 'string' || at === null) {
      invalid += 1
      continue
    }
    rows.push({ kind, journal, owner: journal.slice(journal.lastIndexOf('/') + 1), id, at })
  }
  return { rows, invalid }
}

/**
 * Coordination rows from a Runtime record (`{ at, ownerId, event: { type,
 * <body> } }`, endpoints inside the event's one object-valued field) or a
 * reduced row (`{ at, type, owner, ... }`).
 */
function parseCoordinationRows(text: string): { rows: CoordinationRow[]; invalid: number } {
  const rows: CoordinationRow[] = []
  let invalid = 0
  for (const line of jsonLines(text)) {
    const event = line === null ? null : (asRecord(line.event) ?? line)
    if (line === null || event === null || typeof event.type !== 'string') {
      invalid += 1
      continue
    }
    const body =
      event === line
        ? line
        : (Object.entries(event)
            .filter(([key]) => key !== 'type')
            .map(([, value]) => asRecord(value))
            .find((value) => value !== null) ?? {})
    const owner = typeof line.owner === 'string' ? line.owner : line.ownerId
    const row: CoordinationRow = {
      at: epochMs(line.at),
      type: event.type,
      owner: typeof owner === 'string' && owner ? owner : null,
    }
    for (const key of ['toWorker', 'from', 'by'] as const) {
      const value = body[key]
      if (typeof value === 'string') row[key] = value
    }
    const delivered = body.delivered ?? line.delivered
    if (typeof delivered === 'boolean') row.delivered = delivered
    rows.push(row)
  }
  return { rows, invalid }
}

/**
 * The team-shape analyst: one `team`-layer finding per run naming its class,
 * with the features and every class check in metadata. A record with no
 * timestamps fails the analyst instead of emitting a shape it did not measure.
 */
export function teamShapeAnalyst(): Analyst<TeamShapeInput> {
  return {
    id: TEAM_SHAPE_ANALYST_ID,
    description:
      'Classifies a supervision tree as single, governed swarm, fleet, partition, hive, star with sub-leads or flat star.',
    inputKind: 'custom',
    cost: { kind: 'deterministic' },
    version: TEAM_SHAPE_VERSION,
    async analyze(input) {
      const outcome = classifyTeamShape(input)
      if (!outcome.succeeded) throw new Error(`team-shape: ${outcome.error.message}`)
      const shape = outcome.value
      if (shape.window === null) {
        throw new Error(`team-shape: record for ${input.runRef} carries no event timestamps`)
      }
      return [
        makeFinding({
          analyst_id: TEAM_SHAPE_ANALYST_ID,
          area: 'team-shape',
          severity: 'info',
          confidence: 1,
          subject: shape.rootId,
          claim: `Team shape is ${shape.label}`,
          claim_id: `team-shape:${shape.class}`,
          evidence_refs: [{ kind: 'artifact', uri: input.runRef }],
          layer: 'team',
          scope: { population: [input.runRef], n: 1, window: shape.window },
          method: { kind: 'computed', name: TEAM_SHAPE_ANALYST_ID, version: TEAM_SHAPE_VERSION },
          metadata: {
            class: shape.class,
            depth: shape.depth,
            qualifier: shape.qualifier,
            features: shape.features,
            checks: shape.checks,
            edges: {
              command: shape.graph.command.length,
              governance: shape.graph.governance.length,
              communication: shape.graph.communication.length,
            },
            invalid_rows: shape.invalidRows,
          },
        }),
      ]
    },
  }
}
