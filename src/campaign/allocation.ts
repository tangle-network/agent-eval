/**
 * Allocation: where a search spends rollouts.
 *
 * An allocator says which cells a node needs given the evidence so far; the
 * kernel allocates the ones the ledger does not hold yet, so a resumed search
 * plans exactly what the interrupted one planned. It also decides which nodes
 * earn more measurement (`advanced`) and, at close, which were left waiting
 * (`pruned`). Those are rank decisions: they spend budget and claim nothing.
 * Expansion (which parent, which operator) belongs to the `SearchPolicy`; the
 * claim belongs to the claim step.
 */

import { compareCodeUnits } from '../ledger-core/canonical'
import { minimumPairsForPairedDeltaTest } from '../paired-delta-test'
import { mulberry32 } from '../statistics/random'
import { estimateNode } from './estimate-node'
import type {
  NodeEstimate,
  SearchCellStage,
  SearchOpenedEvent,
  SearchSplit,
  SearchTask,
} from './search-ledger-types'
import type { SearchStateView } from './search-state'

/** One cell an allocator wants for a node. */
export interface SearchCellPlan {
  taskId: string
  split: SearchSplit
  rep: number
  stage: SearchCellStage
}

/** What an allocator reads when it decides. */
export interface SearchAllocationView {
  readonly state: SearchStateView
  /** True when no cell allocated to the node can still run: each one ended
   * scored, failed, cancelled or out of attempts. */
  idle(nodeId: string): boolean
}

/** A rank decision an allocator asks the kernel to record. */
export interface SearchRungDecision {
  nodeId: string
  decision: { status: 'advanced'; rung: number } | { status: 'pruned' }
  /** The node against the root on the ranked split, as it stood at the decision. */
  basis: NodeEstimate | null
  rule: string
  reason: string
}

export interface SearchAllocator {
  /** Recorded as the search's `policy.allocation`. */
  readonly name: string
  /** Repeats of each task. The claim runs its test cells at the same repeats. */
  readonly reps: number
  /** Every cell the node needs through `rung`. The kernel allocates the ones
   * missing; a node that was never advanced is at rung 0. */
  plan(state: SearchStateView, nodeId: string, rung: number): SearchCellPlan[]
  /** Cells a newly admitted node's screen allocates, so the kernel can price an
   * expansion against the budget before the proposer runs. */
  screenSize(state: SearchStateView): number
  /** Nodes the evidence now moves to a further rung, deepest rung first. The
   * kernel records each one the budget admits and allocates its rung. */
  advance(view: SearchAllocationView): SearchRungDecision[]
  /** At close: nodes left waiting below the top rung, decided `pruned` with
   * their rank. `keep`, the node the search keeps, is never pruned. */
  prune(view: SearchAllocationView, keep: string): SearchRungDecision[]
}

/**
 * Every node gets every train and selection task at every repeat: the root as
 * `root` cells, every other node as `train` cells (the proposer's feedback) and
 * `screen` cells (the policy's private evidence). This is the fixed plan the
 * generation loop ran and GEPA runs. It has one rung, so it never advances or
 * prunes a node.
 */
export function uniform(options: { reps?: number } = {}): SearchAllocator {
  const reps = positiveInteger('uniform', 'reps', options.reps ?? 1)
  const cells = (state: SearchStateView, root: boolean): SearchCellPlan[] => {
    const header = state.header
    if (!header) return []
    const plan: SearchCellPlan[] = []
    for (const split of ['train', 'selection'] as const) {
      for (const task of header.splits[split].tasks) {
        for (let rep = 0; rep < reps; rep++) {
          plan.push({
            taskId: task.taskId,
            split,
            rep,
            stage: root ? 'root' : split === 'train' ? 'train' : 'screen',
          })
        }
      }
    }
    return plan
  }
  return {
    name: reps === 1 ? 'uniform' : `uniform(reps=${reps})`,
    reps,
    plan: (state, nodeId) => cells(state, nodeId === state.rootNodeId),
    screenSize: (state) => cells(state, false).length,
    advance: () => [],
    prune: () => [],
  }
}

