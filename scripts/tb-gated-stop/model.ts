import { TB_GATED_STOP_MODEL, TB_GATED_STOP_BASE_URL, SEAT_CONCURRENCY, MODEL_DEADLINE_MS } from './settings'

// ── The seat ─────────────────────────────────────────────────────────

interface ModelReply {
  content: string
  servedModel: string
  promptTokens: number
  completionTokens: number
}

let inFlight = 0

const waiting: (() => void)[] = []

/** At most `SEAT_CONCURRENCY` calls on the seat at once. */
async function withSeat<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= SEAT_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
  inFlight += 1
  try {
    return await fn()
  } finally {
    inFlight -= 1
    waiting.shift()?.()
  }
}

export async function callModel(messages: { role: string; content: string }[]): Promise<ModelReply> {
  const key = process.env.ZAI_GLM_API_KEY?.trim() || process.env.ZAI_API_KEY?.trim()
  if (!key) throw new Error('ZAI_GLM_API_KEY is required')
  return withSeat(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODEL_DEADLINE_MS)
    try {
      const response = await fetch(TB_GATED_STOP_BASE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: TB_GATED_STOP_MODEL, messages, temperature: 0, max_tokens: 4096 }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`seat answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      const body = (await response.json()) as {
        model?: string
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const usage = body.usage
      if (typeof usage?.prompt_tokens !== 'number' || typeof usage?.completion_tokens !== 'number') {
        throw new Error('seat reported no usage; a token budget cannot be matched against a missing count')
      }
      return {
        content: body.choices?.[0]?.message?.content ?? '',
        servedModel: body.model ?? 'unreported',
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      }
    } finally {
      clearTimeout(timer)
    }
  })
}
