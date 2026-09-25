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
import {
  EXPANSION_OPERATORS,
  type ExpansionOperator,
  type OperatorYieldSignal,
} from '../search/lenses/operator-yield'
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
  /** True when the node has a scored cell on `split` and none of its cells
   * there ran and ended unscored. A node that dodged a unit cannot lead; cells
   * still to run, such as a rung the allocator just opened, do not count. */
  complete(nodeId: string): boolean
  /** Per-unit means on `split`, in unitId order. */
  unitScores(nodeId: string): readonly SearchUnitScore[]
  /** The paired contrast of `nodeId` against `against` on `split`. */
  estimate(nodeId: string, against: string): NodeEstimate
  /** The `operatorYield` lens's signal (search-tree-design §12) on `split`:
   * an expandable operator's yield mean once it has enough measured
   * outcomes, else null. Recomputed for every view a policy is handed. */
  readonly operatorWeights: OperatorYieldSignal
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
 * The hill climb. The leader starts at the root; a screened node that dodged no
 * unit takes the lead when it scored every unit the leader scored and its mean
 * on them beats the leader's. A node measured on fewer units than the leader,
 * such as one an allocator has only screened, cannot take the lead on less
 * evidence than the leader holds. Nodes are taken in registration order, so
 * the leader is a pure function of the ledger. The policy expands the leader,
 * and only once every earlier child is screened, so each proposal sees every
 * result before it.
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
 * The hill climb (as `incumbent`), with its operator drawn from the
 * `operatorYield` lens instead of fixed at `improve` (search-tree-design
 * §12): a weighted draw, seeded from `seed` and the expansion index like
 * `crowdedFrontierParent`, over the lens's per-operator yield once every
 * expandable operator has enough measured outcomes to trust
 * (`view.operatorWeights[op] !== null` for all of them — the lens's own
 * `MIN_OUTCOMES_FOR_WEIGHT` gate). Until then every draw uses `fixedWeights`
 * (uniform by default), so a not-yet-tried operator is never starved before
 * it has been measured enough to earn a data-driven weight. A yield at or
 * below zero still gets a small positive share of the draw (never zero, so a
 * so-far-bad operator can still be re-measured) rather than being excluded.
 */
export function incumbentWithOperatorBandit(
  options: {
    patience?: number
    seed: number
    fixedWeights?: Partial<Record<ExpansionOperator, number>>
  } = { seed: 0 },
): SearchPolicy {
  const { patience, seed } = options
  if (!Number.isInteger(seed)) {
    throw new TypeError(`incumbentWithOperatorBandit: seed must be an integer, got ${String(seed)}`)
  }
  const fixedWeights: Record<ExpansionOperator, number> = {
    draft: options.fixedWeights?.draft ?? 1,
    improve: options.fixedWeights?.improve ?? 1,
    debug: options.fixedWeights?.debug ?? 1,
    merge: options.fixedWeights?.merge ?? 1,
  }
  for (const operator of EXPANSION_OPERATORS) {
    const weight = fixedWeights[operator]
    if (!Number.isFinite(weight) || weight < 0) {
      throw new TypeError(
        `incumbentWithOperatorBandit: fixedWeights.${operator} must be >= 0, got ${weight}`,
      )
    }
  }
  return hillClimb({
    name:
      patience === undefined
        ? `incumbent-operator-bandit(seed=${seed})`
        : `incumbent-operator-bandit(seed=${seed},patience=${patience})`,
    patience,
    parent: (_view, leader) => ({ nodeId: leader, evidence: {} }),
    operator: (view) => chooseOperator(view.operatorWeights, fixedWeights, seed, view.expansions),
  })
}

function chooseOperator(
  measured: OperatorYieldSignal,
  fixedWeights: Record<ExpansionOperator, number>,
  seed: number,
  expansionIndex: number,
): ExpansionOperator {
  const trusted = EXPANSION_OPERATORS.every((operator) => measured[operator] !== null)
  const weights = EXPANSION_OPERATORS.map((operator) =>
    trusted ? Math.max(measured[operator]!, 0) + 1e-6 : fixedWeights[operator],
  )
  const total = weights.reduce((a, b) => a + b, 0)
  const rng = mulberry32((seed ^ Math.imul(expansionIndex + 1, 0x9e3779b1)) | 0)
  let draw = rng() * total
  for (let index = 0; index < EXPANSION_OPERATORS.length; index++) {
    draw -= weights[index]!
    if (draw <= 0) return EXPANSION_OPERATORS[index]!
  }
  return EXPANSION_OPERATORS[EXPANSION_OPERATORS.length - 1]!
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
  /** Defaults to always `improve`, the prior behavior of every hill-climb
   * policy before the operator bandit. */
  operator?(view: SearchPolicyView): Exclude<SearchEdgeOperator, 'seed' | 'derive'>
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
        operator: spec.operator ? spec.operator(view) : 'improve',
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

/** True when `challenger` scored every unit `holder` scored and improves on
 * `holder` over them. */
function beats(view: SearchPolicyView, challenger: string, holder: string): boolean {
  const held = view.unitScores(holder)
  if (held.length === 0) return false
  const own = new Map(view.unitScores(challenger).map((unit) => [unit.unitId, unit.mean]))
  let challengerSum = 0
  let holderSum = 0
  for (const unit of held) {
    const mean = own.get(unit.unitId)
    if (mean === undefined) return false
    challengerSum += mean
    holderSum += unit.mean
  }
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
