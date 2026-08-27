/**
 * The carriers that deliver an analyst turn, and the checks that prove one is
 * alive before it is paid for.
 *
 * A carrier is everything between the runner and the weights: for the
 * bare-framing arm one HTTPS connection to the z.ai coding endpoint, for the
 * prime arm the cli-bridge process and the prime agent it spawns. Both can die
 * while still accepting connections, and a call issued into a dead carrier
 * blocks until its deadline rather than failing. The deadlines here are
 * therefore layered: time to first byte, then the largest gap between bytes,
 * then the whole turn. The first two are measured in seconds because a healthy
 * turn produces its first byte in about four.
 *
 * The seat this run shares allows only a few calls at once and answers HTTP 429
 * beyond that. A 429 arrives before the model reads the prompt, so it is not an
 * answer and must not be recorded as one: the caller waits for quota and
 * reissues the row.
 */

import { Agent, request as httpsRequest } from 'node:https'
import type {
  PrimeBridgeTransport,
  PrimeBridgeTransportResult,
} from '../src/analyst/prime-bridge-transport'

/** z.ai's OpenAI-compatible coding endpoint — the upstream both arms reach. */
export const ZAI_COMPLETIONS = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

/** No byte at all within this window means the connection is dead, not slow. */
export const TTFB_TIMEOUT_MS = Number(process.env.TBR_TTFB_MS ?? '60000')

/** A stream that stops producing for this long has lost its upstream. */
export const IDLE_TIMEOUT_MS = Number(process.env.TBR_IDLE_MS ?? '90000')

export interface CarrierProbe {
  ok: boolean
  detail: string
  status: number | null
  wallMs: number
  /** The `model` field the endpoint echoed — what it says it served. */
  echoedModel: string | null
  /** What the weights call themselves. Self-report, never authoritative. */
  selfReport: string | null
  /** True when the seat refused for quota, which a caller waits out. */
  rateLimited: boolean
}

/**
 * One small completion against the z.ai seat.
 *
 * It doubles as the quota probe and the served-id check, because both questions
 * are answered by the same call and neither is answerable without spending
 * something. `max_tokens` is generous: glm spends its first tokens on reasoning,
 * so a tight cap returns an empty string and looks like a broken endpoint.
 */
export async function probeZaiSeat(apiKey: string): Promise<CarrierProbe> {
  const started = Date.now()
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(ZAI_COMPLETIONS, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'glm-5.2',
        max_tokens: 200,
        messages: [{ role: 'user', content: 'Reply with ONLY the model name answering this.' }],
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      parsed = null
    }
    const choices = (parsed?.choices ?? []) as { message?: { content?: unknown } }[]
    const content = choices[0]?.message?.content
    return {
      ok: response.status === 200,
      detail: response.status === 200 ? 'seat answered' : text.slice(0, 200),
      status: response.status,
      wallMs: Date.now() - started,
      echoedModel: typeof parsed?.model === 'string' ? parsed.model : null,
      selfReport: typeof content === 'string' ? content.trim().slice(0, 60) : null,
      rateLimited: response.status === 429,
    }
  } catch (error) {
    return {
      ok: false,
      detail: `probe threw: ${(error as Error).message}`,
      status: null,
      wallMs: Date.now() - started,
      echoedModel: null,
      selfReport: null,
      rateLimited: false,
    }
  } finally {
    clearTimeout(deadline)
  }
}

/**
 * Block until the seat answers, or give up.
 *
 * Waiting is the correct response to a 429: attempts made into a rate-limit
 * wall cost the run its rows and teach it nothing. Any other failure returns
 * immediately, because a dead carrier does not recover by being waited on.
 */
