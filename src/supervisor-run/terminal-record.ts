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

import { asRecord, nonEmptyString as str } from './source-facts'
import {
  type GraphStopSource,
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
  /**
   * The stopping node's output, read beside a `stopped` no-winner result;
   * undefined when the source has none.
   */
  readonly graphStop?: GraphStopSource
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
  /**
   * Why a `stopped` no-winner with no error reports no graph-stop failure:
   * the stopping node, its output or its `reason` is absent. Unset otherwise.
   */
  readonly graphStopGap?: string
}

/** Runtime's `SupervisedResult` reason for a graph that stopped itself. */
export const GRAPH_STOPPED_REASON = 'stopped'

/**
 * The graph's own stop as the run's failure: the stopping node's label and the
 * `reason` string of its output. Returns the absence when either is missing.
 */
function graphStopFailure(
  stop: GraphStopSource | undefined,
): { failure: TerminalFailure } | { gap: string } {
  if (stop === undefined) return { gap: 'graph stop: the source carries no stopping node output' }
  const node = stop.label === null ? 'the last node in result.tree.nodes' : stop.label
  if (stop.absent !== null) return { gap: `graph stop: ${node}: ${stop.absent}` }
  const reason = str(asRecord(stop.output).reason)
  if (reason === null) return { gap: `graph stop: ${node}: output carries no string reason` }
  return {
    failure: {
      source: 'graph-stop',
      name: stop.label,
      message: reason,
      at: null,
      earlierAttempt: false,
    },
  }
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
    // no-winner carries its own rejection instead. A graph that stopped itself
    // records no error; the stopping node's output says why, and any error
    // record outranks it.
    const reason = str(result.reason)
    const failure = failureRecord ?? errorRecord(result, 'runtime-result', false)
    const stop =
      failure === null && resultKind === 'no-winner' && reason === GRAPH_STOPPED_REASON
        ? graphStopFailure(input.graphStop)
        : null
    return {
      supStatus: resultKind,
      supStatusSource: 'runtime-result',
      supReason: reason,
      failure: stop !== null && 'failure' in stop ? stop.failure : failure,
      completed: resultKind === 'winner',
      ...(stop !== null && 'gap' in stop ? { graphStopGap: stop.gap } : {}),
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
