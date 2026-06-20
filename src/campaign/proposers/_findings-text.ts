/**
 * Shared finding→text helpers for the curator-style proposers (`memoryCurationProposer`
 * dedup-and-replace, `aceProposer` append-mostly). One copy so the two proposers
 * extract lessons + normalize keys identically and cannot drift apart.
 */

import type { MutableSurface } from '../types'

/** A finding can be a raw string or a structured analyst finding. Pulls the
 *  most actionable text (recommended_action > claim > lesson > text > message). */
export function findingToLesson(f: unknown): string | null {
  if (typeof f === 'string') return f.trim() || null
  if (f && typeof f === 'object') {
    const o = f as Record<string, unknown>
    const cand = o.recommended_action ?? o.claim ?? o.lesson ?? o.text ?? o.message
    if (typeof cand === 'string' && cand.trim()) return cand.trim()
  }
  return null
}

/** Normalize for dedup/idempotency: lowercase, collapse whitespace, strip
 *  trailing punctuation. */
export function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.;:!?\s]+$/, '')
    .trim()
}

/** Curator proposers are prompt-tier — they manage a text block in the surface.
 *  A code-tier surface has no prompt to append to; fail loud rather than
 *  silently coercing. */
export function surfaceToText(surface: MutableSurface): string {
  if (typeof surface === 'string') return surface
  throw new Error(
    `curator proposer: surface must be a string prompt, got a ${surface.kind}-tier surface (${surface.worktreeRef}) — curation is prompt-tier`,
  )
}

// ── Delimited-block IO (the part ace + memory curators share) ──────────
// Both manage a marker-delimited block in the surface; only the bullet
// format + retention policy differ. One copy of the read/strip so they
// cannot drift on how they find or remove the block.

/** Body text strictly between `startMarker` and `endMarker`; '' if absent. */
export function extractBlockBody(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker)
  if (start === -1 || end === -1 || end < start) return ''
  return text.slice(start + startMarker.length, end)
}

/** Remove the delimited block (and surrounding trailing whitespace), trimmed,
 *  so the caller can re-emit a fresh block. */
export function stripBlock(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker)
  if (start === -1 || end === -1 || end < start) return text.trimEnd()
  return (text.slice(0, start) + text.slice(end + endMarker.length)).trimEnd()
}
