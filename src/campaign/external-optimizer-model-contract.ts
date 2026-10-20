import type { CostReceiptInput } from '../cost-ledger'
import type { ExternalOptimizerModelExecutionObservation } from './external-optimizer-contracts'

export type ModelProxyPath = '/v1/chat/completions' | '/v1/responses' | '/v1/messages'

export type ModelProxyWire = 'openai' | 'anthropic'

export type UnsequencedExecutionObservation =
  ExternalOptimizerModelExecutionObservation extends infer T
    ? T extends ExternalOptimizerModelExecutionObservation
      ? Omit<T, 'sequence'>
      : never
    : never

export interface ProviderProxyResponse {
  status: number
  contentType: string
  body: Uint8Array
  receipt: CostReceiptInput
  usageComplete: boolean
  /** A Runtime-owned call failed after returning complete execution evidence. */
  modelCallFailed?: string
  /** Set when the response violated the output or reasoning limit; forces a 502. */
  usageRejected?: string
}

export class RequestBodyTooLargeError extends Error {}

export class ProviderResponseTooLargeError extends Error {
  constructor() {
    super('optimizer model response exceeds maxResponseBytes')
  }
}

export class MissingModelExecutionError extends Error {}

export class ModelExecutionPersistenceError extends Error {}

export class OwnerModelContractError extends Error {}