export async function waitForSeat(
  apiKey: string,
  log: (m: string) => void,
  maxWaitMs = 900_000,
  pollMs = 60_000,
): Promise<CarrierProbe> {
  const started = Date.now()
  for (;;) {
    const probe = await probeZaiSeat(apiKey)
    if (probe.ok || !probe.rateLimited) return probe
    if (Date.now() - started > maxWaitMs) {
      log(`seat still rate-limited after ${Math.round((Date.now() - started) / 1000)}s; giving up`)
      return probe
    }
    log(`seat rate-limited (${probe.detail.slice(0, 80)}); waiting ${pollMs / 1000}s for quota`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export interface BridgeHealth {
  ok: boolean
  detail: string
  active: number | null
  maxActive: number | null
  freeSlots: number | null
}

/**
 * Is cli-bridge alive, is the prime backend ready, and is there a free
 * admission slot.
 *
 * The free-slot count matters as much as liveness: the bridge refuses with HTTP
 * 500 after a 60 s acquire wait, so a caller that issues into a full executor
 * converts other people's work into its own failures.
 */
export async function probeBridge(baseUrl: string, attempts = 2): Promise<BridgeHealth> {
  let last = await probeBridgeOnce(baseUrl)
  // One truncated read is not a dead carrier. A second failure a moment later
  // is, and the two are worth telling apart: treating the first as fatal ends
  // an arm that had nothing wrong with it.
  for (let attempt = 2; attempt <= attempts && !last.ok && last.freeSlots === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    last = await probeBridgeOnce(baseUrl)
  }
  return last
}

async function probeBridgeOnce(baseUrl: string): Promise<BridgeHealth> {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal })
    if (response.status !== 200) {
      return {
        ok: false,
        detail: `health HTTP ${response.status}`,
        active: null,
        maxActive: null,
        freeSlots: null,
      }
    }
    const body = (await response.json()) as {
      status?: string
      backends?: { name?: string; state?: string }[]
      admission?: { active?: number; maxActive?: number }
    }
    const prime = (body.backends ?? []).find((backend) => backend.name === 'prime')
    const active = typeof body.admission?.active === 'number' ? body.admission.active : null
    const maxActive = typeof body.admission?.maxActive === 'number' ? body.admission.maxActive : null
    const executor = await scopedExecutor(baseUrl, controller.signal)
    const freeSlots = executor === null ? null : executor.max - executor.inFlight
    if (prime?.state !== 'ready') {
      return {
        ok: false,
        detail: `prime backend state=${prime?.state ?? 'absent'}`,
        active,
        maxActive,
        freeSlots,
      }
    }
    return {
      ok: freeSlots === null ? true : freeSlots > 0,
      detail:
        freeSlots === null
          ? 'prime ready; executor counters unreadable'
          : `prime ready; ${freeSlots} of ${executor?.max} host slots free`,
      active,
      maxActive,
      freeSlots,
    }
  } catch (error) {
    return {
      ok: false,
      detail: `health threw: ${(error as Error).message}`,
      active: null,
      maxActive: null,
      freeSlots: null,
    }
  } finally {
    clearTimeout(deadline)
  }
}

/**
 * The bridge's per-scope executor counters.
 *
 * `/metrics` carries raw control characters inside prompt echoes, which
 * `JSON.parse` rejects, so the two counters are read with a narrow scan instead
 * of a whole-document parse.
 */
async function scopedExecutor(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ inFlight: number; max: number } | null> {
  try {
    const response = await fetch(`${baseUrl}/metrics`, { signal })
    const text = await response.text()
    const scope = /"scoped_host_executor"\s*:\s*\{([^}]*)\}/.exec(text)
    if (!scope) return null
    const inFlight = /"in_flight"\s*:\s*(\d+)/.exec(scope[1]!)
    const max = /"max"\s*:\s*(\d+)/.exec(scope[1]!)
    if (!inFlight || !max) return null
    return { inFlight: Number(inFlight[1]), max: Number(max[1]) }
  } catch {
    return null
  }
}

/**
 * Wait for the bridge to have room, without ever taking the last slot from a
 * caller already queued behind it.
 */
