/**
 * Expansion policies: which node a search expands next, with which operator,
 * and which node it currently keeps.
 *
 * A policy reads a `SearchPolicyView`: the nodes, their lineage, their
 * per-unit scores and posterior on the policy's split, and how many of their
 * cells failed as defects. The view holds no test cells, so a policy cannot
 * see the sealed claim data. Its decisions spend budget and claim nothing; a
 * claim comes only from the sealed test split.
 *
 * `incumbent` and `crowdedFrontierParent` are hill climbs and pair with the
 * `uniform` allocator. `aide` and `beam` choose parents from each node's
 * posterior, which is honest about a node measured on few units, so they pair
 * with `asha`, which measures most nodes on only the first rung.
 */

import { type Objective, paretoFrontierWithCrowding } from '../pareto'
import { mulberry32 } from '../statistics/random'
import type { SearchPosterior } from './estimate-node'
import type { NodeEstimate, SearchEdgeOperator, SearchNodeStatus } from './search-ledger-types'
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
  /** Every node whose edge is recorded, in registration order, root first:
   * nodes still being screened and nodes decided invalid included. */
  nodes(): readonly SearchPolicyNode[]
  /** Each node's normal posterior on its improvement over the root on
   * `split` (`searchPosterior`), computed once per ledger state. */
  readonly posterior: SearchPosterior
}

