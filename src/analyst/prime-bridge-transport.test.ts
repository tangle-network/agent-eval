import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeHttpPrimeBridgeTransport } from './prime-bridge-transport'

interface RecordedRequest {
  method: string | undefined
  url: string | undefined
  contentType: string | string[] | undefined
  body: string
}

let server: Server
let origin: string
const received: RecordedRequest[] = []

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (req.url?.includes('fail')) {
        res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('bridge down')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe('nodeHttpPrimeBridgeTransport', () => {
  it('POSTs the chat-completions body and returns the raw status and text', async () => {
    const controller = new AbortController()
    const result = await nodeHttpPrimeBridgeTransport()({
      url: `${origin}/v1/chat/completions`,
      body: { model: 'prime/zai/glm-5.2', messages: [{ role: 'user', content: 'hello' }] },
      signal: controller.signal,
    })

    expect(result.status).toBe(200)
    expect(JSON.parse(result.text).choices[0].message.content).toBe('ok')
    const request = received.at(-1)!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/v1/chat/completions')
    expect(request.contentType).toBe('application/json')
    expect(JSON.parse(request.body)).toEqual({
      model: 'prime/zai/glm-5.2',
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('sends the query string the caller supplied instead of a different URL', async () => {
    const controller = new AbortController()
    await nodeHttpPrimeBridgeTransport()({
      url: `${origin}/v1/chat/completions?tenant=acme&seat=3`,
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      signal: controller.signal,
    })

    expect(received.at(-1)!.url).toBe('/v1/chat/completions?tenant=acme&seat=3')
  })

  it('returns a non-200 status rather than throwing, so the caller classifies it', async () => {
    const controller = new AbortController()
    const result = await nodeHttpPrimeBridgeTransport()({
      url: `${origin}/v1/chat/completions/fail`,
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      signal: controller.signal,
    })

    expect(result).toEqual({ status: 503, text: 'bridge down' })
  })

  it('aborts the in-flight request when the signal fires', async () => {
    const controller = new AbortController()
    const pending = nodeHttpPrimeBridgeTransport()({
      url: `${origin}/v1/chat/completions`,
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      signal: controller.signal,
    })
    controller.abort()

    await expect(pending).rejects.toThrow()
  })

  it('accepts https and refuses any other scheme', async () => {
    const transport = nodeHttpPrimeBridgeTransport()
    expect(() =>
      transport({
        url: 'ftp://bridge.test/v1/chat/completions',
        body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        signal: new AbortController().signal,
      }),
    ).toThrow(/bridge URL must be http: or https:, got ftp:/)

    // An https URL reaches the request, so the only way out is the abort — a
    // scheme rejection would have thrown synchronously instead.
    const controller = new AbortController()
    const pending = transport({
      url: 'https://bridge.invalid/v1/chat/completions',
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})
