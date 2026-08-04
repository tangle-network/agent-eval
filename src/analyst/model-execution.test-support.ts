import type {
  ExternalOptimizerModelCall,
  ExternalOptimizerModelExecutionObservation,
} from '../campaign/external-optimizer-process'
import type { CostReceiptInput, CustomTokenPricing } from '../cost-ledger'
import { costReceiptFromLlm, LlmCallError, type LlmCallRequest, LlmClient } from '../llm-client'

interface TestModelExecutionOwnerOptions {
  baseUrl?: string
  bearer?: string
  fetchImpl: typeof fetch
  pricing?: CustomTokenPricing
  callRef?: string
  onExecution?: (observation: ExternalOptimizerModelExecutionObservation) => void
}

/** Test-only execution owner. Production analyst code contains no provider transport. */
export function testModelExecutionOwner(options: TestModelExecutionOwnerOptions): {
  call: ExternalOptimizerModelCall
  callRef: string
  recordExecution: (observation: ExternalOptimizerModelExecutionObservation) => void
} {
  return {
    callRef: options.callRef ?? 'test-owner:fake-runtime',
    call: async (request) => {
      const startedAt = performance.now()
      try {
        const client = new LlmClient({
          baseUrl: options.baseUrl ?? 'https://test-owner.invalid/v1',
          bearer: options.bearer,
          fetch: options.fetchImpl,
          maximumAttempts: 1,
          customTokenPricing: options.pricing,
        })
        const response = await client.call(
          structuredClone(request.request) as unknown as LlmCallRequest,
          { signal: request.signal, idempotencyKey: request.callId },
        )
        return {
          succeeded: true,
          response,
          receipt: serializableReceipt(costReceiptFromLlm(response, options.pricing)),
          execution: {
            kind: 'test-model-execution',
            model: request.request.model,
            durationMs: performance.now() - startedAt,
          },
        }
      } catch (error) {
        return {
          succeeded: false,
          error: error instanceof Error ? error.message : String(error),
          receipt: unknownReceipt(request.request.model),
          execution: {
            kind: 'test-model-execution',
            model: request.request.model,
            error: error instanceof Error ? error.name : 'Error',
            ...(error instanceof LlmCallError ? { status: error.status } : {}),
            durationMs: performance.now() - startedAt,
          },
        }
      }
    },
    recordExecution: (observation) => {
      options.onExecution?.(structuredClone(observation))
    },
  }
}

function serializableReceipt(receipt: CostReceiptInput): CostReceiptInput {
  return JSON.parse(JSON.stringify(receipt)) as CostReceiptInput
}

function unknownReceipt(model: string): CostReceiptInput {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    usageUnknown: true,
    costUnknown: true,
  }
}
