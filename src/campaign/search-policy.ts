/**
 * Expansion policies: which node a search expands next, with which operator,
 * and which node it currently keeps.
 *
 * A policy reads a `SearchPolicyView`: nodes whose screen finished and their
 * per-unit scores on the policy's split. The view holds no test cells, so a
 * policy cannot see the sealed claim data. Its decisions spend budget and
 * claim nothing; a claim comes only from the sealed test split.
 */

import { type Objective, paretoFrontierWithCrowding } from '../pareto'
import { mulberry32 } from '../statistics/random'
import type { NodeEstimate, SearchEdgeOperator } from './search-ledger-types'
import type { SearchUnitScore } from './search-state'

/** What a policy may read about a search. */
export interface SearchPolicyView {
  readonly searchId: string
  readonly seed: number
  readonly direction: 'maximize' | 'minimize'
  /** The split nodes are ranked on: selection, or train when the search
   * declares no selection split (the proposer's own feedback then ranks). */
  readonly split: 'selection' | 'train'
  readonly rootNodeId: string
  /** Proposals completed so far. One an interrupted process lost does not count. */
  readonly expansions: number
  /** Admitted nodes whose screen finished, in registration order, root first. */
  readonly screened: readonly string[]
  /** Admitted nodes still being screened. */
  readonly screening: number
  /** True when the node scored every unit its screen allocated on `split`.
   * A node that dodged a unit (an unscored cell) cannot lead. */
  complete(nodeId: string): boolean
  /** Per-unit means on `split`, in unitId order. */
  unitScores(nodeId: string): readonly SearchUnitScore[]
  /** The paired contrast of `nodeId` against `against` on `split`. */
  estimate(nodeId: string, against: string): NodeEstimate
}

/** One expansion: the parents a proposer derives a child from, and how. */
export interface SearchExpansion {
  parents: string[]
  operator: Exclude<SearchEdgeOperator, 'seed' | 'derive'>
  /** Why these parents: recorded on every edge the expansion produces. */
  selection: { rule: string; evidence: Record<string, number> }
}

export interface SearchPolicy {
  /** Recorded as the search's `policy.expansion`. */
  readonly name: string
  /** Stop after this many expansions without a new leader. */
  readonly patience?: number
  /** The next expansion, or null to wait for more evidence. */
  expand(view: SearchPolicyView): SearchExpansion | null
  /** The node the search keeps if it stopped now. */
  leader(view: SearchPolicyView): string
}

/**
 * The hill climb. The leader starts at the root; a screened node that scored
 * every unit of its screen takes the lead when its mean on the units it shares
 * with the leader beats the leader's mean on those units. Nodes are taken in
 * registration order, so the leader is a pure function of the ledger. The
 * policy expands the leader, and only once every earlier child is screened,
 * so each proposal sees every result before it.
 */
export function incumbent(options: { patience?: number } = {}): SearchPolicy {
  const { patience } = options
  if (patience !== undefined && (!Number.isSafeInteger(patience) || patience < 1)) {
    throw new TypeError(`incumbent: patience must be a positive integer, got ${String(patience)}`)
  }
  return hillClimb({
    name: patience === undefined ? 'incumbent' : `incumbent(patience=${patience})`,
    patience,
    parent: (_view, leader) => ({ nodeId: leader, evidence: {} }),
  })
}

/**
 * The hill climb with a different parent: each expansion draws two distinct
 * members of the Pareto frontier (per-unit means on the policy split) with a
 * PRNG seeded from `seed` and the expansion index, and keeps the one with the
 * larger crowding distance, the more isolated. Boundary members carry infinite
 * distance. Ties fall to the higher mean, then to the earlier node. The leader
 * rule is the incumbent's: a frontier parent explores, and only a node that
 * beats the leader leads.
 */
