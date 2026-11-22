import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callLlm } from '../src/llm-client'

// Node's fetch sends through one shared dispatcher, kept under this key. It is
// the key undici's own `setGlobalDispatcher` writes.
const DISPATCHER = Symbol.for('undici.globalDispatcher.1')
interface NodeDispatcher {
  constructor: new (options: { headersTimeout: number }) => NodeDispatcher
  close(): Promise<void>
}
const shared = globalThis as unknown as Record<symbol, NodeDispatcher>

describe('a call allowed longer than Node fetch waits for response headers', () => {
  let server: Server
  let baseUrl: string
  let nodeDefault: NodeDispatcher
  let answerAfterMs = 0

  beforeEach(async () => {
    // A provider that sends nothing, not even headers, until its answer is whole.
    server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              model: 'slow-model',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: 'late but whole' },
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
            }),
          )
        }, answerAfterMs)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    // Node creates its dispatcher on the first fetch.
    answerAfterMs = 0
    await (await fetch(baseUrl)).text()
    nodeDefault = shared[DISPATCHER]!
  })

  afterEach(async () => {
    shared[DISPATCHER] = nodeDefault
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  it('is answered when the model is done, not dropped at the header limit', async () => {
    // Node's own fetch, with its 300 s header limit scaled down to 1 s, and a
    // model that needs 4 s. The ratio is the production failure: the answer
    // comes after the limit and well inside what the caller allowed.
    const scaled = new nodeDefault.constructor({ headersTimeout: 1_000 })
    shared[DISPATCHER] = scaled
    answerAfterMs = 4_000
    const ask = (timeoutMs: number) =>
      callLlm(
        {
          model: 'slow-model',
          messages: [{ role: 'user', content: 'think for a while' }],
          timeoutMs,
        },
        { baseUrl, apiKey: 'test-key', maximumAttempts: 1 },
      )
    try {
      // The instrument works: a call that travels on fetch dies at the limit.
      await expect(ask(60_000)).rejects.toThrow(/fetch failed/)
      // A call allowed more than 300 s used to travel the same way and die the
      // same way, on every attempt.
      const answer = await ask(301_000)
      expect(answer.content).toBe('late but whole')
      expect(answer.usage.completionTokens).toBe(4)
    } finally {
      await scaled.close()
    }
  }, 60_000)
})
