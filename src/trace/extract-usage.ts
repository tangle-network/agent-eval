/**
 * Provider response and SSE usage extraction.
 *
 * Missing usage returns `null`; reported zeroes and cache-only activity remain
 * distinguishable from absent telemetry.
 */

import { SSEChunkParser } from '@tangle-network/agent-core/sse'
import {
  firstTokenCount,
  TOKEN_USAGE_INPUT_KEYS,
  TOKEN_USAGE_OUTPUT_KEYS,
  tokenUsageSource,
} from '@tangle-network/agent-core/telemetry'
import type { RunTokenUsage } from '../run-record'

export type ExtractedUsage = RunTokenUsage
export type SseUsageMode = 'cumulative' | 'delta'

export interface ExtractUsageFromSseOptions {
  /** Provider usage events are cumulative snapshots unless explicitly marked as deltas. */
  mode?: SseUsageMode
}

const INPUT_OTHER_KEYS = ['input_other'] as const
const EXCLUSIVE_REASONING_KEYS = ['reasoning', 'reasoning_tokens', 'reasoningTokens'] as const
const INCLUSIVE_REASONING_KEYS = ['reasoning_output_tokens', 'reasoningOutputTokens'] as const
const INPUT_DETAIL_KEYS = ['prompt_tokens_details', 'input_tokens_details'] as const
const OUTPUT_DETAIL_KEYS = ['completion_tokens_details', 'output_tokens_details'] as const
const CACHED_KEYS = [
  'cache',
  'cached_tokens',
  'cached_input_tokens',
  'cache_read_tokens',
  'cache_read_input_tokens',
  'cachedTokens',
  'cachedInputTokens',
  'cacheReadTokens',
  'cacheReadInputTokens',
  'input_cache_read',
] as const
const CACHE_WRITE_KEYS = [
  'cache_creation_tokens',
  'cache_creation_input_tokens',
  'cacheCreationTokens',
  'cacheCreationInputTokens',
  'input_cache_creation',
] as const

function nestedRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nestedNumber(
  source: Record<string, unknown>,
  recordKeys: readonly string[],
  valueKeys: readonly string[],
): number | undefined {
  for (const recordKey of recordKeys) {
    const value = firstTokenCount(nestedRecord(source, recordKey), valueKeys)
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Pull `{ input, output, cached?, cacheWrite? }` from a parsed response
 * body. Accepts a top-level `usage` object (the common case) or a body that IS
 * the usage object. Returns null only when none of those categories is present.
 */
export function extractUsage(body: unknown): ExtractedUsage | null {
  if (!body || typeof body !== 'object') return null
  const obj = body as Record<string, unknown>
  const usage = tokenUsageSource(obj)
  const input = firstTokenCount(usage, TOKEN_USAGE_INPUT_KEYS)
  const inputOther = firstTokenCount(usage, INPUT_OTHER_KEYS)
  const output = firstTokenCount(usage, TOKEN_USAGE_OUTPUT_KEYS)
  const exclusiveReasoning = firstTokenCount(usage, EXCLUSIVE_REASONING_KEYS)
  const inclusiveReasoning =
    firstTokenCount(usage, INCLUSIVE_REASONING_KEYS) ??
    nestedNumber(usage, OUTPUT_DETAIL_KEYS, ['reasoning_tokens', 'reasoningTokens'])
  const reasoning = exclusiveReasoning ?? inclusiveReasoning
  const nestedCache = nestedRecord(usage, 'cache')
  const cached =
    firstTokenCount(usage, CACHED_KEYS) ??
    firstTokenCount(nestedCache, ['read']) ??
    nestedNumber(usage, INPUT_DETAIL_KEYS, ['cached_tokens', 'cachedTokens'])
  const cacheWrite =
    firstTokenCount(usage, CACHE_WRITE_KEYS) ?? firstTokenCount(nestedCache, ['write'])
  if (
    input === undefined &&
    inputOther === undefined &&
    output === undefined &&
    reasoning === undefined &&
    cached === undefined &&
    cacheWrite === undefined
  )
    return null
  const result: ExtractedUsage = {
    input: (input ?? 0) + (inputOther ?? 0),
    output:
      (output ?? (inclusiveReasoning !== undefined ? inclusiveReasoning : 0)) +
      (exclusiveReasoning ?? 0),
  }
  if (reasoning !== undefined) result.reasoning = reasoning
  if (cached !== undefined) result.cached = cached
  if (cacheWrite !== undefined) result.cacheWrite = cacheWrite
  return result
}

/**
 * Extract token usage from a complete SSE response body using the shared SSE
 * frame parser. Cumulative snapshots are the fail-safe default because summing
 * them inflates billing; callers with explicit delta events opt into `mode: 'delta'`.
 */
export function extractUsageFromSse(
  text: string,
  options: ExtractUsageFromSseOptions = {},
): ExtractedUsage | null {
  const mode = options.mode ?? 'cumulative'
  let input = 0
  let output = 0
  let reasoning = 0
  let sawReasoning = false
  let cached = 0
  let sawCached = false
  let cacheWrite = 0
  let sawCacheWrite = false
  let found = false
  const parser = new SSEChunkParser<unknown>({ transform: parseSseJson })
  const events = [...parser.push(text), ...parser.flush()]
  const merge = mode === 'delta' ? (current: number, next: number) => current + next : Math.max

  for (const event of events) {
    const usage = extractUsage(event.data)
    if (!usage) continue
    input = merge(input, usage.input)
    output = merge(output, usage.output)
    if (usage.reasoning !== undefined) {
      reasoning = merge(reasoning, usage.reasoning)
      sawReasoning = true
    }
    if (usage.cached !== undefined) {
      cached = merge(cached, usage.cached)
      sawCached = true
    }
    if (usage.cacheWrite !== undefined) {
      cacheWrite = merge(cacheWrite, usage.cacheWrite)
      sawCacheWrite = true
    }
    found = true
  }
  if (!found) return null
  return {
    input,
    output,
    ...(sawReasoning ? { reasoning } : {}),
    ...(sawCached ? { cached } : {}),
    ...(sawCacheWrite ? { cacheWrite } : {}),
  }
}

function parseSseJson(raw: string): unknown | null {
  const payload = raw.trim()
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

/**
 * Extract usage from an HTTP `Response` without consuming the caller's body:
 * clones, reads the text, and tries the JSON parser first, then the SSE
 * accumulator. Best-effort — returns null on any read/parse miss so a usage tee
 * never takes down the underlying call.
 */
export async function extractUsageFromResponse(
  response: Response,
  sseOptions?: ExtractUsageFromSseOptions,
): Promise<ExtractedUsage | null> {
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
  return extractUsage(json) ?? extractUsageFromSse(text, sseOptions)
}
