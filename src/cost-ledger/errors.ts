/** Typed cost-accounting failures retain detached receipt evidence. */
import { ValidationError } from '../errors'
import type { CostReceipt } from './contract'
import { cloneReceipt } from './receipts'
import { toError } from './validation'

export class CostCeilingReachedError extends ValidationError {
  constructor(
    ceilingUsd: number,
    committedUsd: number,
    requestedUsd: number,
    phase: string,
    actor: string,
  ) {
    super(
      `CostLedger: reserving ${requestedUsd} for '${actor}' during '${phase}' would exceed ceiling ${ceilingUsd} with ${committedUsd} already committed`,
    )
  }
}

export class CostAccountingIncompleteError extends ValidationError {}

export class CostReservationExceededError extends ValidationError {
  constructor(actor: string, actualUsd: number, maximumUsd: number) {
    super(
      `CostLedger: '${actor}' charged ${actualUsd}, exceeding its enforced maximum ${maximumUsd}`,
    )
  }
}

export class CostCallConflictError extends ValidationError {
  readonly callId?: string
  readonly receipt?: CostReceipt

  constructor(
    message: string,
    options: { callId?: string; receipt?: CostReceipt; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.callId = options.callId
    this.receipt = options.receipt ? cloneReceipt(options.receipt) : undefined
  }
}

export class CostLedgerPersistenceError extends ValidationError {
  readonly callId?: string
  readonly receipt?: CostReceipt

  constructor(cause: unknown, callId?: string, receipt?: CostReceipt) {
    super(
      `CostLedger: failed to persist${callId ? ` call '${callId}'` : ''}: ${toError(cause).message}`,
      { cause },
    )
    this.callId = callId
    this.receipt = receipt ? cloneReceipt(receipt) : undefined
  }
}

export class CostReceiptCaptureError extends ValidationError {
  readonly callId: string
  readonly receipt?: CostReceipt
  readonly receiptError: Error

  constructor(callId: string, cause: unknown, receiptError: unknown, receipt?: CostReceipt) {
    super(`CostLedger: could not capture the provider receipt for call '${callId}'`, { cause })
    this.callId = callId
    this.receipt = receipt ? cloneReceipt(receipt) : undefined
    this.receiptError = toError(receiptError)
  }
}
