import type { Server, ServerResponse } from 'node:http'

export function listenLocal(server: Server): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('external optimizer callback did not bind a TCP port'))
        return
      }
      resolvePromise(address.port)
    })
  })
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()))
  })
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/**
 * Send a JSON body only while the response can still take one.
 *
 * A handler that lost its client — the request was aborted, or the response
 * already ended — must not write again; Node throws `ERR_STREAM_WRITE_AFTER_END`
 * and the throw escapes into the server's error path rather than the caller's.
 */
export function sendJsonIfOpen(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  sendJson(response, status, body)
}

/**
 * Wait until every in-flight handler has settled.
 *
 * Re-reads the set on each pass: a handler that is still running can register
 * another, so awaiting one snapshot would return while work is outstanding and
 * the caller would close the server under it.
 */
export async function waitForActiveHandlers(activeHandlers: Set<Promise<void>>): Promise<void> {
  while (activeHandlers.size > 0) {
    await Promise.allSettled([...activeHandlers])
  }
}
