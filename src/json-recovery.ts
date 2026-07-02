/**
 * Truncation-tolerant JSON recovery — shared by every parser that reads JSON
 * out of a model response (reflective-mutation proposals, judge scores, the
 * completion-correctness checker).
 *
 * LLMs routinely hit a max_tokens cap mid-emission, leaving a JSON prefix
 * with an unclosed string / object / array and often a dangling key or
 * trailing comma. Throwing on that prefix — and letting the throw fold into
 * a fabricated zero score downstream — is the bug class this module exists
 * to prevent (see `JudgeParseError`'s contract: a synthetic zero is
 * indistinguishable from a real low score). Recovering the complete prefix
 * turns a would-be fabricated zero into a real measurement.
 */

/**
 * Walk the input as JSON-aware (string vs not, escape-aware) and close
 * unclosed `{` / `[` in LIFO order at the tail. If the input was already
 * balanced returns it unchanged. If a string was open at end-of-input we
 * also close it with `"` first, since a truncated string-mid-value is the
 * most common LLM cap-hit failure mode and JSON.parse cannot proceed
 * without one.
 *
 * Returns null when the structure is unrecoverable (e.g. depth would go
 * negative — that's an *over*-closed prefix, not a truncation).
 */
export function autoCloseTruncatedJson(raw: string): string | null {
  const stack: Array<'{' | '['> = []
  let inString = false
  let escaped = false
  for (const c of raw) {
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (c === '\\') {
        escaped = true
        continue
      }
      if (c === '"') {
        inString = false
        continue
      }
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{' || c === '[') stack.push(c)
    else if (c === '}') {
      if (stack.pop() !== '{') return null
    } else if (c === ']') {
      if (stack.pop() !== '[') return null
    }
  }
  if (stack.length === 0 && !inString) return raw
  let suffix = ''
  if (inString) suffix += '"'
  while (stack.length > 0) {
    const opener = stack.pop()!
    suffix += opener === '{' ? '}' : ']'
  }
  return raw + suffix
}

const UNPARSEABLE = Symbol('unparseable')

function tryParse(candidate: string): unknown {
  try {
    return JSON.parse(candidate)
  } catch {
    return UNPARSEABLE
  }
}

/** Index of the last `,` that sits outside any string literal, or -1. Cutting
 *  there discards a dangling key / half-emitted value at the tail while
 *  keeping every complete member before it. */
function lastCommaOutsideString(s: string): number {
  let inString = false
  let escaped = false
  let last = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === ',') last = i
  }
  return last
}

/**
 * Best-effort parse of a possibly-truncated JSON payload embedded in model
 * output (prose and markdown fences tolerated). Slices from the first `{` /
 * `[`, then tries, in order:
 *
 *   1. plain `JSON.parse` of the first-opener → last-closer slice,
 *   2. auto-closing unclosed structures at the tail
 *      (`autoCloseTruncatedJson`),
 *   3. trimming the tail back to the previous complete member boundary (the
 *      last comma outside a string) and auto-closing again, repeatedly.
 *
 * Recovers e.g. `{"correct": false, "` → `{ correct: false }` — the exact
 * cap-hit shape that has zeroed real eval rows. Returns the parsed value
 * (always an object or array, given the slice starts at an opener), or
 * `null` when nothing parseable can be recovered. Never throws.
 */
export function recoverTruncatedJson(text: string): unknown {
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  const starts = [objStart, arrStart].filter((i) => i >= 0)
  if (starts.length === 0) return null
  let candidate = text.slice(Math.min(...starts))

  const lastClose = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
  if (lastClose > 0) {
    const balanced = tryParse(candidate.slice(0, lastClose + 1))
    if (balanced !== UNPARSEABLE) return balanced
  }

  // Bounded: each iteration strictly shortens the candidate at a comma, so 64
  // covers any realistic member count without risking a pathological spin.
  for (let i = 0; i < 64; i++) {
    const closed = autoCloseTruncatedJson(candidate)
    if (closed !== null) {
      const parsed = tryParse(closed)
      if (parsed !== UNPARSEABLE) return parsed
    }
    const cut = lastCommaOutsideString(candidate)
    if (cut <= 0) return null
    candidate = candidate.slice(0, cut)
  }
  return null
}
