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
  evaluate: (request: ExternalTextEvaluationRequest) => Promise<TResponse>
}): Promise<ExternalOptimizerCallback> {
  let evaluations = 0
  const server = createServer((request, response) => {
    void handleCallback(request, response, args, () => {
      evaluations += 1
      return evaluations
    })
  })
  const port = await listenLocal(server)
  return {
    url: `http://127.0.0.1:${port}/evaluate`,
    token: args.token,
    evaluations: () => Math.min(evaluations, args.maxEvaluations),
    close: () => closeServer(server),
  }
}

async function handleCallback<TResponse>(
  request: IncomingMessage,
  response: ServerResponse,
  args: {
    token: string
    maxEvaluations: number
    evaluate: (request: ExternalTextEvaluationRequest) => Promise<TResponse>
  },
  nextEvaluation: () => number,
): Promise<void> {
  try {
    if (request.method !== 'POST' || request.url !== '/evaluate') {
      sendJson(response, 404, { error: 'not found' })
      return
    }
    if (request.headers.authorization !== `Bearer ${args.token}`) {
      sendJson(response, 401, { error: 'unauthorized' })
      return
    }
    const body = await readJson(request)
    if (
      !isRecord(body) ||
      !isExternalTextCandidate(body.candidate) ||
      typeof body.exampleId !== 'string'
    ) {
      sendJson(response, 400, { error: 'candidate and exampleId are required strings' })
      return
    }
    const count = nextEvaluation()
    if (count > args.maxEvaluations) {
      sendJson(response, 429, { error: 'evaluation limit reached' })
      return
    }
    const result = await args.evaluate({ candidate: body.candidate, exampleId: body.exampleId })
    sendJson(response, 200, result)
  } catch {
    sendJson(response, 500, { error: 'evaluation failed' })
  }
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
