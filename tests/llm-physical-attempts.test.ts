import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createChatClient } from '../src/analyst/chat-client'
import {
  callLlm,
  callLlmJson,
  costReceiptFromLlm,
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
        await delay(300)
        schemaRejected(res)
        return
      }
      success(res)
    })
    await expect(
      callLlmJson(request, { baseUrl, maximumAttempts: 3, deadlineMs: 100 }),
    ).rejects.toMatchObject({ name: 'AbortError' })
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

describe('physical request lifetime and receipt consistency', () => {
  it.each([200, 503])('bounds the complete HTTP %i body, not only its headers', async (status) => {
    let closed!: () => void
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve
    })
    const { baseUrl, requests } = await endpoint((res) => {
      res.on('close', closed)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.flushHeaders()
      res.write('{"incomplete":')
      // Deliberately never finish the body. The client's timeout must close the connection.
    })
    const watchdog = new AbortController()
    const timer = setTimeout(() => watchdog.abort(new Error('test watchdog')), 2_000)
    const started = performance.now()
    try {
      await expect(
        callLlm(
          { ...request, timeoutMs: 150 },
          {
            baseUrl,
            maximumAttempts: 1,
            signal: watchdog.signal,
          },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(performance.now() - started).toBeLessThan(1_500)
      await Promise.race([
        disconnected,
        delay(1_000).then(() => {
          throw new Error('provider connection did not close')
        }),
      ])
      expect(requests).toHaveLength(1)
    } finally {
      clearTimeout(timer)
    }
  })

  it('cancels Retry-After backoff without buying another request', async () => {
    const controller = new AbortController()
    const events: RawProviderEvent[] = []
    const { baseUrl, requests } = await endpoint((res) => {
      res.writeHead(429, { 'Retry-After': '2' })
      res.end('busy')
    })
    let cancelledAt = 0
    const result = callLlm(request, {
      baseUrl,
      maximumAttempts: 3,
      signal: controller.signal,
      rawSink: {
        record(event) {
          events.push(event)
          if (event.direction === 'error' && event.statusCode === 429) {
            setTimeout(() => {
              cancelledAt = performance.now()
              controller.abort(new Error('owner cancelled'))
            }, 30)
          }
        },
      },
    })
    await expect(result).rejects.toThrow('owner cancelled')
    expect(performance.now() - cancelledAt).toBeLessThan(1_000)
    expect(requests).toHaveLength(1)
    expect(events.filter((event) => event.direction === 'request')).toHaveLength(1)
  })

  it('clamps server backoff to the remaining whole-operation deadline', async () => {
    const { baseUrl, requests } = await endpoint((res) => {
      res.writeHead(429, { 'Retry-After': '10' })
      res.end('busy')
    })
    const started = performance.now()
    // The server asks for 10 s and the whole call has 3 s, which leaves the first request room on
    // a loaded runner (at 150 ms the request itself was aborted, publish run 37238259408). The call
    // ends with the server's 429 at once: sleeping to the deadline let an early timer start one more
    // attempt with no time left, and its abort replaced the 429.
    await expect(
      callLlm(request, {
        baseUrl,
        maximumAttempts: 3,
        deadlineMs: 3_000,
      }),
    ).rejects.toMatchObject({ status: 429 })
    expect(performance.now() - started).toBeLessThan(1_500)
    expect(requests).toHaveLength(1)
  })

  it('reports a caller abort that lands while a final answer is recorded', async () => {
    const { baseUrl } = await endpoint((res) => {
      res.writeHead(429, { 'Retry-After': '10' })
      res.end('busy')
    })
    const controller = new AbortController()
    const reason = new Error('caller stopped the call')
    await expect(
      callLlm(request, {
        baseUrl,
        maximumAttempts: 3,
        deadlineMs: 3_000,
        signal: controller.signal,
        rawSink: {
          // The answer has been read when its error event is recorded.
          async record(event) {
            if (event.direction === 'error') controller.abort(reason)
          },
        },
      }),
    ).rejects.toBe(reason)
  })

  it('does not dispatch when the whole-operation deadline is already exhausted', async () => {
    const { baseUrl, requests } = await endpoint((res) => success(res))
    await expect(callLlm(request, { baseUrl, deadlineMs: 0 })).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(requests).toHaveLength(0)
  })

  it.each(['-1', '1e400', '0'])(
    'interprets the same reported cost in response and receipt (%s)',
    async (cost) => {
      const { baseUrl } = await endpoint((res) => {
        res.setHeader('content-type', 'application/json')
        res.end(
          `{"model":"unpriced-fixture","choices":[{"message":{"content":"checked"}}],"cost_usd":${cost}}`,
        )
      })
      const result = await callLlm(
        { ...request, model: 'unpriced-fixture' },
        {
          baseUrl,
          maximumAttempts: 1,
        },
      )
      const receipt = costReceiptFromLlm(result)
      expect(result.costUsd).toBe(cost === '0' ? 0 : null)
      expect(receipt.actualCostUsd).toBe(cost === '0' ? 0 : undefined)
      expect(receipt.estimatedCostUsd).toBeUndefined()
      expect(result.usage.captured).toBe(false)
    },
  )
})
