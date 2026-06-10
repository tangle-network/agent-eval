/**
 * Token-usage extraction from chat-completions responses and SSE streams.
 *
 * `captureFetchToRawSink` records the raw provider triple but deliberately does
 * not interpret token usage — cost is a per-consumer axis. Three consumers each
 * re-implement the same `usage` parser on top of the captured response (the
 * OpenAI `prompt_tokens`/`completion_tokens` shape, the Anthropic
 * `input_tokens`/`output_tokens` shape, and the camelCase variants), plus an
 * SSE accumulator that sums the per-chunk `usage` deltas. This is the one
 * canonical version.
 *
 * Both functions return `null` (not a silent `{ input: 0, output: 0 }`) when no
 * usage is present, so a caller can tell "no usage reported" from "zero tokens".
 */

export interface ExtractedUsage {
  input: number
  output: number
  /** Cached prompt tokens, when the provider reports them. */
  cached?: number
}

const INPUT_KEYS = ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens'] as const
const OUTPUT_KEYS = [
  'completion_tokens',
  'output_tokens',
  'completionTokens',
  'outputTokens',
] as const
const CACHED_KEYS = [
  'cached_tokens',
  'cache_read_input_tokens',
  'cachedTokens',
  'cacheReadInputTokens',
] as const

function nonNegNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

/**
 * Pull `{ input, output, cached? }` from a parsed chat-completions response
 * body. Accepts a top-level `usage` object (the common case) or a body that IS
 * the usage object. Returns null when neither an input nor an output count is
 * present — callers must inspect for null rather than treat it as zero cost.
 */
export function extractUsage(body: unknown): ExtractedUsage | null {
  if (!body || typeof body !== 'object') return null
  const obj = body as Record<string, unknown>
  const usage =
    obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : obj
  const input = nonNegNumber(usage, INPUT_KEYS)
  const output = nonNegNumber(usage, OUTPUT_KEYS)
  if (input === null && output === null) return null
  const cached = nonNegNumber(usage, CACHED_KEYS)
  const result: ExtractedUsage = { input: input ?? 0, output: output ?? 0 }
  if (cached !== null) result.cached = cached
  return result
}

/**
 * Sum token usage across an SSE response body. Each `data:` line is parsed and
 * fed to `extractUsage`; the per-chunk counts are accumulated. The `[DONE]`
 * sentinel and non-JSON lines are skipped. Returns null when no chunk carried
 * usage — distinguishing a usage-less stream from a genuine zero.
 *
 * Providers report SSE usage in two ways: a single terminal chunk with the full
 * totals, or incremental per-chunk deltas. Summing is correct for the delta
 * case and harmless for the terminal case (one non-null chunk ⇒ the total).
 */
export function extractUsageFromSse(text: string): ExtractedUsage | null {
  let input = 0
  let output = 0
  let cached = 0
  let sawCached = false
  let found = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    const usage = extractUsage(parsed)
    if (!usage) continue
    input += usage.input
    output += usage.output
    if (usage.cached !== undefined) {
      cached += usage.cached
      sawCached = true
    }
    found = true
  }
  if (!found) return null
  return sawCached ? { input, output, cached } : { input, output }
}

/**
 * Extract usage from an HTTP `Response` without consuming the caller's body:
 * clones, reads the text, and tries the JSON parser first, then the SSE
 * accumulator. Best-effort — returns null on any read/parse miss so a usage tee
 * never takes down the underlying call.
 */
export async function extractUsageFromResponse(response: Response): Promise<ExtractedUsage | null> {
  let text: string
  try {
    text = await response.clone().text()
  } catch {
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return extractUsage(json) ?? extractUsageFromSse(text)
}
