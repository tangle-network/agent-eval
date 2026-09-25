/**
 * The agent's view of a search: the same projection a human reads.
 *
 * `renderSearchSummary` turns a `SearchStateView` into compact text — the
 * leading nodes with their estimates, the most recently discarded ideas with
 * why they were discarded, and a log of recent proposals — as AIDE's journal
 * summary does for its own search. `agent-eval search show <ledger>` prints
 * the same text for a terminal; `runOptimization` puts it on every
 * `ProposeContext` a proposer receives.
 *
 * `searchProposerView` is the train-only read `ProposeContext.train` carries.
 * It has no parameter that can select another split, so a proposer built on
 * it cannot reach the selection or test split even by mistake: the sealed
 * splits (§6.6 of the search-tree design) are unreachable by construction,
 * not by convention.
 */

import { minimumPairsForPairedDeltaTest } from '../paired-delta-test'
import { BOOTSTRAP_GATE_MIN_N } from '../statistics'
import { estimateNode } from './estimate-node'
import { SearchLedgerError } from './search-ledger-errors'
import type { NodeEstimate, SearchSplit } from './search-ledger-types'
import type { SearchNode, SearchScoredCell, SearchStateView, SearchUnitScore } from './search-state'

const DESCRIPTIVE_FROM = minimumPairsForPairedDeltaTest(0.95)

/** The proposer's own read of a search: its node's cells on the train split,
 * the only split a proposer may ever see. */
export interface SearchProposerView {
  readonly searchId: string
  readonly direction: 'maximize' | 'minimize'
  /** `nodeId`'s scored train cells. Unscored cells (errored, cancelled or in
   * flight) are absent, never zero. */
  scoredCells(nodeId: string): readonly SearchScoredCell[]
  /** Per-unit train-split means of `nodeId`, in unitId order. */
  unitScores(nodeId: string): readonly SearchUnitScore[]
}

/** The train-only view `ProposeContext.train` carries. */
export function searchProposerView(state: SearchStateView): SearchProposerView {
  const header = state.header
  if (!header) throw new SearchLedgerError(`search ${state.searchId} has not been opened`)
  return {
    searchId: state.searchId,
    direction: header.objective.direction,
    scoredCells: (nodeId) => state.scoredCells(nodeId, 'train'),
    unitScores: (nodeId) => state.unitScores(nodeId, 'train'),
  }
}

export interface SearchSummaryOptions {
  /**
   * The split every estimate in the summary is computed on. A proposer's
   * context must always pass `'train'`: the selection and test splits stay
   * unread by anything a proposer's text can reach. The CLI passes the
   * search's own ranking split, `'selection'` when the search declares one
   * else `'train'`, matching `searchPolicyView`.
   */
  split: SearchSplit
  /** Nodes shown under "Leading" and under "Recently discarded". Default 5. */
  limit?: number
}

/**
 * `SearchState` as compact text: a header line with the search's shape and
 * spend, the leading nodes against the root with their estimates, the most
 * recently discarded nodes with the measurement that discarded them, and a
 * log of recent proposals (operator and label — the ledger's inline,
 * redacted summary of each rationale; the full rationale is a blob this
 * function never reads, so it stays a pure, I/O-free projection of the
 * state already in hand).
 */
export function renderSearchSummary(state: SearchStateView, options: SearchSummaryOptions): string {
  const header = state.header
  if (!header) return `search ${state.searchId}: not yet opened`
  const limit = options.limit ?? 5
  if (limit < 1 || !Number.isInteger(limit)) {
    throw new SearchLedgerError(
      `renderSearchSummary: limit must be a positive integer, got ${limit}`,
    )
  }
  const split = options.split
  const direction = header.objective.direction
  const root = state.rootNodeId
  const lines: string[] = [headerLine(state), spendLine(state), statusLine(state)]

  if (root === null) {
    lines.push('', 'No nodes yet.')
    return lines.join('\n')
  }

  const others = state.nodes().filter((node) => node.nodeId !== root)
  const estimated = others
    .filter((node) => node.status !== 'invalid')
    .map((node) => ({ node, estimate: estimateNode(state, node.nodeId, { against: root, split }) }))

  const leading = estimated
    .filter(({ estimate }) => estimate.delta !== null)
    .sort((a, b) => signed(b.estimate, direction) - signed(a.estimate, direction))
    .slice(0, limit)
  lines.push('', `Leading nodes (vs root, ${split} split):`)
  if (leading.length === 0) lines.push('  none measured yet')
  for (const { node, estimate } of leading)
    lines.push(`  ${nodeLine(node)}: ${formatEstimate(estimate)}`)

  const discarded = others
    .filter(
      (node) => node.status === 'pruned' || node.status === 'rejected' || node.status === 'invalid',
    )
    .sort((a, b) => b.updatedSequence - a.updatedSequence)
    .slice(0, limit)
  lines.push('', 'Recently discarded:')
  if (discarded.length === 0) lines.push('  none yet')
  for (const node of discarded) lines.push(`  ${nodeLine(node)}: ${discardLine(node)}`)

  const recent = [...state.edges()].reverse().slice(0, limit)
  lines.push('', 'Recent proposals:')
  if (recent.length === 0) lines.push('  none yet')
  for (const edge of recent) {
    const childId = edge.childNodeId
    const label = edge.label.length > 0 ? edge.label : '(no label)'
    lines.push(`  ${edge.operator} → ${childId}: ${label}`)
  }

  return lines.join('\n')
}

