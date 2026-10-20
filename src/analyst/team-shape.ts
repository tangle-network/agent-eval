/**
 * team-shape — classify how a supervision tree was organized, from the
 * sources the supervisor-run readers return: the spawn journal and, for a
 * Runtime run, its `coordination-log.jsonl`.
 *
 * The tree becomes three edge sets over the same nodes:
 *   - E, command: parent spawned child (the spawn journal).
 *   - G, governance: a parent that settled its child governed it (journal
 *     settlements). No Runtime record names an integrator other than the
 *     parent, so a depth-1 team always has root integration share 1.
 *   - C, communication: delivered peer mail (worker → sibling), delivered
 *     steers and answers (parent → worker) and questions (worker → parent).
 *     Taken from the coordination log when the store keeps one, else from the
 *     steers and questions in worker logs.
 *
 * Classes are decided by ordered rules, so no graph gets two:
 *   1. single     — no node besides the root.
 *   2. partition  — more than one command root: disjoint teams, no commander.
 *   3. swarm      — at least half the messages run between nodes with no
 *                   command edge between them (peers coordinate directly).
 *   4. hive       — command depth ≥ 2: leads with their own reports.
 *   5. flat-star  — depth 1 and the root holds at least half the governance
 *                   edges (the root integrates).
 *   6. fleet      — depth 1 and the workers' output is integrated elsewhere.
 * The thresholds are `TEAM_SHAPE_THRESHOLDS`. They encode the E/G/C class
 * definitions as far as this package has them; recalibrate against the
 * 2026-10-20 definitions before reading a fleet/swarm boundary as settled.
 */

import { analyzeSupervisorRunSources } from '../supervisor-run/analyze'
import { parseJsonl, parseSupervisorTree } from '../supervisor-run/source-facts'
import { isUnavailable, type SupervisorRunSources } from '../supervisor-run/types'
import type { Analyst } from './types'
import { makeFinding } from './types'

export const TEAM_SHAPE_ANALYST_ID = 'team-shape'
export const TEAM_SHAPE_VERSION = '1'

export const TEAM_SHAPE_CLASSES = [
  'single',
  'partition',
  'swarm',
  'hive',
  'flat-star',
  'fleet',
] as const

export type TeamShapeClass = (typeof TEAM_SHAPE_CLASSES)[number]

export const TEAM_SHAPE_THRESHOLDS = {
  /** Peer share of messages at or above which the team is a swarm. */
  swarmPeerMessageShare: 0.5,
  /** Root share of governance edges at or above which a depth-1 team is a flat star. */
  starRootIntegrationShare: 0.5,
} as const

export interface TeamShapeInput {
  sources: SupervisorRunSources
}

export interface TeamShapeEdge {
  from: string
  to: string
  count: number
}

export interface TeamShapeFeatures {
  /** Valid spawned nodes, root included. */
  nodes: number
  /** Nodes other than command roots: the tasks handed out. */
  tasks: number
  /** Longest command chain below a root, in hops. */
  depth: number
  /** Most direct reports any node has. */
  fanOut: number
  rootFanOut: number
  /** Spawns that repeat a label the same parent already spawned. */
  reHires: number
  /** Root's share of governance edges; null when no node governed another. */
  rootIntegrationShare: number | null
  /** Messages per task; null when there are no tasks. */
  messagesPerTask: number | null
  /** Share of messages between nodes with no command edge between them; null with no messages. */
  peerMessageShare: number | null
  /** Share of supervisor wall time with no worker running; null when the journal cannot say. */
  idleShare: number | null
  commandRoots: number
}

export interface TeamShape {
  class: TeamShapeClass
  /** Class in words, with the depth for a hive: `hive depth 2`. */
  label: string
  rootId: string
  features: TeamShapeFeatures
  graph: { command: TeamShapeEdge[]; governance: TeamShapeEdge[]; communication: TeamShapeEdge[] }
  /** Where communication edges came from. */
  communicationSource: 'coordination-log' | 'worker-logs'
  /** Journal and coordination rows that could not be read. */
  invalidRows: { journal: number; spawns: number; coordination: number }
  window: { from: string; to: string } | null
}

export type TeamShapeOutcome =
  | { succeeded: true; value: TeamShape }
  | { succeeded: false; error: { message: string } }

