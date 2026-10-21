import type { LlmCallResult, LlmClientOptions } from './contract'
import { LlmResponseError } from './errors'

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Strip a ```json / ``` code fence if the model emitted one.
 * Idempotent for naked JSON. Some models (claude-code via router, certain
 * deepseek models) wrap output even under json_object.
 */
export function stripFencedJson(raw: string): string {
  const trimmed = raw.trim()
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/)
  return m ? m[1]!.trim() : trimmed
}

export function extractJsonPayload(raw: string): string {
  const stripped = stripFencedJson(raw)
  try {
    JSON.parse(stripped)
    return stripped
  } catch {
    // A response that declares a JSON root must parse as that complete root.
    // Scanning onward could turn a truncated object into one of its valid nested
    // arrays or objects and silently change the response schema.
    if (stripped.startsWith('{') || stripped.startsWith('[')) return stripped
  }

  // Only prose-leading responses may contain a recoverable JSON payload.
  const starts = [...stripped.matchAll(/[[{]/g)]
    .map((match) => match.index)
    .filter((index) => index != null)
  for (const start of starts) {
    const candidate = extractBalancedJson(stripped, start)
    if (!candidate) continue
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // Keep scanning; earlier braces may belong to prose.
    }
  }

  return stripped
}

function extractBalancedJson(input: string, start: number): string | null {
  const opener = input[start]
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : null
  if (!closer) return null

  const stack: string[] = [closer]
  let isInString = false
  let isEscaped = false

  for (let i = start + 1; i < input.length; i++) {
    const char = input[i]!
    if (isEscaped) {
      isEscaped = false
      continue
    }
    if (char === '\\') {
      isEscaped = isInString
      continue
    }
    if (char === '"') {
      isInString = !isInString
      continue
    }
    if (isInString) continue

    if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) return input.slice(start, i + 1)
    }
  }

  return null
}

export function parseJsonResult<T>(
  result: LlmCallResult,
  jsonPayloadMode: NonNullable<LlmClientOptions['jsonPayloadMode']>,
): T {
  try {
    if (result.finishReason === 'length') {
      throw new Error(
        `LLM returned truncated JSON content (model=${result.model}, finishReason=length)`,
      )
    }
    return parseJsonSafely<T>(result.content, result.model, jsonPayloadMode)
  } catch (error) {
    if (error instanceof LlmResponseError) throw error
    const cause = error instanceof Error ? error : new Error(String(error))
    throw new LlmResponseError(cause.message, result, { cause })
  }
}

function parseJsonSafely<T>(
  content: string,
  model: string,
  jsonPayloadMode: NonNullable<LlmClientOptions['jsonPayloadMode']>,
): T {
  const payload = jsonPayloadMode === 'exact' ? content : extractJsonPayload(content)
  try {
    return JSON.parse(payload) as T
  } catch {
    throw new Error(`LLM returned non-JSON content (model=${model})`)
  }
}

/** A non-array object: the JSON object shape that model and export payloads are narrowed to. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
