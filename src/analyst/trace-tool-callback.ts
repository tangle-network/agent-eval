import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  type ExternalOptimizerCallbackLimits,
  resolveExternalOptimizerCallbackLimits,
} from '../campaign/external-optimizer-contracts'
import {
  closeServer,
  listenLocal,
  sendJsonIfOpen,
  waitForActiveHandlers,
} from '../campaign/external-optimizer-http'
import type { TraceAnalysisToolDescriptor } from '../trace-analyst/tools'

export interface TraceToolCallback {
  url: string
  token: string
  calls: () => number
  close: () => Promise<void>
}

export type TraceToolCallbackLimits = ExternalOptimizerCallbackLimits

/** Expose one bounded trace-tool set only on an authenticated loopback socket. */
export async function startTraceToolCallback(args: {
  tools: readonly TraceAnalysisToolDescriptor[]
  maxCalls: number
  /** Trace-tool request/response byte limits. Omitted fields use finite defaults. */
  limits?: Partial<TraceToolCallbackLimits>
  signal?: AbortSignal
}): Promise<TraceToolCallback> {
  if (!Number.isSafeInteger(args.maxCalls) || args.maxCalls <= 0) {
    throw new TypeError('trace tool callback maxCalls must be a positive safe integer')
  }
  const limits = resolveExternalOptimizerCallbackLimits(args.limits, 'trace tool callback limits')
  args.signal?.throwIfAborted()
  const byName = new Map(args.tools.map((tool) => [tool.name, tool]))
  if (byName.size !== args.tools.length) {
    throw new Error('trace tool callback received duplicate tool names')
  }

  const token = randomBytes(32).toString('hex')
  let calls = 0
  let accepting = true
  let closePromise: Promise<void> | undefined
  const activeControllers = new Set<AbortController>()
  const activeHandlers = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    if (!accepting) {
      sendJsonIfOpen(response, 503, { error: 'trace tool callback is closing' })
      return
    }
    const controller = new AbortController()
    const abortRequest = (): void => {
      request.destroy()
      response.destroy()
    }
    activeControllers.add(controller)
    controller.signal.addEventListener('abort', abortRequest, { once: true })

    let handler!: Promise<void>
    handler = handleRequest(request, response, controller.signal).finally(() => {
      controller.signal.removeEventListener('abort', abortRequest)
      activeControllers.delete(controller)
      activeHandlers.delete(handler)
    })
    activeHandlers.add(handler)
    void handler.catch(() => undefined)
  })
  const port = await listenLocal(server)
  const close = (): Promise<void> => {
    closePromise ??= closeCallback()
    return closePromise
  }
  const onAbort = (): void => {
    void close().catch(() => undefined)
  }
  args.signal?.addEventListener('abort', onAbort, { once: true })
  if (args.signal?.aborted) onAbort()

  return {
    url: `http://127.0.0.1:${port}/call`,
    token,
    calls: () => calls,
    close,
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/call') {
        sendJsonIfOpen(response, 404, { error: 'not found' })
        return
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        sendJsonIfOpen(response, 401, { error: 'unauthorized' })
        return
      }
      if (calls >= args.maxCalls) {
        sendJsonIfOpen(response, 429, { error: 'trace tool call limit reached' })
        return
      }
      const body = await readJson(request, limits.maxRequestBytes)
      if (!isRecord(body) || typeof body.name !== 'string' || !('args' in body)) {
        sendJsonIfOpen(response, 400, { error: 'name and args are required' })
        return
      }
      const tool = byName.get(body.name)
      if (!tool) {
        sendJsonIfOpen(response, 404, { error: `unknown trace tool '${body.name}'` })
        return
      }
      calls += 1
      const result = await tool.handler(body.args, { signal })
      const encoded = JSON.stringify({ result })
      if (Buffer.byteLength(encoded) > limits.maxResponseBytes) {
        sendJsonIfOpen(response, 413, { error: 'trace tool response too large' })
        return
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(encoded)),
      })
      response.end(encoded)
    } catch (error) {
      sendJsonIfOpen(response, signal.aborted ? 499 : 400, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function closeCallback(): Promise<void> {
    args.signal?.removeEventListener('abort', onAbort)
    accepting = false
    const closingServer = closeServer(server)
    server.closeIdleConnections?.()
    for (const controller of activeControllers) controller.abort()
    const [serverResult] = await Promise.allSettled([
      closingServer,
      waitForActiveHandlers(activeHandlers),
    ])
    if (activeControllers.size !== 0 || activeHandlers.size !== 0) {
      throw new Error('trace tool callback closed with active requests')
    }
    if (serverResult?.status === 'rejected') throw serverResult.reason
  }
}

function readJson(request: IncomingMessage, maxRequestBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxRequestBytes) {
        reject(new Error('trace tool request too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