export function crowdedFrontierParent(options: { seed: number }): SearchPolicy {
  const { seed } = options
  if (!Number.isInteger(seed)) {
    throw new TypeError(`crowdedFrontierParent: seed must be an integer, got ${String(seed)}`)
  }
  return hillClimb({
    name: `crowded-frontier(seed=${seed})`,
    parent: (view, leader): { nodeId: string; evidence: Record<string, number> } => {
      const frontier = paretoMembers(view)
      if (frontier.length <= 1) return { nodeId: frontier[0]?.nodeId ?? leader, evidence: {} }
      const rng = mulberry32((seed ^ Math.imul(view.expansions + 1, 0x9e3779b1)) | 0)
      const first = Math.floor(rng() * frontier.length)
      const offset = Math.floor(rng() * (frontier.length - 1))
      const second = offset >= first ? offset + 1 : offset
      const a = frontier[first]!
      const b = frontier[second]!
      const winner = compareCrowded(a, b) <= 0 ? a : b
      return {
        nodeId: winner.nodeId,
        evidence: {
          frontierSize: frontier.length,
          crowding: Number.isFinite(winner.distance) ? winner.distance : -1,
        },
      }
    },
  })
}

interface FrontierMember {
  nodeId: string
  ordinal: number
  mean: number
  objectives: ReadonlyMap<string, number>
  distance: number
}

function hillClimb(spec: {
  name: string
  patience?: number
  parent(
    view: SearchPolicyView,
    leader: string,
  ): { nodeId: string; evidence: Record<string, number> }
}): SearchPolicy {
  const leader = (view: SearchPolicyView): string => {
    let current = view.rootNodeId
    for (const nodeId of view.screened) {
      if (nodeId === current || !view.complete(nodeId)) continue
      if (beats(view, nodeId, current)) current = nodeId
    }
    return current
  }
  return {
    name: spec.name,
    ...(spec.patience === undefined ? {} : { patience: spec.patience }),
    leader,
    expand(view) {
      if (view.screening > 0) return null
      const kept = leader(view)
      const chosen = spec.parent(view, kept)
      const units = view.unitScores(chosen.nodeId)
      return {
        parents: [chosen.nodeId],
        operator: 'improve',
        selection: {
          rule: spec.name,
          evidence: {
            ...chosen.evidence,
            units: units.length,
            ...(units.length > 0 ? { mean: mean(units.map((unit) => unit.mean)) } : {}),
            isLeader: chosen.nodeId === kept ? 1 : 0,
          },
        },
      }
    },
  }
}

/** True when `challenger` improves on `holder` over the units both scored. */
function beats(view: SearchPolicyView, challenger: string, holder: string): boolean {
  const held = new Map(view.unitScores(holder).map((unit) => [unit.unitId, unit.mean]))
  let challengerSum = 0
  let holderSum = 0
  let shared = 0
  for (const unit of view.unitScores(challenger)) {
    const other = held.get(unit.unitId)
    if (other === undefined) continue
    challengerSum += unit.mean
    holderSum += other
    shared += 1
  }
  if (shared === 0) return false
  return view.direction === 'maximize' ? challengerSum > holderSum : challengerSum < holderSum
}

/** Non-dominated complete screened nodes over the root's units, with crowding. */
function paretoMembers(view: SearchPolicyView): FrontierMember[] {
  const units = view.unitScores(view.rootNodeId).map((unit) => unit.unitId)
  const sign = view.direction === 'maximize' ? 1 : -1
  const members: FrontierMember[] = []
  view.screened.forEach((nodeId, ordinal) => {
    if (!view.complete(nodeId)) return
    const objectives = new Map(view.unitScores(nodeId).map((unit) => [unit.unitId, unit.mean]))
    if (units.some((unit) => !objectives.has(unit))) return
    members.push({
      nodeId,
      ordinal,
      mean: sign * mean([...objectives.values()]),
      objectives,
      distance: 0,
    })
  })
  if (members.length === 0 || units.length === 0) return members
  const axes: Objective<FrontierMember>[] = units.map((unit) => ({
    name: unit,
    direction: view.direction,
    value: (member) => member.objectives.get(unit)!,
  }))
  return paretoFrontierWithCrowding(members, axes).map(({ candidate, distance }) => ({
    ...candidate,
    distance,
  }))
}

/** Negative when `a` wins the tournament. */
function compareCrowded(a: FrontierMember, b: FrontierMember): number {
  if (a.distance !== b.distance) return a.distance > b.distance ? -1 : 1
  if (a.mean !== b.mean) return a.mean > b.mean ? -1 : 1
  return a.ordinal - b.ordinal
}

function mean(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total / values.length
}
