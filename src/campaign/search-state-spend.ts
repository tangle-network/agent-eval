/** Spend bookkeeping of a search ledger: the running totals, holds and the claim reserve. */

import { roundDecimal as round } from '../math/round-decimal'
import { integrity, USD_TOLERANCE } from './search-ledger-constraints'
import type {
  SearchAttemptAccounting,
  SearchAudit,
  SearchOpenedEvent,
  SearchReservation,
} from './search-ledger-types'
import type { CellRecord } from './search-state-types'

type SearchBudget = SearchOpenedEvent['budget']

/** A cell's share of the open reservations, its overspend, and what it draws
 * from the claim reserve: the larger of its hold and its spend. */
export function reservationParts(cell: CellRecord): { open: number; over: number; used: number } {
  const reserved = cell.reservation?.usd ?? 0
  const holding = !cell.final && cell.cancelled === null
  return {
    open: holding ? Math.max(0, reserved - cell.spentUsd) : 0,
    over: cell.reservation ? Math.max(0, cell.spentUsd - reserved) : 0,
    used: holding ? Math.max(reserved, cell.spentUsd) : cell.spentUsd,
  }
}

/** Writes the spend, token and reservation totals of the audit it is given. */
export class SearchSpendBook {
  private claimUsedUsd = 0

  constructor(private readonly audit: SearchAudit) {}

  /** Book an attempt's or operation's accounting into the running totals. An
   * unknown cost counts as its proven floor. */
  book(accounting: SearchAttemptAccounting): { usd: number; unknown: boolean } {
    const { tokens, cost } = accounting
    if (tokens.status === 'known') {
      this.audit.tokens.inputTokens += tokens.inputTokens
      this.audit.tokens.outputTokens += tokens.outputTokens
      this.audit.tokens.cachedTokens += tokens.cachedTokens
    } else {
      this.audit.tokens.unknownTokenAttempts += 1
    }
    const usd = cost.status === 'known' ? cost.usd : cost.knownLowerBoundUsd
    if (cost.status === 'known') this.audit.spend.knownUsd += usd
    else this.audit.spend.floorUsd += usd
    this.audit.spend.committedUsd += usd
    return { usd, unknown: cost.status === 'unknown' }
  }

  /** A new claim cell's hold counts against the claim reserve. */
  drawClaim(reservation: SearchReservation | null): void {
    this.claimUsedUsd += reservation?.usd ?? 0
  }

  /** Move the audit's open holds, overspend and claim draw from a cell's
   * `before` shares to its current ones. */
  shiftHolds(cell: CellRecord, before: ReturnType<typeof reservationParts>): void {
    const after = reservationParts(cell)
    this.audit.spend.openReservationUsd += after.open - before.open
    this.audit.spend.overspendUsd += after.over - before.over
    if (cell.stage === 'claim') this.claimUsedUsd += after.used - before.used
  }

  /** The admission rule: committed spend, open holds, the unspent claim
   * reserve and the new hold stay within the cap. A claim cell draws on the
   * claim reserve instead of adding to it.
   *
   * The rule admits holds, not records. Spend above a hold is legal
   * overspend, so committed spend can pass the cap; an event that holds
   * nothing (the claim operation, a cell an external optimizer already ran)
   * and a claim cell the unspent reserve covers are then still admitted. The
   * reserve was set aside at the start and overspend elsewhere cannot take it
   * back; refusing them would leave a search that can never close. */
  admit(
    budget: SearchBudget,
    reservation: SearchReservation | null,
    claim: boolean,
    subject: string,
  ): void {
    const { maxUsd, reservedClaimUsd } = budget
    const hold = reservation?.usd ?? 0
    if (maxUsd === null || hold === 0) return
    const remainingClaim = Math.max(0, reservedClaimUsd - this.claimUsedUsd)
    if (claim && hold <= remainingClaim + USD_TOLERANCE) return
    const total =
      this.audit.spend.committedUsd +
      this.audit.spend.openReservationUsd +
      (claim ? 0 : remainingClaim) +
      hold
    if (total > maxUsd + USD_TOLERANCE) {
      throw integrity(
        `${subject} is not admissible: committed $${round(this.audit.spend.committedUsd, 6)} + open $${round(this.audit.spend.openReservationUsd, 6)} + claim reserve $${round(remainingClaim, 6)} + hold $${round(hold, 6)} exceeds the cap $${maxUsd}`,
      )
    }
  }

  /** The largest hold a new non-claim cell or operation may take, and the
   * claim reserve still unspent. */
  room(budget: SearchBudget | undefined): {
    headroomUsd: number | null
    claimReserveUsd: number
  } {
    const { maxUsd, reservedClaimUsd } = budget ?? { maxUsd: null, reservedClaimUsd: 0 }
    const claimReserveUsd = Math.max(0, reservedClaimUsd - this.claimUsedUsd)
    if (maxUsd === null) return { headroomUsd: null, claimReserveUsd }
    const used =
      this.audit.spend.committedUsd + this.audit.spend.openReservationUsd + claimReserveUsd
    return { headroomUsd: Math.max(0, maxUsd - used), claimReserveUsd }
  }
}
