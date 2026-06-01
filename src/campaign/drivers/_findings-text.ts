/**
 * Shared finding→text helpers for the curator-style drivers (`memoryCurationDriver`
 * dedup-and-replace, `aceDriver` append-mostly). One copy so the two drivers
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

/** Curator drivers are prompt-tier — they manage a text block in the surface.
 *  A code-tier surface has no prompt to append to; fail loud rather than
 *  silently coercing. */
export function surfaceToText(surface: MutableSurface): string {
  if (typeof surface === 'string') return surface
  throw new Error(
    `curator driver: surface must be a string prompt, got a ${surface.kind}-tier surface (${surface.worktreeRef}) — curation is prompt-tier`,
  )
}