export interface AshaOptions {
  /** Units of the first rung. Default 6, `minimumPairsForPairedDeltaTest(0.95)`:
   * the fewest shared units a paired contrast needs, so every screened edge
   * gets one. */
  units?: number
  /** Reduction factor: a node advances when it ranks in the top 1/eta of the
   * nodes that finished its rung. Default 3. */
  eta?: number
  /** Train units every non-root node also runs, as the proposer's feedback.
   * They never enter a rank. Default 2. */
  trainUnits?: number
  /** Repeats per task. Default 1. */
  reps?: number
}

/**
 * Asynchronous successive halving (Li et al., 2020) over one seeded
 * permutation of the ranked split's units, fixed by the search's seed.
 *
 * Rung k is the first `units × 2^k` units of the permutation; the top rung is
 * every unit. The root runs every unit before anything else, so every rung
 * pairs against it. A new node screens on rung 0 plus `trainUnits` train
 * units. Every node at a rung runs the same units as its parent, the root and
 * its siblings, so every contrast pairs.
 *
 * A node that finished rung k advances once it ranks in the top
 * floor(n / eta) of the n nodes that finished rung k, the root included, by
 * mean over the rung's units; a node with an unscored unit ranks last and
 * never advances. There is no barrier: a node outside the top waits, because
 * the set grows as more nodes finish. At close a waiting node is pruned with
 * its rank. The ranked split is selection, or train when a search declares no
 * selection split, as the policy's.
 */
