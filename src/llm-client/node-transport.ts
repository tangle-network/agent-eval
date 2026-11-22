import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/**
 * `fetch` for one request on node:http / node:https. Its only deadline is the
 * caller's `signal`.
 *
 * Node's built-in fetch (undici) has a second one: it drops a request whose
 * response headers have not arrived within 300 s. A non-streaming chat
 * completion sends no header until the whole answer is ready, so a call that is
 * allowed longer than that needs a transport without the limit.
 *
 * It answers like fetch where the client can tell the difference. A failure
 * rejects as `TypeError('fetch failed')` with the cause attached, so retry
 * classification does not depend on the transport, and an aborted signal
 * rejects with the signal's reason. The body is read as UTF-8 text, which is
 * all a chat completion returns.
 */
export const nodeHttpFetch: typeof fetch = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new TypeError('nodeHttpFetch takes a URL, not a Request')
    }
    const target = new URL(input)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new TypeError(`nodeHttpFetch: URL must be http: or https:, got ${target.protocol}`)
    }
    const { body, signal } = init
    if (body != null && typeof body !== 'string') {
      throw new TypeError('nodeHttpFetch sends a string body')
    }
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value
    })
    if (typeof body === 'string') headers['content-length'] = String(Buffer.byteLength(body))

    const fail = (cause: unknown) =>
      reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause }))
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(
      target,
      { method: init.method ?? 'GET', headers, ...(signal ? { signal } : {}) },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('error', fail)
        response.on('end', () => {
          try {
            const status = response.statusCode ?? 0
            const text = Buffer.concat(chunks).toString('utf8')
            const responseHeaders = new Headers()
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
              else if (value !== undefined) responseHeaders.set(name, value)
            }
            // A response of these statuses cannot carry a body.
            const empty = text === '' || status === 204 || status === 205 || status === 304
            resolve(
              new Response(empty ? null : text, {
                status,
                statusText: response.statusMessage ?? '',
                headers: responseHeaders,
              }),
            )
          } catch (error) {
            fail(error)
          }
        })
      },
    )
    // A connection that stays silent for minutes is dropped by NATs and load
    // balancers; keepalive probes hold it open while the model works.
    request.on('socket', (socket) => socket.setKeepAlive(true, 30_000))
    request.on('error', fail)
    request.end(typeof body === 'string' ? body : undefined)
  })
