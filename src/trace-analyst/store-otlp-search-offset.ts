/** A `"` at `idx` is a real JSON delimiter only when the run of `\`
 *  immediately preceding it is even-length; an odd run means the quote
 *  is escaped (`\"`) and is part of a string value, not a boundary. */
function isUnescapedQuote(slice: string, idx: number): boolean {
  if (slice[idx] !== '"') return false
  let backslashes = 0
  let b = idx - 1
  while (b >= 0 && slice[b] === '\\') {
    backslashes += 1
    b -= 1
  }
  return backslashes % 2 === 0
}

/** Scan backwards from `from` (inclusive) for the nearest UNescaped `"`.
 *  Returns its index, or -1 when none is found. */
function prevUnescapedQuote(slice: string, from: number): number {
  for (let i = from; i >= 0; i -= 1) {
    if (slice[i] === '"' && isUnescapedQuote(slice, i)) return i
  }
  return -1
}

/**
 * Best-effort: locate the JSON path for the substring at `offset` in
 * a single span's JSONL slice. The slice is '...,"key":"value..."' — we
 * walk back from `offset` to the value-opening quote, past the `:`, to
 * the key's closing then opening quote, skipping `\"`-escaped quotes that
 * live inside string values. Returns `null` when the offset doesn't fall
 * inside a recognisable string field.
 */
export function bestAttributePathForOffset(slice: string, offset: number): string | null {
  // Value-opening quote: nearest unescaped '"' at or before the offset.
  const valueQuote = prevUnescapedQuote(slice, Math.min(offset, slice.length - 1))
  if (valueQuote < 1) return null
  // The ':' separating key and value sits before the value quote.
  let j = valueQuote - 1
  while (j >= 0 && slice[j] !== ':') j -= 1
  if (j < 1) return null
  // Key closing quote, then key opening quote — both unescaped.
  const keyClose = prevUnescapedQuote(slice, j - 1)
  if (keyClose < 1) return null
  const keyOpen = prevUnescapedQuote(slice, keyClose - 1)
  if (keyOpen < 0) return null
  return slice.slice(keyOpen + 1, keyClose)
}