export function asha(options: AshaOptions = {}): SearchAllocator {
  const firstRung = minimumPairsForPairedDeltaTest()
  const units = positiveInteger('asha', 'units', options.units ?? firstRung)
  const eta = positiveInteger('asha', 'eta', options.eta ?? 3)
  if (eta < 2) throw new TypeError(`asha: eta must be at least 2, got ${eta}`)
  const trainUnits = nonNegativeInteger('asha', 'trainUnits', options.trainUnits ?? 2)
  const reps = positiveInteger('asha', 'reps', options.reps ?? 1)
  const name =
    units === firstRung && eta === 3 && trainUnits === 2 && reps === 1
      ? 'asha'
      : `asha(units=${units},eta=${eta},train=${trainUnits},reps=${reps})`
  const layouts = new WeakMap<SearchOpenedEvent, AshaLayout>()
  const layoutOf = (state: SearchStateView): AshaLayout | null => {
    const header = state.header
    if (!header) return null
    let layout = layouts.get(header)
    if (!layout) {
      layout = ashaLayout(header, { units, trainUnits })
      layouts.set(header, layout)
    }
    return layout
  }

  const cellsThrough = (layout: AshaLayout, rung: number, root: boolean): SearchCellPlan[] => {
    const plan: SearchCellPlan[] = []
    const through = root ? layout.top : Math.min(rung, layout.top)
    layout.order.slice(0, layout.sizes[through]).forEach((unitId, position) => {
      const stage: SearchCellStage = root
        ? 'root'
        : layout.split === 'train'
          ? 'train'
          : position < layout.sizes[0]!
            ? 'screen'
            : 'rung'
      for (const task of layout.tasks.get(unitId)!) {
        for (let rep = 0; rep < reps; rep++) {
          plan.push({ taskId: task.taskId, split: layout.split, rep, stage })
        }
      }
    })
    for (const task of layout.feedback) {
      for (let rep = 0; rep < reps; rep++) {
        plan.push({ taskId: task.taskId, split: 'train', rep, stage: root ? 'root' : 'train' })
      }
    }
    return plan
  }

  /** Per node: the deepest rung it finished and its unit means on the ranked split. */
  const standings = (view: SearchAllocationView, layout: AshaLayout): Standing[] => {
    const { state } = view
    const rootId = state.rootNodeId
    const standing: Standing[] = []
    for (const node of state.nodes()) {
      if (node.status !== null && node.status !== 'advanced') continue
      const root = node.nodeId === rootId
      const rung = root ? layout.top : Math.min(node.rung ?? 0, layout.top)
      // A rung is finished when every one of its cells exists and none can
      // still run. Cells are counted by coordinates, which the ids digest.
      const allocated = new Set<string>()
      for (const cell of state.cells({ nodeId: node.nodeId })) {
        if (cell.split !== layout.split) continue
        const position = layout.position.get(cell.unitId)
        if (position !== undefined && position < layout.sizes[rung]!) {
          allocated.add(`${cell.taskId}\u0000${cell.rep}`)
        }
      }
      const covered = allocated.size === layout.cellsThrough[rung]! * reps
      const finished = view.idle(node.nodeId) && covered ? rung : root ? -1 : rung - 1
      if (finished < 0) continue
      const means = new Map<string, number>()
      for (const unit of state.unitScores(node.nodeId, layout.split)) {
        means.set(unit.unitId, unit.mean)
      }
      standing.push({ nodeId: node.nodeId, ordinal: node.ordinal, root, rung, finished, means })
    }
    return standing
  }

  /** The nodes that finished rung k, best first; an unscored unit ranks last. */
  const ranking = (
    state: SearchStateView,
    layout: AshaLayout,
    standing: readonly Standing[],
    k: number,
  ): Ranked[] => {
    const rungUnits = [...layout.order.slice(0, layout.sizes[k])].sort(compareCodeUnits)
    const sign = state.header!.objective.direction === 'maximize' ? 1 : -1
    const ranked: Ranked[] = []
    for (const entry of standing) {
      if (entry.finished < k) continue
      let sum = 0
      let complete = true
      for (const unitId of rungUnits) {
        const mean = entry.means.get(unitId)
        if (mean === undefined) {
          complete = false
          break
        }
        sum += mean
      }
      ranked.push({ ...entry, mean: complete ? sum / rungUnits.length : null, sign })
    }
    return ranked.sort(compareRanked)
  }

  const reason = (ranked: readonly Ranked[], index: number, k: number, layout: AshaLayout) => {
    const entry = ranked[index]!
    const top = Math.floor(ranked.length / eta)
    const mean = entry.mean === null ? 'an unscored unit' : `mean ${round(entry.mean)}`
    return `rank ${index + 1} of ${ranked.length} on rung ${k} (${layout.sizes[k]} units, ${mean}); the top ${top} advance (eta ${eta})`
  }

  return {
    name,
    reps,
    plan(state, nodeId, rung) {
      const layout = layoutOf(state)
      return layout ? cellsThrough(layout, rung, nodeId === state.rootNodeId) : []
    },
    screenSize(state) {
      const layout = layoutOf(state)
      return layout ? cellsThrough(layout, 0, false).length : 0
    },
    advance(view) {
      const { state } = view
      const layout = layoutOf(state)
      const rootId = state.rootNodeId
      if (!layout || layout.top === 0 || rootId === null) return []
      const standing = standings(view, layout)
      const decisions: SearchRungDecision[] = []
      for (let k = layout.top - 1; k >= 0; k--) {
        const ranked = ranking(state, layout, standing, k)
        const top = Math.floor(ranked.length / eta)
        for (let index = 0; index < top; index++) {
          const entry = ranked[index]!
          if (entry.root || entry.mean === null || entry.finished !== k || entry.rung !== k) {
            continue
          }
          decisions.push({
            nodeId: entry.nodeId,
            decision: { status: 'advanced', rung: k + 1 },
            basis: estimateNode(state, entry.nodeId, { against: rootId, split: layout.split }),
            rule: name,
            reason: reason(ranked, index, k, layout),
          })
        }
      }
      return decisions
    },
    prune(view, keep) {
      const { state } = view
      const layout = layoutOf(state)
      const rootId = state.rootNodeId
      if (!layout || layout.top === 0 || rootId === null) return []
      const standing = standings(view, layout)
      const decisions: SearchRungDecision[] = []
      for (let k = layout.top - 1; k >= 0; k--) {
        const ranked = ranking(state, layout, standing, k)
        const top = Math.floor(ranked.length / eta)
        ranked.forEach((entry, index) => {
          if (entry.root || entry.nodeId === keep) return
          if (entry.finished !== k || entry.rung !== k || entry.means.size === 0) return
          const why =
            index < top && entry.mean !== null
              ? `it earned rung ${k + 1}, but the budget did not admit its cells`
              : 'it waited outside the top when the search closed'
          decisions.push({
            nodeId: entry.nodeId,
            decision: { status: 'pruned' },
            basis: estimateNode(state, entry.nodeId, { against: rootId, split: layout.split }),
            rule: name,
            reason: `${reason(ranked, index, k, layout)}; ${why}`,
          })
        })
      }
      return decisions
    },
  }
}

