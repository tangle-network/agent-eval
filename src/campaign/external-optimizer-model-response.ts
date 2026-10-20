import type { ChatResponse } from '../analyst/chat-client'
import type { CostReceiptInput } from '../cost-ledger'
import { encodeAnthropicMessage, renderAnthropicSseStream } from './external-optimizer-anthropic'
import type { ExternalOptimizerEndpointFormat } from './external-optimizer-contracts'
import {
  type ModelProxyPath,
  ProviderResponseTooLargeError,
} from './external-optimizer-model-contract'

export function encodeAnthropicResponseBody(args: {
  callId: string
  response: ChatResponse
  stream: boolean
  maxBytes: number
}): { contentType: string; body: Uint8Array } {
  const message = encodeAnthropicMessage(args.response, args.callId)
  const body = new TextEncoder().encode(
    args.stream ? renderAnthropicSseStream(message) : JSON.stringify(message),
  )
  if (body.byteLength > args.maxBytes) throw new ProviderResponseTooLargeError()
  return {
    contentType: args.stream ? 'text/event-stream; charset=utf-8' : 'application/json',
    body,
  }
}

export function encodeCanonicalModelResponse(args: {
  path: '/v1/chat/completions' | '/v1/responses'
  callId: string
  response: ChatResponse
  receipt: CostReceiptInput
  maxBytes: number
}): Uint8Array {
  const usage = encodeProtocolUsage(args.path, args.response, args.receipt)
  const finishReason =
    args.response.finishReason === undefined ? 'stop' : args.response.finishReason
  const body =
    args.path === '/v1/chat/completions'
      ? {
          id: `chatcmpl-${args.callId}`,
          object: 'chat.completion',
          created: 0,
          model: args.response.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: args.response.content },
              finish_reason: finishReason,
            },
          ],
          ...(usage ? { usage } : {}),
        }
      : {
          id: `resp-${args.callId}`,
          object: 'response',
          created_at: 0,
          model: args.response.model,
          status: finishReason === 'length' ? 'incomplete' : 'completed',
          error: null,
          incomplete_details: finishReason === 'length' ? { reason: 'max_output_tokens' } : null,
          output: [
            {
              id: `msg-${args.callId}`,
              type: 'message',
              status: finishReason === 'length' ? 'incomplete' : 'completed',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: args.response.content,
                  annotations: [],
                },
              ],
            },
          ],
          output_text: args.response.content,
          ...(usage ? { usage } : {}),
        }
  const encoded = new TextEncoder().encode(JSON.stringify(body))
  if (encoded.byteLength > args.maxBytes) throw new ProviderResponseTooLargeError()
  return encoded
}

export function endpointFormat(path: ModelProxyPath): ExternalOptimizerEndpointFormat {
  if (path === '/v1/messages') return 'anthropic-messages'
  return path === '/v1/responses' ? 'responses' : 'chat-completions'
}

function encodeProtocolUsage(
  path: '/v1/chat/completions' | '/v1/responses',
  response: ChatResponse,
  receipt: CostReceiptInput,
): Record<string, unknown> | undefined {
  if (response.usage.captured === false) return undefined
  const inputDetails = {
    ...(receipt.cachedTokens === undefined ? {} : { cached_tokens: receipt.cachedTokens }),
    ...(receipt.cacheWriteTokens === undefined
      ? {}
      : path === '/v1/chat/completions'
        ? { cache_creation_tokens: receipt.cacheWriteTokens }
        : { cache_write_tokens: receipt.cacheWriteTokens }),
  }
  const outputDetails = {
    ...(receipt.reasoningTokens === undefined ? {} : { reasoning_tokens: receipt.reasoningTokens }),
  }
  return path === '/v1/chat/completions'
    ? {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens,
        ...(Object.keys(inputDetails).length > 0 ? { prompt_tokens_details: inputDetails } : {}),
        ...(Object.keys(outputDetails).length > 0
          ? { completion_tokens_details: outputDetails }
          : {}),
        ...(receipt.actualCostUsd === undefined ? {} : { cost: receipt.actualCostUsd }),
      }
    : {
        input_tokens: response.usage.promptTokens,
        output_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens,
        ...(Object.keys(inputDetails).length > 0 ? { input_tokens_details: inputDetails } : {}),
        ...(Object.keys(outputDetails).length > 0 ? { output_tokens_details: outputDetails } : {}),
        ...(receipt.actualCostUsd === undefined ? {} : { cost: receipt.actualCostUsd }),
      }
}