export async function waitForBridge(
  baseUrl: string,
  log: (m: string) => void,
  maxWaitMs = 900_000,
  pollMs = 30_000,
): Promise<BridgeHealth> {
  const started = Date.now()
  for (;;) {
    const health = await probeBridge(baseUrl)
    if (health.ok) return health
    // A backend that is not ready is a dead carrier; only a full executor is
    // worth waiting out.
    if (health.freeSlots !== null && health.freeSlots <= 0) {
      if (Date.now() - started > maxWaitMs) return health
      log(`bridge executor full (${health.detail}); waiting ${pollMs / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      continue
    }
    return health
  }
}

/**
 * The bare-framing carrier: one streamed completion straight to z.ai.
 *
 * Streaming is not a change to the question asked. It is what makes a dead
 * connection observable: a non-streamed completion produces no byte until the
 * whole answer exists, so a hung socket and a slow model look identical for as
 * long as the caller is willing to wait. With a stream the first byte arrives
 * in about four seconds and bytes keep arriving, so silence is diagnostic.
 *
 * The deltas are folded back into the non-streamed reply shape the protocol
 * parses, and `stream_options.include_usage` is set so the turn is priced from
 * counts the endpoint reported rather than from a guess.
 */
export function zaiStreamingTransport(apiKey: string): PrimeBridgeTransport {
  return ({ url, body, signal }): Promise<PrimeBridgeTransportResult> => {
    const target = new URL(url)
    const payload = JSON.stringify({
      ...body,
      stream: true,
      stream_options: { include_usage: true },
    })
    return new Promise<PrimeBridgeTransportResult>((resolvePromise, rejectPromise) => {
      let settled = false
      let ttfb: NodeJS.Timeout | null = null
      let idle: NodeJS.Timeout | null = null
      const clear = (): void => {
        if (ttfb) clearTimeout(ttfb)
        if (idle) clearTimeout(idle)
        ttfb = null
        idle = null
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clear()
        request.destroy()
        rejectPromise(error)
      }
      const request = httpsRequest(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          // A fresh connection per turn. A pooled socket that the upstream
          // dropped without a FIN accepts a write and never answers, which is
          // how a single reset turned every later call into a dead wait.
          agent: new Agent({ keepAlive: false }),
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            'content-length': Buffer.byteLength(payload),
          },
          signal,
        },
        (response) => {
          const status = response.statusCode ?? 0
          if (status !== 200) {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () => {
              if (settled) return
              settled = true
              clear()
              resolvePromise({ status, text: Buffer.concat(chunks).toString('utf8') })
            })
            response.on('error', fail)
            return
          }
          let buffer = ''
          let content = ''
          let usage: unknown = null
          let model: string | null = null
          const bumpIdle = (): void => {
            if (idle) clearTimeout(idle)
            idle = setTimeout(
              () => fail(new Error(`stream idle for ${IDLE_TIMEOUT_MS}ms`)),
              IDLE_TIMEOUT_MS,
            )
          }
          response.on('data', (chunk: Buffer) => {
            if (ttfb) {
              clearTimeout(ttfb)
              ttfb = null
            }
            bumpIdle()
            buffer += chunk.toString('utf8')
            for (;;) {
              const cut = buffer.indexOf('\n')
              if (cut < 0) break
              const line = buffer.slice(0, cut).trim()
              buffer = buffer.slice(cut + 1)
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (data === '[DONE]') continue
              try {
                const event = JSON.parse(data) as {
                  model?: string
                  usage?: unknown
                  choices?: { delta?: { content?: unknown } }[]
                }
                if (typeof event.model === 'string') model = event.model
                if (event.usage) usage = event.usage
                const delta = event.choices?.[0]?.delta?.content
                if (typeof delta === 'string') content += delta
              } catch {
                // A partial or non-JSON event carries no delta; the stream
                // continues and a truncated reply fails loudly at decoding.
              }
            }
          })
          response.on('end', () => {
            if (settled) return
            settled = true
            clear()
            resolvePromise({
              status: 200,
              text: JSON.stringify({
                model,
                choices: [{ message: { role: 'assistant', content } }],
                usage,
              }),
            })
          })
          response.on('error', fail)
        },
      )
      request.on('error', (error) => {
        if (settled) return
        settled = true
        clear()
        rejectPromise(error)
      })
      ttfb = setTimeout(
        () => fail(new Error(`no first byte within ${TTFB_TIMEOUT_MS}ms`)),
        TTFB_TIMEOUT_MS,
      )
      request.end(payload)
    })
  }
}
