import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertCrossFamilyServed } from '../integrity/served-model'
import { createChatClient } from './chat-client'

interface RecordedRequest {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  xAuth: string | undefined
  body: Record<string, unknown>
}

let server: Server
let baseUrl: string
const received: RecordedRequest[] = []
/** Consecutive 429s a path still owes, keyed by the marker in the request model. */
const rateLimitDebt = new Map<string, number>()

function completion(model: string, content: string): string {
  return JSON.stringify({
    id: 'cmpl-test',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
  })
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        xAuth: req.headers['x-auth'] as string | undefined,
        body,
      })
      const requested = String(body.model ?? '')
      const owed = rateLimitDebt.get(requested) ?? 0
      if (owed > 0) {
        rateLimitDebt.set(requested, owed - 1)
        res.writeHead(429, { 'content-type': 'text/plain' })
        res.end('slow down')
        return
      }
      // The gateway answers as itself, except for the one id that names a
      // substitution — that is the case the servedModel echo exists to catch.
      const served = requested === 'ask-for-glm' ? 'gpt-5.2' : requested
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(completion(served, 'OK'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe("createChatClient({ transport: 'openai-compatible' })", () => {
  it('POSTs {baseUrl}/chat/completions with the bearer and returns the canonical result', async () => {
    const client = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    })

    const result = await client.chat({
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      maxTokens: 16,
    })

    expect(result.content).toBe('OK')
    expect(result.usage.promptTokens).toBe(11)
    expect(result.finishReason).toBe('stop')
    const request = received.at(-1)!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/v1/chat/completions')
    expect(request.authorization).toBe('Bearer test-key')
    expect(request.body.model).toBe('claude-sonnet-4-6')
    expect(client.transport).toBe('openai-compatible')
  })

  it('carries the provider-echoed id on servedModel, so a substitution is visible', async () => {
    const client = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'test-key',
    })

    const honest = await client.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const substituted = await client.chat({
      model: 'ask-for-glm',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(honest.servedModel).toBe('claude-sonnet-4-6')
    expect(substituted.servedModel).toBe('gpt-5.2')
    // `model` is the attribution id and follows the echo; `servedModel` is the
    // evidence. A transport that reported neither would read `unreported`.
    expect(substituted.model).toBe('gpt-5.2')
  })

  it('feeds assertCrossFamilyServed: two real families pass, a collapsed panel throws', async () => {
    const client = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'test-key',
    })

    const anthropic = await client.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const zhipu = await client.chat({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(
      assertCrossFamilyServed([
        { requested: 'claude-sonnet-4-6', served: anthropic.servedModel },
        { requested: 'glm-5.3', served: zhipu.servedModel },
      ]),
    ).toEqual(['anthropic', 'zhipu'])

    const collapsed = await client.chat({
      model: 'ask-for-glm',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(() =>
      assertCrossFamilyServed([
        { requested: 'claude-sonnet-4-6', served: anthropic.servedModel },
        { requested: 'ask-for-glm', served: collapsed.servedModel },
      ]),
    ).toThrow()
  })

  it('honours assertServedModel, throwing on the substitution rather than scoring it', async () => {
    const client = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'test-key',
      assertServedModel: true,
      maximumAttempts: 1,
    })

    await expect(
      client.chat({ model: 'ask-for-glm', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/gpt-5\.2/)
  })

  it('retries a 429 inside the bound the caller set', async () => {
    rateLimitDebt.set('retry-me', 1)
    const client = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'test-key',
      maximumAttempts: 3,
    })

    const result = await client.chat({
      model: 'retry-me',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(result.content).toBe('OK')
    expect(rateLimitDebt.get('retry-me')).toBe(0)
    expect(client.maximumAttempts).toBe(3)
  })

  it('sends a caller-supplied authorization header instead of a bearer', async () => {
    const client = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      authHeader: { name: 'X-Auth', value: 'sk-header' },
      defaultModel: 'glm-5.3',
    })

    await client.chat({ messages: [{ role: 'user', content: 'hi' }] })

    const request = received.at(-1)!
    expect(request.xAuth).toBe('sk-header')
    expect(request.authorization).toBeUndefined()
  })

  it('falls back to defaultModel, and refuses when neither is present', async () => {
    const bound = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'test-key',
      defaultModel: 'glm-5.3',
    })
    await bound.chat({ messages: [{ role: 'user', content: 'hi' }] })
    expect(received.at(-1)!.body.model).toBe('glm-5.3')

    const unbound = createChatClient({
      transport: 'openai-compatible',
      baseUrl,
      apiKey: 'test-key',
    })
    await expect(unbound.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /no model/i,
    )
  })
})

describe("createChatClient({ transport: 'openai-compatible' }) refusals", () => {
  it('refuses a missing credential rather than calling the endpoint unauthenticated', () => {
    expect(() =>
      createChatClient({ transport: 'openai-compatible', baseUrl, defaultModel: 'glm-5.3' }),
    ).toThrow(/apiKey, bearer, or authHeader/)
  })

  it('refuses an empty baseUrl rather than defaulting to a provider', () => {
    expect(() =>
      createChatClient({ transport: 'openai-compatible', baseUrl: '  ', apiKey: 'k' }),
    ).toThrow(/baseUrl is required/)
  })

  it('refuses a baseUrl that already carries the /chat/completions path', () => {
    expect(() =>
      createChatClient({
        transport: 'openai-compatible',
        baseUrl: 'https://router.example/v1/chat/completions',
        apiKey: 'k',
      }),
    ).toThrow(/appends \/chat\/completions/)
  })

  it('does not read a credential out of the environment', () => {
    const before = { ...process.env }
    process.env.OPENAI_API_KEY = 'should-not-be-used'
    process.env.AGENT_EVAL_LLM_API_KEY = 'should-not-be-used'
    try {
      expect(() => createChatClient({ transport: 'openai-compatible', baseUrl })).toThrow(
        /apiKey, bearer, or authHeader/,
      )
    } finally {
      process.env = before
    }
  })
})
