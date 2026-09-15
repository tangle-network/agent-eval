/**
 * The run's terminal record, read from the documents the store wrote when the
 * run ended. Runtime's own record outranks every other source: `result.json` is
 * the `SupervisedResult` that `supervise()` returned, verbatim, and its `kind`
 * is the run's status. `failure.json` is the record Runtime writes when
 * `supervise()` threw before a result landed. Runtime's result and failure
 * records are the only terminal status contract; state is timing metadata.
 *
 * Pure: takes already-parsed documents and returns `Measured` values. The
 * analyzer and the rollout minter share it so a run never has two statuses.
 */

import { asRecord } from './source-facts'
import {
  type Measured,
  type SupervisorStatusSource,
  type TerminalFailure,
  unavailable,
} from './types'

/** The reason every terminal field reads `unavailable` when no store wrote one. */
export const NO_TERMINAL_RECORD =
  'no terminal record: Runtime result.json kind or Runtime failure.json'

/** The status reported for a run whose directory holds Runtime's failure record and no result. */
export const RUNTIME_FAILED_STATUS = 'failed'

export interface TerminalRecordInput {
  /** Runtime state document, parsed; null when absent. */
  readonly state: Record<string, unknown> | null
  /** Runtime `result.json`, parsed; null when absent. */
  readonly result: Record<string, unknown> | null
  /**
   * Runtime's `failure.json`, parsed. `null` when the store was read and holds
   * none; `undefined` when the store has no such document type.
   */
  readonly failure: Record<string, unknown> | null | undefined
}

export interface TerminalRecord {
  readonly supStatus: Measured<string>
  readonly supStatusSource: Measured<SupervisorStatusSource>
  /**
   * Runtime's `reason` on a `no-winner` result. `null` when the record carries
   * none (a winner or a failure record).
   */
  readonly supReason: Measured<string | null>
  /** The recorded error. `null` when the run recorded a result and no error. */
  readonly failure: Measured<TerminalFailure | null>
  /**
   * True when the run recorded a delivered Runtime `winner`; false on every
   * other recorded terminal state; null when no terminal record exists.
   */
  readonly completed: boolean | null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function errorRecord(
  doc: Record<string, unknown>,
  source: TerminalFailure['source'],
  earlierAttempt: boolean,
): TerminalFailure | null {
  if (typeof doc.error !== 'object' || doc.error === null) return null
  const error = asRecord(doc.error)
  return {
    source,
    name: str(error.name),
    message: str(error.message),
    at: str(doc.at),
    earlierAttempt,
  }
}

export function readTerminalRecord(input: TerminalRecordInput): TerminalRecord {
  const { result } = input
  const resultKind = str(result?.kind)
  const settled = resultKind !== null && result !== null
  const failureRecord =
    input.failure === null || input.failure === undefined
      ? null
      : errorRecord(input.failure, 'runtime-failure', settled)

  if (settled) {
    // Runtime's settle record is the status. A failure record beside it is an
    // earlier attempt's throw (Runtime never writes one after a settle), kept
    // as the recorded error with `earlierAttempt` set; a `driver-failed`
    // no-winner carries its own rejection instead.
    return {
      supStatus: resultKind,
      supStatusSource: 'runtime-result',
      supReason: str(result.reason),
      failure: failureRecord ?? errorRecord(result, 'runtime-result', false),
      completed: resultKind === 'winner',
    }
  }

  if (failureRecord !== null) {
    return {
      supStatus: RUNTIME_FAILED_STATUS,
      supStatusSource: 'runtime-failure',
      supReason: null,
      failure: failureRecord,
      completed: false,
    }
  }
  if (input.failure !== null && input.failure !== undefined) {
    // The document exists but carries no `error` object. The run still ended in
    // a failure; only the detail is missing, and it says so.
    return {
      supStatus: RUNTIME_FAILED_STATUS,
      supStatusSource: 'runtime-failure',
      supReason: null,
      failure: unavailable('Runtime failure.json carries no error record'),
      completed: false,
    }
  }

  return {
    supStatus: unavailable(NO_TERMINAL_RECORD),
    supStatusSource: unavailable(NO_TERMINAL_RECORD),
    supReason: unavailable(NO_TERMINAL_RECORD),
    failure: unavailable(NO_TERMINAL_RECORD),
    completed: null,
  }
}
