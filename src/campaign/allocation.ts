/**
 * Allocation: where a search spends rollouts.
 *
 * An allocator says which cells a node needs given the evidence so far; the
 * kernel allocates the ones the ledger does not hold yet, so a resumed search
 * plans exactly what the interrupted one planned. Expansion (which parent, which
 * operator) belongs to the `SearchPolicy`; the claim belongs to the claim step.
 */

import type { SearchCellStage, SearchSplit } from './search-ledger-types'
import type { SearchStateView } from './search-state'

/** One cell an allocator wants for a node. */
export interface SearchCellPlan {
  taskId: string
  split: SearchSplit
  rep: number
  stage: SearchCellStage
}

export interface SearchAllocator {
  /** Recorded as the search's `policy.allocation`. */
  readonly name: string
  /** Repeats of each task. The claim runs its test cells at the same repeats. */
  readonly reps: number
  /** Every cell the node needs now. The kernel allocates the ones missing. */
  plan(state: SearchStateView, nodeId: string): SearchCellPlan[]
  /** Cells a newly admitted node's screen allocates, so the kernel can price an
   * expansion against the budget before the proposer runs. */
  screenSize(state: SearchStateView): number
}

/**
 * Every node gets every train and selection task at every repeat: the root as
 * `root` cells, every other node as `train` cells (the proposer's feedback) and
 * `screen` cells (the policy's private evidence). This is the fixed plan the
 * generation loop ran and GEPA runs.
 */
export function uniform(options: { reps?: number } = {}): SearchAllocator {
  const reps = options.reps ?? 1
  if (!Number.isSafeInteger(reps) || reps < 1) {
    throw new TypeError(`uniform: reps must be a positive integer, got ${String(reps)}`)
  }
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
  }
}