export function classifyTeamShape(input: TeamShapeInput): TeamShapeOutcome {
  const { sources } = input
  if (sources.journal === null) {
    return {
      succeeded: false,
      error: { message: sources.journalMissingReason ?? `no spawn journal for ${sources.runRef}` },
    }
  }
  const tree = parseSupervisorTree(sources)
  const spawns = tree.spawns.filter((spawn) => spawn.valid)
  if (spawns.length === 0) {
    return {
      succeeded: false,
      error: { message: `spawn journal for ${sources.runRef} has no valid spawn` },
    }
  }
  const ids = new Set(spawns.map((spawn) => spawn.id))
  const parentOf = new Map<string, string | null>(
    spawns.map((spawn) => [
      spawn.id,
      spawn.parent !== null && ids.has(spawn.parent) ? spawn.parent : null,
    ]),
  )
  const roots = spawns.filter((spawn) => parentOf.get(spawn.id) === null).map((spawn) => spawn.id)
  const rootId = tree.rootId ?? roots[0]!

  const command = new Map<string, TeamShapeEdge>()
  const children = new Map<string, number>()
  const labelsByParent = new Map<string, Set<string>>()
  let reHires = 0
  for (const spawn of spawns) {
    const parent = parentOf.get(spawn.id)
    if (parent === null || parent === undefined) continue
    addEdge(command, parent, spawn.id)
    children.set(parent, (children.get(parent) ?? 0) + 1)
    const labels = labelsByParent.get(parent) ?? new Set<string>()
    if (labels.has(spawn.label)) reHires += 1
    labels.add(spawn.label)
    labelsByParent.set(parent, labels)
  }
  let depth = 0
  for (const spawn of spawns) {
    let hops = 0
    let current = parentOf.get(spawn.id) ?? null
    const seen = new Set([spawn.id])
    while (current !== null && !seen.has(current)) {
      seen.add(current)
      hops += 1
      current = parentOf.get(current) ?? null
    }
    depth = Math.max(depth, hops)
  }

  const communication = new Map<string, TeamShapeEdge>()
  let coordinationInvalid = 0
  const communicationSource: TeamShape['communicationSource'] =
    typeof sources.coordinationLog === 'string' ? 'coordination-log' : 'worker-logs'
  if (typeof sources.coordinationLog === 'string') {
    const rows = sources.coordinationLog.split('\n').filter((line) => line.trim())
    const records = parseJsonl(sources.coordinationLog)
    coordinationInvalid = rows.length - records.length
    for (const record of records) {
      const edge = coordinationEdge(record.event, parentOf)
      if (edge === 'unread') coordinationInvalid += 1
      else if (edge !== null && ids.has(edge.from) && ids.has(edge.to)) {
        addEdge(communication, edge.from, edge.to)
      }
    }
  } else {
    const spawnByLabel = new Map(spawns.map((spawn) => [spawn.label, spawn.id]))
    for (const log of tree.workerLogRows) {
      const node =
        log.workerId !== null && ids.has(log.workerId) ? log.workerId : spawnByLabel.get(log.label)
      const parent = node === undefined ? null : (parentOf.get(node) ?? null)
      if (node === undefined || parent === null) continue
      for (let i = 0; i < log.steerRequests.length; i += 1) addEdge(communication, parent, node)
      for (let i = 0; i < log.questions; i += 1) addEdge(communication, node, parent)
    }
  }

  const governance = new Map<string, TeamShapeEdge>()
  for (const close of tree.closes) {
    if (close.kind !== 'settled') continue
    const parent = parentOf.get(close.id)
    if (parent !== null && parent !== undefined) addEdge(governance, parent, close.id)
  }

  const tasks = spawns.length - roots.length
  const totalMessages = sum(communication)
  const peerMessages = [...communication.values()]
    .filter((edge) => parentOf.get(edge.to) !== edge.from && parentOf.get(edge.from) !== edge.to)
    .reduce((total, edge) => total + edge.count, 0)
  const totalGovernance = sum(governance)
  const rootGovernance = [...governance.values()]
    .filter((edge) => edge.from === rootId)
    .reduce((total, edge) => total + edge.count, 0)
  const idlePct = analyzeSupervisorRunSources(sources).orchestration.idlePct
  const features: TeamShapeFeatures = {
    nodes: spawns.length,
    tasks,
    depth,
    fanOut: Math.max(0, ...children.values()),
    rootFanOut: children.get(rootId) ?? 0,
    reHires,
    rootIntegrationShare: totalGovernance === 0 ? null : rootGovernance / totalGovernance,
    messagesPerTask: tasks === 0 ? null : totalMessages / tasks,
    peerMessageShare: totalMessages === 0 ? null : peerMessages / totalMessages,
    idleShare: isUnavailable(idlePct) ? null : idlePct / 100,
    commandRoots: roots.length,
  }
  const shapeClass = classOf(features)
  return {
    succeeded: true,
    value: {
      class: shapeClass,
      label: shapeClass === 'hive' ? `hive depth ${depth}` : shapeClass,
      rootId,
      features,
      graph: {
        command: [...command.values()],
        governance: [...governance.values()],
        communication: [...communication.values()],
      },
      communicationSource,
      invalidRows: {
        journal: tree.journalInvalidRows,
        spawns: tree.spawns.length - spawns.length,
        coordination: coordinationInvalid,
      },
      window:
        tree.firstEventAt === null || tree.lastEventAt === null
          ? null
          : {
              from: new Date(tree.firstEventAt).toISOString(),
              to: new Date(tree.lastEventAt).toISOString(),
            },
    },
  }
}