interface AshaLayout {
  /** The ranked split. */
  split: 'selection' | 'train'
  /** The ranked split's units in the seeded permutation. */
  order: string[]
  position: Map<string, number>
  /** Tasks of each ranked unit. */
  tasks: Map<string, SearchTask[]>
  /** Units in each rung: min(units × 2^k, all), up to the top rung, which is all. */
  sizes: number[]
  /** Tasks in each rung, one repeat. */
  cellsThrough: number[]
  top: number
  /** Train tasks every non-root node runs as the proposer's feedback; empty
   * when train is the ranked split. */
  feedback: SearchTask[]
}

interface Standing {
  nodeId: string
  ordinal: number
  root: boolean
  /** The rung the node is measured through (the top for the root). */
  rung: number
  /** The deepest rung it finished. */
  finished: number
  means: Map<string, number>
}

interface Ranked extends Standing {
  /** Mean over the rung's units, or null when one is unscored. */
  mean: number | null
  sign: number
}

function compareRanked(left: Ranked, right: Ranked): number {
  if (left.mean === null || right.mean === null) {
    if (left.mean !== right.mean) return left.mean === null ? 1 : -1
  } else if (left.mean !== right.mean) {
    return left.sign * (right.mean - left.mean)
  }
  return left.ordinal - right.ordinal
}

function ashaLayout(
  header: SearchOpenedEvent,
  options: { units: number; trainUnits: number },
): AshaLayout {
  const split = header.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  const tasks = unitsOf(header.splits[split].tasks)
  const order = permute([...tasks.keys()], header.policy.seed, split)
  const sizes: number[] = []
  for (let size = options.units; ; size *= 2) {
    sizes.push(Math.min(size, order.length))
    if (size >= order.length) break
  }
  const cellsThrough = sizes.map((size) =>
    order.slice(0, size).reduce((sum, unitId) => sum + tasks.get(unitId)!.length, 0),
  )
  let feedback: SearchTask[] = []
  if (split === 'selection') {
    const train = unitsOf(header.splits.train.tasks)
    feedback = permute([...train.keys()], header.policy.seed, 'train')
      .slice(0, options.trainUnits)
      .flatMap((unitId) => train.get(unitId)!)
  }
  return {
    split,
    order,
    position: new Map(order.map((unitId, index) => [unitId, index])),
    tasks,
    sizes,
    cellsThrough,
    top: sizes.length - 1,
    feedback,
  }
}

/** Tasks grouped by unit, units and tasks in code-unit order. */
function unitsOf(tasks: readonly SearchTask[]): Map<string, SearchTask[]> {
  const byUnit = new Map<string, SearchTask[]>()
  for (const task of [...tasks].sort((left, right) =>
    compareCodeUnits(left.taskId, right.taskId),
  )) {
    const unit = byUnit.get(task.unitId)
    if (unit) unit.push(task)
    else byUnit.set(task.unitId, [task])
  }
  return new Map([...byUnit.entries()].sort(([left], [right]) => compareCodeUnits(left, right)))
}

/** Fisher-Yates over units in code-unit order, from the search seed and the split. */
function permute(unitIds: string[], seed: number, split: SearchSplit): string[] {
  const rng = mulberry32((seed ^ (split === 'train' ? 0x7a3c5e11 : 0x2b9d4f63)) | 0)
  const order = [...unitIds]
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1))
    ;[order[index], order[other]] = [order[other]!, order[index]!]
  }
  return order
}

function positiveInteger(owner: string, name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${owner}: ${name} must be a positive integer, got ${String(value)}`)
  }
  return value
}

function nonNegativeInteger(owner: string, name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${owner}: ${name} must be a non-negative integer, got ${String(value)}`)
  }
  return value
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4
}
