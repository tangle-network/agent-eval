/**
 * The reply grammar an analyst arm holds a model to, independent of transport.
 *
 * One contract serves every arm shape: the inline bridge protocol
 * (`runPrimeExchange`) reads the base fields, and one-shot JSON arms
 * additionally use the strict-envelope and all-rejected knobs. `PrimeReplyContract`
 * in ./prime-protocol is a type alias of this contract, so a consumer written
 * against the prime protocol names the same grammar object.
 */

import { ValidationError } from '../errors'

/** Verdict of decoding one raw reply row. */
export type ReplyRowDecoded<TRow> = { ok: true; row: TRow } | { ok: false; reason: string }

/** A strictly parsed reply envelope: the row array plus retained extras. */
export interface ReplyEnvelope {
  rows: readonly unknown[]
  /** Envelope fields beside the rows the arm retains (e.g. a `report` string). */
  extras: Record<string, unknown>
}

export interface ReplyContract<TRow> {
  /** Name of the reply's row array, e.g. `blocks` or `findings`. */
  rowsField: string
  /** Row-grammar lines spliced into the first-turn prompt. */
  contractLines: readonly string[]
  /**
   * The same grammar restated for the repair turn, which never carries the
   * evidence. Empty when the arm declares zero repair turns.
   */
  repairContractLines: readonly string[]
  /**
   * Validate and convert one raw row in a single pass. One function rather than
   * a separate validator and constructor, so the two can never disagree about
   * what a valid row is.
   */
  decodeRow(row: unknown, index: number): ReplyRowDecoded<TRow>
  /**
   * Cap on ACCEPTED rows. The cap is applied after decoding, so malformed rows
   * never consume an accepted slot; the surplus is reported as `overflow`.
   * Omit when the consumer's own expansion owns the cap and records the drop.
   */
  maxRows?: number
  /**
   * Strict envelope parse for one-shot JSON arms. Throws on an envelope defect
   * (missing report, unknown key, over-cap row count). When absent, rows are
   * read from `rowsField` on the parsed reply object.
   */
  parseEnvelope?(value: unknown): ReplyEnvelope
  /**
   * What a reply whose EVERY reported row was rejected means. `fail` throws a
   * validation error carrying each rejection; `accept-empty` (the default)
   * keeps the honest empty result beside the recorded rejections.
   */
  whenAllRowsRejected?: 'fail' | 'accept-empty'
  /**
   * Message prefix for the `fail` case, in the contract's own row vocabulary
   * (e.g. "every reported failure block was malformed").
   */
  allRejectedMessage?: string
}

/** One rejected row, indexed as the model reported it. */
export interface ReplyRowRejection {
  index: number
  reason: string
}

export interface DecodedReply<TRow> {
  rows: TRow[]
  /** Envelope fields beside the rows (empty when the contract has no envelope). */
  extras: Record<string, unknown>
  rejected: ReplyRowRejection[]
  /** Rows the model reported, before decoding or the count cap. */
  reportedRows: number
  /** Valid rows dropped by `maxRows`. */
  overflow: number
}

/**
 * Decode a parsed reply value under a contract: strict envelope when declared,
 * then per-row decoding, then the all-rejected policy. Shape before count: a
 * malformed row never consumes an accepted slot.
 */
export function decodeReplyRows<TRow>(
  contract: ReplyContract<TRow>,
  value: unknown,
): DecodedReply<TRow> {
  let rawRows: readonly unknown[]
  let extras: Record<string, unknown> = {}
  if (contract.parseEnvelope) {
    const envelope = contract.parseEnvelope(value)
    rawRows = envelope.rows
    extras = envelope.extras
  } else {
    const record =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
    const field = record?.[contract.rowsField]
    if (!Array.isArray(field)) {
      throw new ValidationError(`reply has no "${contract.rowsField}" array`)
    }
    rawRows = field
  }
  const rows: TRow[] = []
  const rejected: ReplyRowRejection[] = []
  let overflow = 0
  rawRows.forEach((row, index) => {
    const decoded = contract.decodeRow(row, index)
    if (!decoded.ok) {
      rejected.push({ index, reason: decoded.reason })
      return
    }
    if (contract.maxRows !== undefined && rows.length >= contract.maxRows) {
      overflow += 1
      return
    }
    rows.push(decoded.row)
  })
  if (rows.length === 0 && rawRows.length > 0 && contract.whenAllRowsRejected === 'fail') {
    throw new ValidationError(
      `${contract.allRejectedMessage ?? 'every reported row was malformed'}: ${rejected
        .map((entry) => entry.reason)
        .join(' | ')}`,
    )
  }
  return { rows, extras, rejected, reportedRows: rawRows.length, overflow }
}
