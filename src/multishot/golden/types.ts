// Golden-record types for the multishot conversation contract.
//
// A golden record freezes what one deterministic scenario produced: every
// transport request each leg received, and the value the run resolved or threw
// with. An engine conforms when it reproduces both, field for field.

import type { MultishotResult, MultishotToolDefinition } from '../types'

/** One chat message as it reached a transport, normalized to the fields that
 *  decide behaviour. `content` is `null` when the message carried none. */
export interface MultishotRecordedMessage {
  role: string
  content: string | null
  /** Present on a tool result message. */
  toolCallId?: string
  /** Present on an assistant message that dispatched tools. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
}

/** One transport call, recorded in issue order. The ledger pins the sampling
 *  contract (per-leg temperature and token budget), the model rotation order,
 *  the tool advertisement, and the exact message log each leg saw — the four
 *  places two orchestrators diverge without the returned result changing. */
export interface MultishotRecordedRequest {
  leg: 'agent' | 'driver'
  model: string
  temperature: number | null
  maxTokens: number | null
  /** The tool definitions advertised, in order, compared by value. `null` when
   *  the request carried no tools. An engine that rebuilds the array is free to
   *  do so; an engine that changes a name, a description or a parameter schema
   *  changes what the agent is offered, and that is the divergence. */
  tools: MultishotToolDefinition[] | null
  messages: MultishotRecordedMessage[]
}

/** `MultishotResult` without wall-clock `durationMs`, which no two runs share. */
export type RecordedMultishotResult = Omit<MultishotResult, 'durationMs'>

/** A throw, reduced to what a caller can observe: the constructor name, the
 *  message, and the cell spend the throw declares. */
export interface RecordedMultishotError {
  name: string
  message: string
  /** Spend the throw carries for the matrix cost ceiling, or `null` when it
   *  carries none. `durationMs` is wall clock and is not recorded. */
  cellSpend: { costUsd: number; kind: 'observed' | 'estimated' | 'uncaptured' } | null
}

export type MultishotGoldenOutcome =
  | { kind: 'result'; result: RecordedMultishotResult }
  | { kind: 'error'; error: RecordedMultishotError }

export interface MultishotGoldenRecord {
  id: string
  description: string
  requests: MultishotRecordedRequest[]
  outcome: MultishotGoldenOutcome
}

/** One judge call the matrix issued, recorded from the request body. */
export interface RecordedJudgeRequest {
  model: string
  temperature: number | null
  maxTokens: number | null
  messages: MultishotRecordedMessage[]
}

export interface MultishotMatrixGoldenRecord {
  id: string
  description: string
  requests: MultishotRecordedRequest[]
  judgeRequests: RecordedJudgeRequest[]
  /** The returned `MatrixResult`, with wall-clock and run-identity keys removed. */
  matrix: unknown
  /** Every file the run persisted under its run directory, keyed by
   *  slash-separated relative path. JSON files are parsed and stripped of
   *  wall-clock keys; Markdown is kept as text with wall-clock tokens masked. */
  files: Record<string, unknown>
}

/** A frozen fixture version. Records are append-only: a behaviour change mints
 *  a NEW version file, never an edit to a released one. */
export interface MultishotGoldenRecordSet {
  version: string
  /** Engine the records were captured from, as `<module>#<export>`. */
  recordedFrom: string
  /** Package version that captured them. */
  recordedFromPackageVersion: string
  recordedAt: string
  scenarios: MultishotGoldenRecord[]
  matrixScenarios: MultishotMatrixGoldenRecord[]
}
