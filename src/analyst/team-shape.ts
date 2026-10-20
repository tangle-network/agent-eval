/**
 * team-shape — classify how a supervision tree was organized, from the
 * Runtime spawn journal plus an optional coordination log.
 *
 * The tree becomes three edge sets over the same nodes:
 *   - E, command: parent spawned child (the spawn journal).
 *   - G, governance: one node judged or integrated another's output. Taken
 *     from `integrate` rows in the coordination log when it has any, else
 *     from the journal: a parent that settled its child governed it.
 *   - C, communication: messages. Coordination-log `message` rows, plus the
 *     steers (parent → worker) and questions (worker → parent) in worker logs.
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
  /**
   * Coordination log (JSONL), or null when none was kept. Rows:
   *   {"kind":"message","from":"<node id>","to":"<node id>"}
   *   {"kind":"integrate","from":"<integrator id>","to":"<node whose output it took>"}
   */
  coordination?: string | null
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
  /** Where governance edges came from. */
  governanceSource: 'coordination-log' | 'journal-settlements'
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

  const coordination = parseJsonl(input.coordination ?? null)
  const coordinationLines = (input.coordination ?? '')
    .split('\n')
    .filter((line) => line.trim()).length
  let coordinationInvalid = coordinationLines - coordination.length
  const communication = new Map<string, TeamShapeEdge>()
  const explicitGovernance = new Map<string, TeamShapeEdge>()
  for (const row of coordination) {
    const from = typeof row.from === 'string' && ids.has(row.from) ? row.from : null
    const to = typeof row.to === 'string' && ids.has(row.to) ? row.to : null
    if (from === null || to === null || (row.kind !== 'message' && row.kind !== 'integrate')) {
      coordinationInvalid += 1
      continue
    }
    addEdge(row.kind === 'message' ? communication : explicitGovernance, from, to)
  }
  const spawnByLabel = new Map(spawns.map((spawn) => [spawn.label, spawn.id]))
  for (const log of tree.workerLogRows) {
    const node =
      log.workerId !== null && ids.has(log.workerId) ? log.workerId : spawnByLabel.get(log.label)
    const parent = node === undefined ? null : (parentOf.get(node) ?? null)
    if (node === undefined || parent === null) continue
    for (let i = 0; i < log.steerRequests.length; i += 1) addEdge(communication, parent, node)
    for (let i = 0; i < log.questions; i += 1) addEdge(communication, node, parent)
  }

  let governance = explicitGovernance
  let governanceSource: TeamShape['governanceSource'] = 'coordination-log'
  if (explicitGovernance.size === 0) {
    governanceSource = 'journal-settlements'
    governance = new Map()
    for (const close of tree.closes) {
      if (close.kind !== 'settled') continue
      const parent = parentOf.get(close.id)
      if (parent !== null && parent !== undefined) addEdge(governance, parent, close.id)
    }
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
      governanceSource,
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
            governance_source: shape.governanceSource,
            invalid_rows: { ...shape.invalidRows },
          },
        }),
      ]
    },
  }
}
