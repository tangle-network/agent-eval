/**
 * Forgiving pre-parse for analyst findings. Weak models routinely emit
 * schema-correct content in an unusable wrapper — fenced ```json blocks, a
 * single object where an array is expected, trailing commas. Measured: GPT-4o
 * drops to 0% usable output purely from markdown-fence wrapping
 * (arXiv:2605.02363). A five-line de-fence recovers most of it. This module is
 * the de-fence/coerce step that runs BEFORE Zod, so a recoverable finding is
 * repaired, not dropped.
 *
 * Pure + deterministic. No model, no network.
 */

/** Strip a ```lang ... ``` (or bare ``` ... ```) code fence, if the string is one. */
export function stripCodeFences(text: string): string {
  const t = text.trim()
  const fence = /^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/
  const m = t.match(fence)
  return m ? m[1]!.trim() : t
}

/** Remove trailing commas before } or ] — the most common near-JSON defect. */
function dropTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1')
}

/**
 * Best-effort parse of a string into JSON. De-fences, drops trailing commas,
 * then `JSON.parse`. Returns `undefined` (never throws) when unrecoverable.
 */
export function coerceJson(text: string): unknown {
  const candidate = dropTrailingCommas(stripCodeFences(text))
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}