/** What a policy may read about one node. */
export interface SearchPolicyNode {
  readonly nodeId: string
  readonly ordinal: number
  /** The primary parent; null for the root. */
  readonly parent: string | null
  /** The operator of the edge that placed the node: `seed` for the root. */
  readonly operator: SearchEdgeOperator
  /** The rule that chose the node's parent (that edge's `selection.rule`);
   * null when the edge records none. */
  readonly rule: string | null
  /** Nodes placed from this one, in registration order. */
  readonly children: readonly string[]
  /** The node's latest decision; null while undecided. */
  readonly status: SearchNodeStatus | null
  /** Its cells outside the test split whose outcome is final: passed or failed. */
  readonly outcomes: number
  /** Of those, the cells that failed: the agent's defect, such as a crash, a
   * broken build or a judge integrity flag. An `errored` cell is the
   * environment's fault and never counts. */
  readonly defects: number
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

export interface AideOptions {
  /** Children of the root drafted as whole alternatives before the policy
   * debugs or improves. Default 5. */
  drafts?: number
  /** The chance an expansion debugs a buggy leaf when one exists. Default 0.5. */
  debugProbability?: number
  /** Debug edges in a row that one chain may hold. Default 3. */
  maxDebugDepth?: number
  /** Improve children in a row that leave their lineage's best posterior mean
   * unraised before the lineage counts as stalled. Default 4. */
  stallAfter?: number
}

/**
 * AIDE's search policy (`aide/agent.py`, `search_policy`) with three changes
 * for noisy scores.
 *
 * 1. **Draft** while fewer than `drafts` nodes were drafted: the root is the
 *    parent, and the proposer writes a whole alternative, not an edit.
 * 2. **Debug**, with probability `debugProbability`: a buggy leaf, drawn
 *    uniformly, whose chain holds fewer than `maxDebugDepth` debug edges. A
 *    node is buggy when at least half of its final cells outside the test
 *    split failed: defects, not a low score. An `errored` cell is the
 *    environment's fault; it is retried and never makes a node buggy.
 * 3. **Improve** otherwise. The parent is drawn by Thompson sampling, not
 *    AIDE's argmax, from every screened node that is not buggy and has a
 *    posterior (`searchPosterior`): the root sits at 0, and every other node
 *    at its mean improvement over the root with the search's pooled
 *    between-unit variance divided by its shared units, so a node measured on
 *    few units draws from a wide posterior. Until some node shares 2 units
 *    with the root the pooled variance is unknown, every posterior is as wide
 *    as it can be, and the draw is uniform. With no such node, the policy
 *    drafts.
 * 4. **Stall:** when the drawn parent's lineage (the nodes under its nearest
 *    draft, or under the root) has had `stallAfter` improve children in a row
 *    that did not raise the lineage's best posterior mean, the improve forks
 *    from the node with the best posterior mean instead. This is AIDE²'s
 *    inner policy. A fork's children restart the run of the lineage they
 *    join, so a stalled lineage that holds the global best forks once, not
 *    on every later expansion.
 *
 * A parent is always a node whose screen finished; a node refused at
 * admission or decided invalid never is. Draws come from a PRNG seeded by the
 * search seed and the count of completed expansions, so the policy is a pure
 * function of the ledger. The leader is the incumbent's.
 */
export function aide(options: AideOptions = {}): SearchPolicy {
  const drafts = integerOption('aide', 'drafts', options.drafts ?? 5, 0)
  const debugProbability = options.debugProbability ?? 0.5
  if (!(debugProbability >= 0 && debugProbability <= 1)) {
    throw new TypeError(
      `aide: debugProbability must be in [0, 1], got ${String(options.debugProbability)}`,
    )
  }
  const maxDebugDepth = integerOption('aide', 'maxDebugDepth', options.maxDebugDepth ?? 3, 0)
  const stallAfter = integerOption('aide', 'stallAfter', options.stallAfter ?? 4, 1)
  const name =
    drafts === 5 && debugProbability === 0.5 && maxDebugDepth === 3 && stallAfter === 4
      ? 'aide'
      : `aide(drafts=${drafts},debug=${debugProbability},maxDebugDepth=${maxDebugDepth},stallAfter=${stallAfter})`
  return {
    name,
    leader: leaderOf,
    expand(view) {
      const root = view.rootNodeId
      const screened = new Set(view.screened)
      if (!screened.has(root)) return null
      const nodes = view.nodes()
      const byId = new Map(nodes.map((node) => [node.nodeId, node]))
      const rng = mulberry32(
        (view.seed ^ Math.imul(view.expansions + 1, 0x9e3779b1) ^ AIDE_SALT) | 0,
      )
      const drafted = nodes.filter((node) => node.operator === 'draft').length
      const draft = (evidence: Record<string, number>): SearchExpansion => ({
        parents: [root],
        operator: 'draft',
        selection: { rule: `${name}:draft`, evidence: { drafted, drafts, ...evidence } },
      })
      if (drafted < drafts) return draft({})

      if (rng() < debugProbability) {
        const debuggable = nodes.filter(
          (node) =>
            screened.has(node.nodeId) &&
            buggy(node) &&
            node.children.length === 0 &&
            debugDepth(node, byId) < maxDebugDepth,
        )
        if (debuggable.length > 0) {
          const pick = debuggable[Math.floor(rng() * debuggable.length)]!
          return {
            parents: [pick.nodeId],
            operator: 'debug',
            selection: {
              rule: `${name}:debug`,
              evidence: {
                debuggable: debuggable.length,
                defects: pick.defects,
                outcomes: pick.outcomes,
                debugDepth: debugDepth(pick, byId),
              },
            },
          }
        }
      }

      const posterior = new Map(view.posterior.nodes.map((entry) => [entry.nodeId, entry]))
      const good = nodes.filter(
        (node) =>
          screened.has(node.nodeId) &&
          !buggy(node) &&
          (posterior.get(node.nodeId)?.mean ?? null) !== null,
      )
      if (good.length === 0) return draft({ good: 0 })
      const meanOf = (node: SearchPolicyNode): number => posterior.get(node.nodeId)!.mean!
      const known = view.posterior.pooledVariance !== null
      let drawn = good[0]!
      let draw = Number.NEGATIVE_INFINITY
      if (!known) {
        drawn = good[Math.floor(rng() * good.length)]!
      } else {
        for (const node of good) {
          const value =
            meanOf(node) + Math.sqrt(posterior.get(node.nodeId)!.variance!) * normal(rng)
          if (value > draw) {
            draw = value
            drawn = node
          }
        }
      }
      const stalled = stalledRun(drawn, nodes, screened, posterior, `${name}:stall-fork`)
      if (stalled >= stallAfter) {
        let best = good[0]!
        for (const node of good) if (meanOf(node) > meanOf(best)) best = node
        return {
          parents: [best.nodeId],
          operator: 'improve',
          selection: {
            rule: `${name}:stall-fork`,
            evidence: {
              candidates: good.length,
              mean: plain(meanOf(best)),
              units: posterior.get(best.nodeId)!.pairs,
              drawnOrdinal: drawn.ordinal,
              stalledChildren: stalled,
            },
          },
        }
      }
      const entry = posterior.get(drawn.nodeId)!
      return {
        parents: [drawn.nodeId],
        operator: 'improve',
        selection: {
          rule: `${name}:${known ? 'thompson' : 'uniform-draw'}`,
          evidence: {
            candidates: good.length,
            mean: plain(entry.mean!),
            units: entry.pairs,
            ...(known ? { sd: plain(Math.sqrt(entry.variance!)), draw: plain(draw) } : {}),
          },
        },
      }
    },
  }
}

/**
 * Beam search: the beam is the top `width` nodes by posterior mean
 * (`searchPosterior`), and the member with the fewest children is expanded,
 * so each member is expanded in turn, as in a generation of `width`. A member
 * is the root, a node an allocator advanced, or a node that scored every unit
 * the root scored: a node an allocator has only screened waits for its rank
 * before it enters. Ties go to the higher mean, then to the earlier node. The
 * leader is the incumbent's. Strategy evolution is `beam` with its population
 * as the width.
 */
export function beam(options: { width: number }): SearchPolicy {
  const width = integerOption('beam', 'width', options.width, 1)
  const name = `beam(width=${width})`
  return {
    name,
    leader: leaderOf,
    expand(view) {
      const root = view.rootNodeId
      const screened = new Set(view.screened)
      if (!screened.has(root)) return null
      const posterior = new Map(view.posterior.nodes.map((entry) => [entry.nodeId, entry.mean]))
      const rootUnits = view.unitScores(root).map((unit) => unit.unitId)
      const members = view
        .nodes()
        .filter(
          (node) =>
            screened.has(node.nodeId) &&
            (posterior.get(node.nodeId) ?? null) !== null &&
            (node.nodeId === root ||
              node.status === 'advanced' ||
              scoredEvery(view, node.nodeId, rootUnits)),
        )
        .sort(
          (left, right) =>
            posterior.get(right.nodeId)! - posterior.get(left.nodeId)! ||
            left.ordinal - right.ordinal,
        )
        .slice(0, width)
      let rank = 0
      members.forEach((member, index) => {
        if (member.children.length < members[rank]!.children.length) rank = index
      })
      const pick = members[rank]!
      return {
        parents: [pick.nodeId],
        operator: 'improve',
        selection: {
          rule: name,
          evidence: {
            rank: rank + 1,
            members: members.length,
            mean: plain(posterior.get(pick.nodeId)!),
            children: pick.children.length,
          },
        },
      }
    },
  }
}

/** Salts the aide PRNG, so its draws differ from `crowdedFrontierParent`'s at one seed. */
const AIDE_SALT = 0x41494445

/** At least half of the node's final cells failed as defects. */
function buggy(node: SearchPolicyNode): boolean {
  return node.outcomes > 0 && 2 * node.defects >= node.outcomes
}

/** Debug edges in a row ending at `node`. */
function debugDepth(node: SearchPolicyNode, byId: ReadonlyMap<string, SearchPolicyNode>): number {
  let depth = 0
  let current: SearchPolicyNode | undefined = node
  while (current?.operator === 'debug') {
    depth += 1
    current = current.parent === null ? undefined : byId.get(current.parent)
  }
  return depth
}

/**
 * Improve children in a row, in registration order, that did not raise the
 * best posterior mean of `node`'s lineage: the nodes under its nearest draft,
 * or under the root. Only screened nodes with a posterior count, and a child
 * placed by `forkRule` restarts the run.
 */
function stalledRun(
  node: SearchPolicyNode,
  nodes: readonly SearchPolicyNode[],
  screened: ReadonlySet<string>,
  posterior: ReadonlyMap<string, { mean: number | null }>,
  forkRule: string,
): number {
  // A node's lineage head: itself when a draft, a seed or a derive placed it,
  // else its parent's head. Parents register first, so one pass in
  // registration order resolves every head.
  const heads = new Map<string, string>()
  for (const entry of nodes) {
    const parentHead = entry.parent === null ? undefined : heads.get(entry.parent)
    const starts =
      entry.operator === 'draft' ||
      entry.operator === 'seed' ||
      entry.operator === 'derive' ||
      parentHead === undefined
    heads.set(entry.nodeId, starts ? entry.nodeId : parentHead)
  }
  const headOf = (entry: SearchPolicyNode): string => heads.get(entry.nodeId)!
  const lineage = headOf(node)
  let best = Number.NEGATIVE_INFINITY
  let run = 0
  for (const entry of nodes) {
    const mean = posterior.get(entry.nodeId)?.mean ?? null
    if (mean === null || !screened.has(entry.nodeId) || headOf(entry) !== lineage) continue
    if (entry.rule === forkRule) run = 0
    else if (entry.operator === 'improve') run = mean > best ? 0 : run + 1
    best = Math.max(best, mean)
  }
  return run
}

/** True when the node scored every one of `units`. */
function scoredEvery(view: SearchPolicyView, nodeId: string, units: readonly string[]): boolean {
  if (units.length === 0 || !view.complete(nodeId)) return false
  const own = new Set(view.unitScores(nodeId).map((unit) => unit.unitId))
  return units.every((unit) => own.has(unit))
}

/** A standard normal draw (Box-Muller). */
function normal(rng: () => number): number {
  const radius = Math.sqrt(-2 * Math.log(1 - rng()))
  return radius * Math.cos(2 * Math.PI * rng())
}

function integerOption(owner: string, name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `${owner}: ${name} must be an integer of at least ${minimum}, got ${String(value)}`,
    )
  }
  return value
}

/** Evidence is canonical JSON, which has one zero. */
function plain(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9
  return rounded === 0 ? 0 : rounded
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
  return {
    name: spec.name,
    ...(spec.patience === undefined ? {} : { patience: spec.patience }),
    leader: leaderOf,
    expand(view) {
      if (view.screening > 0) return null
      const kept = leaderOf(view)
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

/**
 * The leader every built-in policy keeps: it starts at the root, and a
 * screened node that dodged no unit takes the lead when it scored every unit
 * the leader scored and its mean on them beats the leader's. Nodes are taken
 * in registration order, so the leader is a pure function of the ledger. A
 * node an allocator has only screened cannot take the lead from one measured
 * on more units.
 */
function leaderOf(view: SearchPolicyView): string {
  let current = view.rootNodeId
  for (const nodeId of view.screened) {
    if (nodeId === current || !view.complete(nodeId)) continue
    if (beats(view, nodeId, current)) current = nodeId
  }
  return current
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
