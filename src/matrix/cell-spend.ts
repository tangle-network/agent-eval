/**
 * Spend carrier for a cell that fails after it has already spent money.
 *
 * `runCell` reports what a cell cost by returning a `CellResult`. A throw
 * carries no result, so the runner cannot know what the cell spent before it
 * failed: the cumulative sum the cost ceiling reads, and `totalCostUsd`, both
 * miss that money. A throw that carries a `CellSpend` closes the gap — the
 * runner bills the failed cell for the spend the carrier declares, and records
 * a cell that declared nothing as `uncaptured` instead of a zero that reads
 * like "this cell spent nothing".
 *
 * The carrier is read structurally, never by `instanceof`, so a throw that
 * crosses a package or realm boundary still bills.
 */

/** Property key the carrier occupies on a thrown object. Stable across
 *  versions — two copies of this package must agree on it. */
const CELL_SPEND_KEY = '__agentEvalCellSpend'

/** Money and wall time a cell consumed before it threw. */
export interface CellSpend {
  /** KNOWN subtotal in USD. When `kind` is `uncaptured` the cell spent this
   *  much AND an unknown amount more, so the value must not be read as the
   *  cell's total. */
  costUsd: number
  /** Wall time the cell consumed before the throw, in milliseconds. */
  durationMs: number
  /** `observed` = provider-reported amounts, `estimated` = computed from token
   *  prices, `uncaptured` = `costUsd` is a subtotal and part of the spend
   *  could not be measured. */
  kind: 'observed' | 'estimated' | 'uncaptured'
}

/**
 * Return `error` carrying `spend`, for a throw site inside `runCell`:
 * `throw withCellSpend(err, { costUsd, durationMs, kind })`.
 *
 * A value that cannot hold the carrier — a thrown string or number, or a
 * frozen, sealed, or otherwise non-extensible object — is wrapped in an
 * `Error` that keeps the original as `cause`, so the spend is never dropped.
 * A later call overwrites an earlier carrier — the outer frame knows more
 * than the inner one.
 *
 * Throws `TypeError` on a non-finite or negative amount. A poisoned amount
 * would reach `cumulativeCost` and disable the cost ceiling for the whole run,
 * because `NaN >= ceiling` is false.
 */
export function withCellSpend(error: unknown, spend: CellSpend): unknown {
  assertAmount(spend.costUsd, 'costUsd')
  assertAmount(spend.durationMs, 'durationMs')
  if (spend.kind !== 'observed' && spend.kind !== 'estimated' && spend.kind !== 'uncaptured') {
    throw new TypeError(
      `withCellSpend: kind must be observed, estimated or uncaptured, received ${String(spend.kind)}`,
    )
  }
  const carrier: CellSpend = {
    costUsd: spend.costUsd,
    durationMs: spend.durationMs,
    kind: spend.kind,
  }
  if (typeof error === 'object' && error !== null && attach(error, carrier)) return error
  // A primitive cannot hold a property, and a frozen or sealed object refuses
  // one. Carry the spend on a fresh Error that keeps the original as `cause`
  // rather than lose it — a dropped carrier bills the cell as uncaptured,
  // which is the under-billing this module exists to prevent.
  const wrapper = new Error(`cell failed: ${messageOf(error)}`, { cause: error })
  attach(wrapper, carrier)
  return wrapper
}

/** True when the carrier landed. `defineProperty` throws on a non-extensible
 *  target, so the caller must be able to fall back. */
function attach(target: object, carrier: CellSpend): boolean {
  try {
    Object.defineProperty(target, CELL_SPEND_KEY, {
      value: carrier,
      enumerable: false,
      configurable: true,
      writable: true,
    })
    return true
  } catch {
    return false
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Read the spend a thrown value carries. `undefined` when the value carries
 *  none, or carries one that does not satisfy `CellSpend` — the runner records
 *  both as `uncaptured`. */
export function readCellSpend(error: unknown): CellSpend | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const raw = (error as Record<string, unknown>)[CELL_SPEND_KEY]
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Record<string, unknown>
  if (!isAmount(candidate.costUsd) || !isAmount(candidate.durationMs)) return undefined
  const kind = candidate.kind
  if (kind !== 'observed' && kind !== 'estimated' && kind !== 'uncaptured') return undefined
  return { costUsd: candidate.costUsd, durationMs: candidate.durationMs, kind }
}

/** A number the matrix can add to a running cost or duration: finite and not
 *  negative. Anything else would poison a sum the cost ceiling reads. */
export function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function assertAmount(value: number, field: string): void {
  if (!isAmount(value)) {
    throw new TypeError(
      `withCellSpend: ${field} must be a finite number >= 0, received ${String(value)}`,
    )
  }
}
