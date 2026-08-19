import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { contentHash } from '../verdict-cache'
import {
  type ExternalOptimizerCallback,
  type ExternalOptimizerCallbackLimits,
  type ExternalOptimizerEvaluationObservation,
  type ExternalTextCandidate,
  type ExternalTextEvaluationRequest,
  isExternalTextCandidate,
  isRecord,
  resolveExternalOptimizerCallbackLimits,
} from './external-optimizer-contracts'
import { closeServer, listenLocal, sendJson } from './external-optimizer-http'

type UnsequencedObservation = ExternalOptimizerEvaluationObservation extends infer T
  ? T extends ExternalOptimizerEvaluationObservation
    ? Omit<T, 'sequence'>
    : never
  : never

export async function startExternalOptimizerCallback<TResponse>(args: {
  token: string
  maxEvaluations: number
  acceptEvaluation?: () => number | undefined
  evaluate: (request: ExternalTextEvaluationRequest, signal: AbortSignal) => Promise<TResponse>
  observe?: (observation: ExternalOptimizerEvaluationObservation) => void
  /** Loopback JSON byte limits. Omitted fields use finite defaults. */
  limits?: Partial<ExternalOptimizerCallbackLimits>
  signal?: AbortSignal
}): Promise<ExternalOptimizerCallback> {
  assertCallbackConfig(args)
  const limits = resolveExternalOptimizerCallbackLimits(args.limits)
  args.signal?.throwIfAborted()
  let evaluations = 0
  let accepting = true
  let closePromise: Promise<void> | undefined
  const activeControllers = new Set<AbortController>()
  const activeHandlers = new Set<Promise<void>>()
  const proposedCandidateHashes = new Set<string>()
  let observationSequence = 0
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
    handler = handleCallback(
      request,
      response,
      controller.signal,
      args,
      limits,
      () => {
        const accepted = args.acceptEvaluation ? args.acceptEvaluation() : evaluations + 1
        if (accepted === undefined) return undefined
        if (!Number.isSafeInteger(accepted) || accepted <= 0) {
          throw new Error('external optimizer callback: invalid accepted evaluation count')
        }
        if (accepted > args.maxEvaluations) return undefined
        evaluations += 1
        return accepted
      },
      (observation) => {
        if (!args.observe) return
        args.observe({ ...observation, sequence: ++observationSequence })
      },
      proposedCandidateHashes,
    ).finally(() => {
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
    observe?: (observation: ExternalOptimizerEvaluationObservation) => void
  },
  limits: ExternalOptimizerCallbackLimits,
  nextEvaluation: () => number | undefined,
  observe: (observation: UnsequencedObservation) => void,
  proposedCandidateHashes: Set<string>,
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
    let body: unknown
    try {
      body = await readJson(request, limits.maxRequestBytes)
    } catch {
      observe({ kind: 'refusal', reason: 'invalid-request' })
      sendJsonIfOpen(response, 400, { error: 'request body must be bounded valid JSON' })
      return
    }
    if (
      !isRecord(body) ||
      !isExternalTextCandidate(body.candidate) ||
      typeof body.exampleId !== 'string'
    ) {
      observe({ kind: 'refusal', reason: 'invalid-request' })
      sendJsonIfOpen(response, 400, { error: 'candidate and exampleId are required strings' })
      return
    }
    const candidate = cloneCandidate(body.candidate)
    const candidateHash = contentHash({ kind: 'external-text-candidate', candidate })
    if (!proposedCandidateHashes.has(candidateHash)) {
      observe({ kind: 'proposal', candidate, candidateHash })
      proposedCandidateHashes.add(candidateHash)
    }
    const count = nextEvaluation()
    if (count === undefined) {
      observe({
        kind: 'refusal',
        reason: 'evaluation-limit',
        candidate,
        candidateHash,
        exampleId: body.exampleId,
      })
      sendJsonIfOpen(response, 429, { error: 'evaluation limit reached' })
      return
    }
    let result: TResponse
    try {
      result = await args.evaluate({ candidate, exampleId: body.exampleId }, signal)
    } catch (error) {
      observe({
        kind: 'refusal',
        reason: 'evaluation-failed',
        candidate,
        candidateHash,
        exampleId: body.exampleId,
      })
      // The thrown detail is the only diagnostic for a failed evaluation —
      // an opaque 500 costs the caller a blind debugging round.
      sendJsonIfOpen(response, 500, {
        error: `evaluation failed: ${String(error).slice(0, 400)}`,
      })
      return
    }
    let encoded: string
    try {
      encoded = encodeJsonResponse(result)
    } catch {
      observe({
        kind: 'refusal',
        reason: 'evaluation-failed',
        candidate,
        candidateHash,
        exampleId: body.exampleId,
      })
      sendJsonIfOpen(response, 500, { error: 'evaluation response must be valid JSON' })
      return
    }
    if (Buffer.byteLength(encoded) > limits.maxResponseBytes) {
      observe({
        kind: 'refusal',
        reason: 'evaluation-failed',
        candidate,
        candidateHash,
        exampleId: body.exampleId,
      })
      sendJsonIfOpen(response, 413, { error: 'evaluation response too large' })
      return
    }
    observe({
      kind: 'evaluation',
      candidate,
      candidateHash,
      exampleId: body.exampleId,
      evaluationNumber: count,
      response: structuredClone(result),
    })
    sendEncodedJsonIfOpen(response, 200, encoded)
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

function readJson(request: IncomingMessage, maxRequestBytes: number): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxRequestBytes) {
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

function encodeJsonResponse(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('evaluation response must be JSON-serializable')
  return encoded
}

function sendEncodedJsonIfOpen(response: ServerResponse, status: number, encoded: string): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(encoded)),
  })
  response.end(encoded)
}

function assertCallbackConfig(args: {
  token: string
  maxEvaluations: number
  acceptEvaluation?: () => number | undefined
  evaluate: (request: ExternalTextEvaluationRequest, signal: AbortSignal) => Promise<unknown>
  observe?: (observation: ExternalOptimizerEvaluationObservation) => void
  limits?: Partial<ExternalOptimizerCallbackLimits>
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
  if (args.observe !== undefined && typeof args.observe !== 'function') {
    throw new Error('external optimizer callback: observe must be a function')
  }
}

function cloneCandidate(candidate: ExternalTextCandidate): ExternalTextCandidate {
  return typeof candidate === 'string' ? candidate : { ...candidate }
}
