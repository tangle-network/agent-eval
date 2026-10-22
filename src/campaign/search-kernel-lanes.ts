/** Execution lanes: their queues, in-flight counts, and the dollar holds sized from settled spend. */
import {
  ESTIMATE_FROM_CELLS,
  ESTIMATE_MARGIN,
  type SearchLane,
  STAGE_PRIORITY,
  USD_TOLERANCE,
} from './search-kernel-contract'
import type { SearchReservation } from './search-ledger-types'
import type { SearchCell, SearchStateView } from './search-state'

export interface SearchLaneState extends SearchLane {
  inFlight: number
  /** Queued cell ids by stage priority. */
  queues: string[][]
  settledCosts: number[]
}

interface SearchLanesHost {
  state(): SearchStateView
  now(): number
  /** The reservation a proposal holds before enough have settled to estimate one. */
  operationPriorUsd(): number
}

export class SearchLanes {
  readonly byName = new Map<string, SearchLaneState>()
  private readonly operationCosts: number[] = []

  constructor(
    declared: Iterable<SearchLane>,
    private readonly host: SearchLanesHost,
  ) {
    for (const lane of declared) {
      if (!Number.isSafeInteger(lane.capacity) || lane.capacity < 1) {
        throw new TypeError(`runSearch: lane ${lane.name} needs a positive integer capacity`)
      }
      if (!Number.isFinite(lane.cellUsd) || lane.cellUsd < 0) {
        throw new TypeError(`runSearch: lane ${lane.name} needs a finite non-negative cellUsd`)
      }
      if (this.byName.has(lane.name))
        throw new TypeError(`runSearch: lane ${lane.name} is declared twice`)
      this.byName.set(lane.name, {
        ...lane,
        inFlight: 0,
        queues: [[], [], [], []],
        settledCosts: [],
      })
    }
    if (this.byName.size === 0) throw new TypeError('runSearch: the executor declares no lane')
  }

  enqueue(cell: SearchCell): void {
    this.byName.get(cell.lane!)!.queues[STAGE_PRIORITY[cell.stage]]!.push(cell.cellId)
  }

  queuedCount(): number {
    let count = 0
    for (const lane of this.byName.values()) {
      for (const queue of lane.queues) count += queue.length
    }
    return count
  }

  /** Concurrent slots the lanes offer, within the budget's concurrency cap. */
  capacity(): number {
    let total = 0
    for (const lane of this.byName.values()) total += lane.capacity
    const cap = this.host.state().header!.budget.maxConcurrency
    return cap === null ? total : Math.min(cap, total)
  }

  /** A hard lane holds its enforced maximum. An estimate lane holds 1.5 times
   * the 99th percentile of its settled cells once 20 settled, else its prior. */
  cellReservation(lane: SearchLaneState): SearchReservation {
    if (lane.costCap === 'hard') return { kind: 'hard', usd: lane.cellUsd }
    return { kind: 'estimate', usd: estimate(lane.settledCosts, lane.cellUsd) }
  }

  maxCellReservation(): number {
    let most = 0
    for (const lane of this.byName.values()) {
      most = Math.max(most, this.cellReservation(lane).usd)
    }
    return most
  }

  operationReservation(): SearchReservation {
    return {
      kind: 'estimate',
      usd: estimate(this.operationCosts, this.host.operationPriorUsd()),
    }
  }

  /** A recorded proposal's spend sizes the next proposal's hold. */
  recordOperationCost(usd: number): void {
    this.operationCosts.push(usd)
  }

  /** Overspend took committed spend, open holds and the unspent claim reserve
   * past the cap. Nothing new is proposed then, even at a zero-dollar prior. */
  overCap(): boolean {
    const state = this.host.state()
    const { maxUsd } = state.header!.budget
    if (maxUsd === null) return false
    const { committedUsd, openReservationUsd } = state.audit.spend
    const used = committedUsd + openReservationUsd + state.budget.claimReserveUsd
    return used > maxUsd + USD_TOLERANCE
  }

  pastDeadline(): boolean {
    const deadline = this.host.state().header!.budget.deadline
    return deadline !== null && this.host.now() >= Date.parse(deadline)
  }
}

function estimate(costs: readonly number[], prior: number): number {
  if (costs.length < ESTIMATE_FROM_CELLS) return prior
  const sorted = [...costs].sort((a, b) => a - b)
  const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1)]!
  return Math.round(ESTIMATE_MARGIN * p99 * 1e9) / 1e9
}
