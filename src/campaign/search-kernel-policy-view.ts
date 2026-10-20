/** Policy observations and divergence decisions from train and selection evidence. */
import { type OperatorYieldSignal, operatorYield } from '../search/lenses/operator-yield'
import { estimateNode, type SearchPosterior, searchPosterior } from './estimate-node'
import { DEFAULT_MAX_ATTEMPTS } from './search-kernel-contract'
import type { NodeEstimate } from './search-ledger-types'
import type { SearchPolicyNode, SearchPolicyView } from './search-policy'
import type { SearchStateView } from './search-state'

/**
 * A policy's read of a search: `screened` lists the admitted nodes whose screen
 * finished, in registration order; `screening` counts the admitted nodes still
 * being screened. Nodes are ranked on the selection split, or on train when
 * the search declares no selection split. The view reads no test cell.
 * `maxAttempts` (default 3, the kernel's) says when an errored cell has no
 * attempt left, which makes its unit a dodge.
 */
export function searchPolicyView(
  state: SearchStateView,
  input: {
    screened: readonly string[]
    screening: number
    expansions: number
    maxAttempts?: number
  },
): SearchPolicyView {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const header = state.header
  if (!header) throw new Error(`search ${state.searchId} has not been opened`)
  const split = header.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  let nodes: SearchPolicyNode[] | undefined
  let operatorWeights: OperatorYieldSignal | undefined
  return {
    searchId: state.searchId,
    seed: header.policy.seed,
    direction: header.objective.direction,
    split,
    rootNodeId: state.rootNodeId!,
    expansions: input.expansions,
    screened: [...input.screened],
    screening: input.screening,
    complete: (nodeId) => {
      // A cell still to run (queued, in flight, or retrying) and a cell
      // cancelled before it ran do not count against the node; a cell that
      // ran and ended unscored does.
      let scored = false
      for (const cell of state.cells({ nodeId })) {
        if (cell.split !== split) continue
        if (cell.score !== null) scored = true
        else if (cell.final || (cell.outcome === 'errored' && cell.attempts >= maxAttempts)) {
          return false
        }
      }
      return scored
    },
    unitScores: (nodeId) => state.unitScores(nodeId, split),
    estimate: (nodeId, against) => estimateNode(state, nodeId, { against, split }),
    nodes: () => {
      nodes ??= policyNodes(state)
      return nodes
    },
    get posterior() {
      let posterior = POSTERIORS.get(state)
      if (!posterior) {
        posterior = searchPosterior(state, { split })
        POSTERIORS.set(state, posterior)
      }
      return posterior
    },
    get operatorWeights() {
      operatorWeights ??= operatorYield(state, { split }).signal.value
      return operatorWeights
    },
  }
}

/** One posterior per ledger state: a state view is retired when the ledger
 * moves on, so the view it was computed from names the sequence. */
const POSTERIORS = new WeakMap<SearchStateView, SearchPosterior>()

/** Every node whose edge is recorded, with its lineage and its defects outside
 * the test split. */
function policyNodes(state: SearchStateView): SearchPolicyNode[] {
  const nodes: SearchPolicyNode[] = []
  for (const node of state.nodes()) {
    const edgeId = node.edgeIds[0]
    if (edgeId === undefined) continue
    let outcomes = 0
    let defects = 0
    for (const cell of state.cells({ nodeId: node.nodeId })) {
      if (cell.split === 'test' || !cell.final) continue
      outcomes += 1
      if (cell.outcome === 'failed') defects += 1
    }
    const edge = state.edge(edgeId)!
    nodes.push({
      nodeId: node.nodeId,
      ordinal: node.ordinal,
      parent: node.primaryParentId,
      operator: edge.operator,
      rule: edge.selection?.rule ?? null,
      children: node.children,
      status: node.status,
      outcomes,
      defects,
    })
  }
  return nodes
}

/**
 * The divergence rule: a node whose train mean rose over its parent's on the
 * train units they share while its selection interval against the parent (6
 * or more units, not indeterminate) lies wholly on the worse side. Train is
 * what the proposer reads; a gain there that selection contradicts is the
 * signature of fitting the feedback instead of the task.
 */
export function searchDivergence(
  state: SearchStateView,
  nodeId: string,
): { basis: NodeEstimate; reason: string } | null {
  const header = state.header
  const node = state.node(nodeId)
  const parent = node?.primaryParentId ?? null
  if (!header || parent === null || header.splits.selection.tasks.length === 0) return null
  const selection = estimateNode(state, nodeId, { against: parent, split: 'selection' })
  if (selection.interval === null) return null
  const maximize = header.objective.direction === 'maximize'
  const [low, high] = selection.interval
  if (maximize ? high >= 0 : low <= 0) return null
  const parentTrain = new Map(
    state.unitScores(parent, 'train').map((unit) => [unit.unitId, unit.mean]),
  )
  let gain = 0
  let shared = 0
  for (const unit of state.unitScores(nodeId, 'train')) {
    const before = parentTrain.get(unit.unitId)
    if (before === undefined) continue
    gain += maximize ? unit.mean - before : before - unit.mean
    shared += 1
  }
  if (shared === 0 || gain <= 0) return null
  const trainGain = Math.round((gain / shared) * 1e4) / 1e4
  return {
    basis: selection,
    reason: `its train mean rose ${trainGain} over its parent's on ${shared} shared train unit${shared === 1 ? '' : 's'}, while its selection interval against the parent, [${round4(low)}, ${round4(high)}] on ${selection.pairs} units, lies wholly on the worse side`,
  }
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4
}