function headerLine(state: SearchStateView): string {
  const header = state.header!
  return `search ${state.searchId} — ${header.subject} — ${header.objective.direction} ${header.objective.metric}`
}

function spendLine(state: SearchStateView): string {
  const { audit } = state
  const known = audit.spend.knownUsd.toFixed(2)
  const floor = audit.spend.floorUsd.toFixed(2)
  const unknown = audit.spend.unknownCostCells
  const floorPart =
    unknown > 0
      ? ` + floor $${floor} across ${unknown} unknown-cost cell${unknown === 1 ? '' : 's'}`
      : ''
  return `  ${audit.nodes} nodes · ${audit.cells.settled} settled cells (${audit.cells.open} open) · $${known} known${floorPart}`
}

function statusLine(state: SearchStateView): string {
  if (!state.closed) return '  status: open'
  const claim = state.closed.claim
  const claimText =
    claim === null
      ? ''
      : claim.decision === 'ship'
        ? ` · claim: ship ${claim.selected}`
        : ` · claim: ${claim.decision}`
  return `  status: closed (${state.closed.reason})${claimText}`
}

function nodeLine(node: SearchNode): string {
  const rung = node.status === 'advanced' ? ` rung ${node.rung}` : ''
  return `${node.nodeId} (${node.status ?? 'undecided'}${rung})`
}

function discardLine(node: SearchNode): string {
  const decision = node.decisions.at(-1)
  if (!decision) return 'no decision recorded'
  const basis = decision.basis === null ? 'no measured basis' : formatEstimate(decision.basis)
  return `${basis} — ${decision.rule}: ${decision.reason}`
}

/** `estimate.delta` in the objective's own units; positive is always better. */
function signed(estimate: NodeEstimate, direction: 'maximize' | 'minimize'): number {
  if (estimate.delta === null) return Number.NEGATIVE_INFINITY
  return direction === 'maximize' ? estimate.delta : -estimate.delta
}

/** The display rules of search-tree-design §6.4: no whisker below 6 shared
 * units, a dashed descriptive interval with its exact sign p from 6 to 19,
 * a decision-grade whisker from `BOOTSTRAP_GATE_MIN_N`. */
function formatEstimate(estimate: NodeEstimate): string {
  const unit = (n: number) => `${n} unit${n === 1 ? '' : 's'}`
  if (estimate.method === 'none') return `unknown (${unit(estimate.pairs)})`
  if (estimate.indeterminate)
    return `no measurable difference (indeterminate, ${unit(estimate.pairs)})`
  const delta =
    estimate.delta === null ? 'null' : (estimate.delta >= 0 ? '+' : '') + estimate.delta.toFixed(4)
  if (estimate.method === 'insufficient') {
    return `Δ=${delta} (${estimate.pairs} of ${DESCRIPTIVE_FROM} units, insufficient)`
  }
  const interval = estimate.interval
    ? ` [${estimate.interval[0].toFixed(4)}, ${estimate.interval[1].toFixed(4)}]`
    : ''
  if (estimate.method === 'descriptive') {
    const signP = estimate.exactSignP === null ? 'null' : estimate.exactSignP.toPrecision(3)
    return `Δ=${delta}${interval} dashed, sign p=${signP} (${unit(estimate.pairs)})`
  }
  return `Δ=${delta}${interval} (${unit(estimate.pairs)}, ≥${BOOTSTRAP_GATE_MIN_N})`
}
