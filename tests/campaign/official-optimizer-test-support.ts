import { createServer } from 'node:http'
import type { OpenAICompatibleOptimizerModel } from '../../src/campaign'

export interface CapturedModelRequest {
  authorization: string | undefined
  path: string | undefined
  body: Record<string, unknown>
}

export async function startModelServer(content: string): Promise<{
  baseUrl: string
  requests: CapturedModelRequest[]
  close: () => Promise<void>
}> {
  const requests: CapturedModelRequest[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    requests.push({
      authorization: request.headers.authorization,
      path: request.url,
      body,
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            index: 0,
            message: { content, role: 'assistant' },
          },
        ],
        created: 0,
        id: 'chatcmpl-local',
        model: 'local-model',
        object: 'chat.completion',
        usage: {
          completion_tokens: 13,
          prompt_tokens: 11,
          total_tokens: 24,
        },
      }),
    )
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('model server failed to bind')

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

export function localOptimizerModel(
  baseUrl: string,
  options: { model?: string; maxRequests?: number; maxOutputTokens?: number } = {},
): OpenAICompatibleOptimizerModel {
  const model = options.model ?? 'local-model'
  return {
    model,
    callRef: `test-local-model:${baseUrl}`,
    call: async (request) => {
      const response = await fetch(`${baseUrl.replace(/\/v1$/, '')}${request.path}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer provider-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
        signal: request.signal,
      })
      const value = (await response.clone().json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      return {
        succeeded: true,
        response,
        receipt:
          value.usage?.prompt_tokens !== undefined && value.usage.completion_tokens !== undefined
            ? {
                model: request.model,
                inputTokens: value.usage.prompt_tokens,
                outputTokens: value.usage.completion_tokens,
                customTokenPricing: {
                  inputUsdPerMillion: 1,
                  outputUsdPerMillion: 2,
                },
              }
            : {
                model: request.model,
                inputTokens: 0,
                outputTokens: 0,
                usageUnknown: true,
                costUnknown: true,
              },
        execution: {
          kind: 'test-local-model',
          model: request.model,
          status: response.status,
        },
      }
    },
    budget: {
      maxCostUsd: 1,
      maxRequests: options.maxRequests ?? 10,
      maxRequestBytes: 100_000,
      maxResponseBytes: 100_000,
      maxOutputTokensPerRequest: options.maxOutputTokens ?? 2_000,
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
      },
    },
  }
}
