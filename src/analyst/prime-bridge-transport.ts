import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/**
 * The bridge seam for the prime analyst protocol: one POST to an
 * OpenAI-compatible `/v1/chat/completions` endpoint, returning the raw status
 * and body text.
 *
 * Deliberately NOT `callLlm` from `../llm-client`, which serves a different
 * contract:
 *  - it retries transient failures, and a prime turn holds a single model seat
 *    for minutes — a silent second attempt doubles the seat time and the spend;
 *  - it normalizes usage, while the protocol's receipt depends on the bridge's
 *    non-standard `model_requests` and `estimated` fields;
 *  - it composes sampling and response-format options the bridge's CLI backends
 *    reject;
 *  - it collapses HTTP status, unparseable body, and empty content into two
 *    error classes, while the protocol classifies them as three distinct
 *    terminal reasons.
 */
export interface PrimeBridgeTransportRequest {
  url: string
  body: {
    model: string
    messages: Array<{ role: 'user'; content: string }>
  }
  /**
   * The call's only deadline. The protocol aborts it on the per-call timeout
   * and on the caller's cancellation, so a transport that imposes a second
   * deadline of its own competes with this one.
   */
  signal: AbortSignal
}

export interface PrimeBridgeTransportResult {
  status: number
  text: string
}

/** One POST to the bridge. Injectable so tests run against a fake bridge. */
export type PrimeBridgeTransport = (
  request: PrimeBridgeTransportRequest,
) => Promise<PrimeBridgeTransportResult>

/**
 * Default transport on node:http/node:https rather than fetch: undici's fixed
 * response-header timeout kills prime calls that legitimately run past five
 * minutes, so the request's AbortSignal is the only deadline.
 */
export function nodeHttpPrimeBridgeTransport(): PrimeBridgeTransport {
  return ({ url, body, signal }) => {
    const target = new URL(url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new TypeError(`bridge URL must be http: or https:, got ${target.protocol}`)
    }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const encoded = JSON.stringify(body)
    return new Promise((resolvePromise, rejectPromise) => {
      const req = send(
        {
          hostname: target.hostname,
          port: target.port,
          // The query string is part of the caller's URL; dropping it would
          // send the request somewhere other than where the caller pointed.
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(encoded),
          },
          signal,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolvePromise({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          )
          res.on('error', rejectPromise)
        },
      )
      req.on('error', rejectPromise)
      req.end(encoded)
    })
  }
}
