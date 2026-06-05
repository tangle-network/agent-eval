/**
 * @experimental
 *
 * `aceDriver` — Agentic Context Engineering: an APPEND-MOSTLY curator, the
 * deliberate contrast to `memoryCurationDriver`'s dedup-and-replace. ACE's
 * thesis (arXiv:2510.04618) is that aggressively deduping/rewriting a context
 * causes "context collapse" — hard-won specific lessons get summarized away. So
 * the playbook GROWS by appending each generation's new lessons as provenance-
 * tagged delta bullets; existing bullets are preserved verbatim, never merged.
 *
 * Each generation it:
 *  1. reads the playbook block already in the parent surface (verbatim);
 *  2. turns this generation's `findings` into lessons, keeping only the ones not
 *     already present (idempotency — a recurring finding is not re-appended, but
 *     a genuinely NEW lesson always is, even if similar to an old one);
 *  3. appends the new lessons as `- [gN] <lesson>` deltas and re-emits the block.
 *
 * Bounded WITHOUT collapse: when the playbook exceeds `maxEntries`, the OLDEST
 * deltas are evicted (FIFO) — recency is kept, but no two distinct lessons are
 * ever merged into one. Deterministic (no LLM) so a lift is attributable to the
 * accumulated lessons, not a rewrite's model noise.
 *
 * Fail-loud: with no new lesson this generation it returns NO candidate (the
 * playbook is unchanged — nothing to propose), never a fabricated bullet.
 */

import type { ImprovementDriver, ProposeContext, ProposedCandidate } from '../types'
import { extractBlockBody, findingToLesson, normKey, stripBlock, surfaceToText } from './_findings-text'

const BLOCK_START = '<!-- BEGIN ace-playbook (auto-managed by aceDriver) -->'
const BLOCK_END = '<!-- END ace-playbook -->'
const DEFAULT_HEADING = '## Playbook (accumulated lessons — append-only)'

export interface AceDriverOptions {
  /** Max delta bullets retained in the playbook. On overflow the OLDEST are
   *  evicted (FIFO) — never merged. Default 50 (ACE keeps a long context). */
  maxEntries?: number
  /** Heading rendered above the bullets inside the block. */
  sectionHeading?: string
}

interface Bullet {
  /** Generation tag the lesson was first appended at. */
  gen: number
  text: string
}

/** Parse the existing playbook block into bullets, preserving order + tags. A
 *  bullet line is `- [gN] <text>`; an untagged `- <text>` is tolerated (gen -1). */
function parsePlaybook(surface: string): Bullet[] {
  const body = extractBlockBody(surface, BLOCK_START, BLOCK_END)
  const out: Bullet[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('- ')) continue
    const item = line.slice(2).trim()
    const tag = /^\[g(-?\d+)\]\s*(.*)$/.exec(item)
    if (tag) out.push({ gen: Number(tag[1]), text: tag[2]!.trim() })
    else out.push({ gen: -1, text: item })
  }
  return out
}

export function aceDriver(opts: AceDriverOptions = {}): ImprovementDriver {
  const maxEntries = opts.maxEntries ?? 50
  if (maxEntries < 1) throw new Error('aceDriver: maxEntries must be >= 1')
  const heading = opts.sectionHeading ?? DEFAULT_HEADING

  return {
    kind: 'ace',
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      const parent = surfaceToText(ctx.currentSurface)
      const existing = parsePlaybook(parent)
      const seen = new Set(existing.map((b) => normKey(b.text)))

      // New lessons from this generation's findings — only those not already in
      // the playbook (idempotent; a recurring finding never duplicates a bullet).
      const fresh: Bullet[] = []
      for (const f of ctx.findings ?? []) {
        const lesson = findingToLesson(f)
        if (!lesson) continue
        const k = normKey(lesson)
        if (!k || seen.has(k)) continue
        seen.add(k)
        fresh.push({ gen: ctx.generation, text: lesson })
      }

      // Nothing genuinely new ⇒ the playbook is unchanged ⇒ no candidate.
      if (fresh.length === 0) return []

      // Append (preserving existing verbatim), then FIFO-evict the oldest on
      // overflow — recency kept, distinct lessons never merged.
      const all = [...existing, ...fresh].slice(-maxEntries)
      const block = [
        BLOCK_START,
        heading,
        ...all.map((b) => `- [g${b.gen}] ${b.text}`),
        BLOCK_END,
      ].join('\n')
      const base = stripBlock(parent, BLOCK_START, BLOCK_END)
      const surface = base ? `${base}\n\n${block}` : block

      return [
        {
          surface,
          label: `ace-playbook +${fresh.length}`,
          rationale: `appended ${fresh.length} new lesson(s) from gen ${ctx.generation} findings (playbook now ${all.length} bullet(s), append-only)`,
        },
      ]
    },
  }
}
