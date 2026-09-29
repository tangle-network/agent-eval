import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createChatClient } from '../src/analyst/chat-client'
import {
  callLlm,
  callLlmJson,
  type LlmCallRequest,
  maximumChargeForLlmRequest,
} from '../src/llm-client'
import type { RawProviderEvent } from '../src/trace/raw-provider-sink'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
const request: LlmCallRequest = {
  model: 'fixture',
  messages: [{ role: 'user', content: 'Return the checked result' }],
  jsonSchema: {
    name: 'result',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
  maxTokens: 10,
}
const success = (response: ServerResponse) => {
  response.setHeader('content-type', 'application/json')
  response.end(
    JSON.stringify({
      model: 'fixture',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }),
  )
}
async function endpoint(
  handle: (
    res: ServerResponse,
    body: Record<string, unknown>,
    ordinal: number,
  ) => void | Promise<void>,
) {
  const requests: { body: Record<string, unknown>; key: string | string[] | undefined }[] = []
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ body, key: req.headers['idempotency-key'] })
      await handle(res, body, requests.length)
    } catch (error) {
      res.destroy(error instanceof Error ? error : new Error('fixture failed'))
    }
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests }
}
const schemaRejected = (res: ServerResponse) => {
  res.writeHead(400)
  res.end('response_format json_schema not supported')
}

describe('one physical request budget across structured fallback', () => {
  it('never buys a second request when a one-attempt structured call rejects its schema', async () => {
    const { baseUrl, requests } = await endpoint((res, _body, ordinal) =>
      ordinal === 1 ? schemaRejected(res) : success(res),
    )
    const client = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'fixture-only',
      maximumAttempts: 1,
    })
    await expect(client.chat(request)).rejects.toMatchObject({ status: 400 })
    expect(requests).toHaveLength(1)
  })

  it('keeps schema and temperature fallback in one ordered raw-event sequence', async () => {
    const { baseUrl, requests } = await endpoint((res, _body, ordinal) => {
      if (ordinal === 1) return schemaRejected(res)
      if (ordinal === 2) {
        res.writeHead(400)
        res.end('temperature must be 1')
        return
      }
      success(res)
    })
    const events: RawProviderEvent[] = []
    const { value, result } = await callLlmJson(request, {
      baseUrl,
      maximumAttempts: 3,
      idempotencyKey: 'logical-operation',
      rawSink: {
        record: (event) => {
          events.push(event)
        },
      },
    })
    expect(value).toEqual({ ok: true })
    expect(result.usage.promptTokens).toBe(12)
    expect(requests.map(({ body }) => body.response_format)).toEqual([
      expect.objectContaining({ type: 'json_schema' }),
      { type: 'json_object' },
      { type: 'json_object' },
    ])
    expect(requests.map(({ body }) => body.temperature)).toEqual([0, 0, 1])
    expect(requests.map(({ key }) => key)).toEqual(Array(3).fill('logical-operation'))
    expect(
      events.filter((event) => event.direction === 'request').map((event) => event.attemptIndex),
    ).toEqual([0, 1, 2])
  })

  it('does not reset transient retry allowance at schema fallback', async () => {
    const { baseUrl, requests } = await endpoint((res, _body, ordinal) => {
      if (ordinal === 1) {
        res.writeHead(503, { 'Retry-After': '0.001' })
        res.end('busy')
        return
      }
      if (ordinal === 2) return schemaRejected(res)
      success(res)
    })
    await expect(callLlmJson(request, { baseUrl, maximumAttempts: 2 })).rejects.toMatchObject({
      status: 400,
    })
    expect(requests).toHaveLength(2)
  })

  it('does not reset an expired cross-attempt deadline at schema fallback', async () => {
    const { baseUrl, requests } = await endpoint(async (res, _body, ordinal) => {
      if (ordinal === 1) {
        await delay(60)
        schemaRejected(res)
        return
      }
      success(res)
    })
    await expect(
      callLlmJson(request, { baseUrl, maximumAttempts: 3, deadlineMs: 5 }),
    ).rejects.toMatchObject({ status: 400 })
    expect(requests).toHaveLength(1)
  })

  it('preserves the raw-call contract: it does not negotiate JSON mode', async () => {
    const { baseUrl, requests } = await endpoint((res) => schemaRejected(res))
    await expect(callLlm(request, { baseUrl, maximumAttempts: 3 })).rejects.toMatchObject({
      status: 400,
    })
    expect(requests).toHaveLength(1)
  })

  it('keeps explicitly selected JSON mode and structured result validation', async () => {
    const { baseUrl, requests } = await endpoint((res) => success(res))
    const { value } = await callLlmJson(request, {
      baseUrl,
      maximumAttempts: 1,
      jsonSchemaTransport: 'json-object',
    })
    expect(value).toEqual({ ok: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body.response_format).toEqual({ type: 'json_object' })
  })

  it('does not reserve a phantom second batch for schema fallback', async () => {
    const { baseUrl, requests } = await endpoint((res, _body, ordinal) =>
      ordinal === 1 ? schemaRejected(res) : success(res),
    )
    await callLlmJson(request, { baseUrl, maximumAttempts: 2 })
    const bound = maximumChargeForLlmRequest(request, { maximumAttempts: 2 })
    expect(bound).toMatchObject({ model: 'fixture', outputTokens: 20 })
    expect(requests).toHaveLength(2)
    const actualInputBytes = requests.reduce(
      (n, entry) => n + Buffer.byteLength(JSON.stringify(entry.body)),
      0,
    )
    expect(bound && 'inputTokens' in bound ? bound.inputTokens : 0).toBeGreaterThanOrEqual(
      actualInputBytes,
    )
  })
})