function classOf(features: TeamShapeFeatures): TeamShapeClass {
  if (features.tasks === 0) return 'single'
  if (features.commandRoots > 1) return 'partition'
  if (
    features.peerMessageShare !== null &&
    features.peerMessageShare >= TEAM_SHAPE_THRESHOLDS.swarmPeerMessageShare
  ) {
    return 'swarm'
  }
  if (features.depth >= 2) return 'hive'
  if (
    features.rootIntegrationShare !== null &&
    features.rootIntegrationShare < TEAM_SHAPE_THRESHOLDS.starRootIntegrationShare
  ) {
    return 'fleet'
  }
  return 'flat-star'
}

/**
 * The communication edge one Runtime `CoordinationEvent` records, null for
 * kinds that carry no message between nodes, and `unread` for a message kind
 * whose sender or recipient is not a string. Undelivered mail and steers are
 * refused attempts, not communication.
 */
function coordinationEdge(
  event: unknown,
  parentOf: ReadonlyMap<string, string | null>,
): { from: string; to: string } | null | 'unread' {
  if (typeof event !== 'object' || event === null) return 'unread'
  const row = event as Record<string, unknown>
  const field = (value: unknown, key: string): unknown =>
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined
  const toParent = (child: unknown) => {
    if (typeof child !== 'string') return 'unread' as const
    const parent = parentOf.get(child)
    return parent ? { from: child, to: parent } : null
  }
  const fromParent = (child: unknown) => {
    const edge = toParent(child)
    return edge === null || edge === 'unread' ? edge : { from: edge.to, to: edge.from }
  }
  switch (row.type) {
    case 'mail': {
      const mail = row.mail
      const envelope = field(mail, 'envelope')
      const from = field(envelope, 'from')
      const to = field(envelope, 'to')
      if (typeof from !== 'string' || typeof to !== 'string') return 'unread'
      return field(mail, 'delivered') === true ? { from, to } : null
    }
    case 'steer':
    case 'answer':
      return field(row.down, 'delivered') === true ? fromParent(field(row.down, 'toWorker')) : null
    case 'question':
      return toParent(field(row.question, 'from'))
    default:
      return null
  }
}

function addEdge(edges: Map<string, TeamShapeEdge>, from: string, to: string): void {
  const key = JSON.stringify([from, to])
  const edge = edges.get(key)
  if (edge) edge.count += 1
  else edges.set(key, { from, to, count: 1 })
}

function sum(edges: ReadonlyMap<string, TeamShapeEdge>): number {
  let total = 0
  for (const edge of edges.values()) total += edge.count
  return total
}

/**
 * The team-shape analyst: one `team`-layer finding per run naming its class,
 * with the features and edge counts in metadata. A run whose journal is
 * missing or carries no timestamps fails the analyst instead of emitting a
 * shape it did not measure.
 */
export function teamShapeAnalyst(): Analyst<TeamShapeInput> {
  return {
    id: TEAM_SHAPE_ANALYST_ID,
    description:
      'Classifies a supervision tree as single, flat star, hive, fleet, swarm or partition.',
    inputKind: 'custom',
    cost: { kind: 'deterministic' },
    version: TEAM_SHAPE_VERSION,
    async analyze(input) {
      const outcome = classifyTeamShape(input)
      if (!outcome.succeeded) throw new Error(`team-shape: ${outcome.error.message}`)
      const shape = outcome.value
      if (shape.window === null) {
        throw new Error(
          `team-shape: journal for ${input.sources.runRef} carries no event timestamps`,
        )
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
          evidence_refs: [{ kind: 'artifact', uri: input.sources.runRef }],
          layer: 'team',
          scope: { population: [shape.rootId], n: 1, window: shape.window },
          method: { kind: 'computed', name: TEAM_SHAPE_ANALYST_ID, version: TEAM_SHAPE_VERSION },
          metadata: {
            class: shape.class,
            features: { ...shape.features },
            edges: {
              command: shape.graph.command.length,
              governance: shape.graph.governance.length,
              communication: shape.graph.communication.length,
            },
            communication_source: shape.communicationSource,
            invalid_rows: { ...shape.invalidRows },
          },
        }),
      ]
    },
  }
}
