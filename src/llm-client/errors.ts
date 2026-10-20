import { AgentEvalError } from '../errors'
import type { LlmCallResult } from './contract'

export class LlmCallError extends AgentEvalError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly model: string,
  ) {
    super('judge', message)
  }
}

/** A provider response completed and incurred measurable usage, but its content
 *  could not satisfy the caller's response contract. The response envelope is
 *  retained so accounting can commit the receipt before the error propagates. */
export class LlmResponseError extends AgentEvalError {
  constructor(
    message: string,
    public readonly result: LlmCallResult,
    options?: { cause?: unknown },
  ) {
    super('judge', message, options)
  }
}
