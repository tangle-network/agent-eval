import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createChatClient } from '../src/analyst/chat-client'
import { callLlmJson, type LlmCallRequest, maximumChargeForLlmRequest } from '../src/llm-client'
import { InMemoryRawProviderSink } from '../src/trace/raw-provider-sink'

const servers: Server[] = []
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
  messages: [{ role: 'user', content: 'Return the JSON result.' }],
  maxTokens: 16,
  jsonSchema: {
    name: 'answer',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  },
}
const success = {
  model: 'fixture',
  choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
}
async function endpoint(replies: Array<{ status: number; body: unknown }>) {
  const requests: Array<{ body: Record<string, unknown>; bytes: number }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const part of req) chunks.push(Buffer.from(part))
    const raw = Buffer.concat(chunks)
    requests.push({ body: JSON.parse(raw.toString()), bytes: raw.byteLength })
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!
    res.writeHead(reply.status, { 'Content-Type': 'application/json', 'Retry-After': '0' })
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests }
}
const schemaRejected = { status: 400, body: 'response_format json_schema is not supported' }

describe('one physical attempt budget across schema negotiation', () => {
  it('does not turn maximumAttempts: 1 into two HTTP requests', async () => {
    const { baseUrl, requests } = await endpoint([schemaRejected, { status: 200, body: success }])
    const chat = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      bearer: 'fixture',
      maximumAttempts: 1,
    })
    await expect(chat.chat(request)).rejects.toMatchObject({ status: 400 })
    expect(requests).toHaveLength(1)
  })

  it('shares the remaining attempt budget with transient errors after schema fallback', async () => {
    const { baseUrl, requests } = await endpoint([
      schemaRejected,
      { status: 503, body: 'unavailable' },
      { status: 200, body: success },
    ])
    await expect(
      callLlmJson(request, { baseUrl, apiKey: 'fixture', maximumAttempts: 2 }),
    ).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(2)
    expect(requests.map((entry) => entry.body.response_format)).toEqual([
      expect.objectContaining({ type: 'json_schema' }),
      { type: 'json_object' },
    ])
  })

  it('negotiates schema and temperature within one sequence and retains all raw observations', async () => {
    const { baseUrl, requests } = await endpoint([
      schemaRejected,
      { status: 400, body: 'temperature must be 1' },
      { status: 200, body: success },
    ])
    const sink = new InMemoryRawProviderSink()
    const result = await callLlmJson<{ ok: boolean }>(request, {
      baseUrl,
      apiKey: 'fixture',
      maximumAttempts: 3,
      rawSink: sink,
    })
    expect(result.value).toEqual({ ok: true })
    expect(requests).toHaveLength(3)
    expect(requests[2]?.body.temperature).toBe(1)
    const events = await sink.list()
    expect(events.map((event) => `${event.attemptIndex}:${event.direction}`)).toEqual([
      '0:request',
      '0:error',
      '1:request',
      '1:error',
      '2:request',
      '2:response',
    ])
    const maximum = maximumChargeForLlmRequest(request, { maximumAttempts: 3 })
    expect(maximum && 'inputTokens' in maximum ? maximum.inputTokens : 0).toBeGreaterThanOrEqual(
      requests.reduce((n, entry) => n + entry.bytes, 0),
    )
    expect(maximum && 'outputTokens' in maximum ? maximum.outputTokens : 0).toBe(48)
  })

  it('does not reset the elapsed-time budget when a schema is rejected', async () => {
    const { baseUrl, requests } = await endpoint([schemaRejected, { status: 200, body: success }])
    // An elapsed deadline permits the initial call but no further attempt, as on the ordinary retry path.
    await expect(
      callLlmJson(request, { baseUrl, apiKey: 'fixture', maximumAttempts: 3, deadlineMs: 0 }),
    ).rejects.toMatchObject({ status: 400 })
    expect(requests).toHaveLength(1)
  })

  it('supports JSON-object-only providers in one call through the existing transport option', async () => {
    const { baseUrl, requests } = await endpoint([{ status: 200, body: success }])
    const chat = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      bearer: 'fixture',
      maximumAttempts: 1,
      jsonSchemaTransport: 'json-object',
    })
    const result = await chat.chat(request)
    expect(result.content).toBe('{"ok":true}')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body.response_format).toEqual({ type: 'json_object' })
    expect(request.jsonSchema?.name).toBe('answer')
  })
})
