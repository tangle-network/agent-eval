import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  type ExternalOptimizerCallback,
  type ExternalTextEvaluationRequest,
  isExternalTextCandidate,
  isRecord,
} from './external-optimizer-contracts'
import { closeServer, listenLocal, sendJson } from './external-optimizer-http'

const MAX_CALLBACK_BODY_BYTES = 1_000_000

export async function startExternalOptimizerCallback<TResponse>(args: {
  token: string
  maxEvaluations: number
  acceptEvaluation?: () => number | undefined
  evaluate: (request: ExternalTextEvaluationRequest, signal: AbortSignal) => Promise<TResponse>
  signal?: AbortSignal
}): Promise<ExternalOptimizerCallback> {
  assertCallbackConfig(args)
  args.signal?.throwIfAborted()
  let evaluations = 0
  let accepting = true
  let closePromise: Promise<void> | undefined
  const activeControllers = new Set<AbortController>()
  const activeHandlers = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    if (!accepting) {
      sendJsonIfOpen(response, 503, { error: 'external optimizer callback is closing' })
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
    handler = handleCallback(request, response, controller.signal, args, () => {
      const accepted = args.acceptEvaluation ? args.acceptEvaluation() : evaluations + 1
      if (accepted === undefined) return undefined
      if (!Number.isSafeInteger(accepted) || accepted <= 0) {
        throw new Error('external optimizer callback: invalid accepted evaluation count')
      }
      if (accepted > args.maxEvaluations) return undefined
      evaluations += 1
      return accepted
    }).finally(() => {
      controller.signal.removeEventListener('abort', abortRequest)
      activeControllers.delete(controller)
      activeHandlers.delete(handler)
    })
    activeHandlers.add(handler)
    void handler.catch(() => undefined)
  })
  const port = await listenLocal(server)
  const close = (): Promise<void> => {
    closePromise ??= closeCallbackServer()
    return closePromise
  }
  const onAbort = (): void => {
    void close().catch(() => undefined)
  }
  args.signal?.addEventListener('abort', onAbort, { once: true })
  if (args.signal?.aborted) onAbort()
  return {
    url: `http://127.0.0.1:${port}/evaluate`,
    token: args.token,
    evaluations: () => evaluations,
    close,
  }

  async function closeCallbackServer(): Promise<void> {
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
      throw new Error('external optimizer callback closed with active request work')
    }
    if (serverResult?.status === 'rejected') throw serverResult.reason
  }
}

async function handleCallback<TResponse>(
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
  args: {
    token: string
    maxEvaluations: number
    acceptEvaluation?: () => number | undefined
    evaluate: (request: ExternalTextEvaluationRequest, signal: AbortSignal) => Promise<TResponse>
  },
  nextEvaluation: () => number | undefined,
): Promise<void> {
  try {
    if (request.method !== 'POST' || request.url !== '/evaluate') {
      sendJsonIfOpen(response, 404, { error: 'not found' })
      return
    }
    if (request.headers.authorization !== `Bearer ${args.token}`) {
      sendJsonIfOpen(response, 401, { error: 'unauthorized' })
      return
    }
    const body = await readJson(request)
    if (
      !isRecord(body) ||
      !isExternalTextCandidate(body.candidate) ||
      typeof body.exampleId !== 'string'
    ) {
      sendJsonIfOpen(response, 400, { error: 'candidate and exampleId are required strings' })
      return
    }
    const count = nextEvaluation()
    if (count === undefined) {
      sendJsonIfOpen(response, 429, { error: 'evaluation limit reached' })
      return
    }
    const result = await args.evaluate(
      { candidate: body.candidate, exampleId: body.exampleId },
      signal,
    )
    sendJsonIfOpen(response, 200, result)
  } catch {
    sendJsonIfOpen(response, 500, { error: 'evaluation failed' })
  }
}

async function waitForActiveHandlers(activeHandlers: Set<Promise<void>>): Promise<void> {
  while (activeHandlers.size > 0) {
    await Promise.allSettled([...activeHandlers])
  }
}

function sendJsonIfOpen(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  sendJson(response, status, body)
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_CALLBACK_BODY_BYTES) {
        reject(new Error('callback body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('error', reject)
    request.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
  })
}

function assertCallbackConfig(args: {
  token: string
  maxEvaluations: number
  acceptEvaluation?: () => number | undefined
  evaluate: (request: ExternalTextEvaluationRequest, signal: AbortSignal) => Promise<unknown>
  signal?: AbortSignal
}): void {
  if (typeof args.token !== 'string' || !args.token.trim()) {
    throw new Error('external optimizer callback: token must be non-empty')
  }
  if (!Number.isSafeInteger(args.maxEvaluations) || args.maxEvaluations <= 0) {
    throw new Error('external optimizer callback: maxEvaluations must be a positive safe integer')
  }
  if (args.acceptEvaluation !== undefined && typeof args.acceptEvaluation !== 'function') {
    throw new Error('external optimizer callback: acceptEvaluation must be a function')
  }
  if (typeof args.evaluate !== 'function') {
    throw new Error('external optimizer callback: evaluate must be a function')
  }
}
