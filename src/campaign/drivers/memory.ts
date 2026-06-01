/**
 * @experimental
 *
 * `memoryCurationDriver` — a CURATOR `ImprovementDriver`, the complement to the
 * OPTIMIZER drivers (`gepaDriver` rewrites the prompt; this one BUILDS a
 * searchable memory of what prior trajectories taught and grafts the most
 * relevant lessons onto the surface).
 *
 * Each generation it:
 *  1. collects lessons — this generation's trace-analyst `findings` PLUS the
 *     memory already carried in the parent surface (so memory accumulates
 *     across generations instead of resetting);
 *  2. curates them — normalizes, deduplicates near-identical lessons, and ranks
 *     by recurrence (a lesson seen across many findings outranks a one-off);
 *  3. retrieves the top-K and writes them back as a single delimited memory
 *     block in the surface (idempotent — the block is replaced, never stacked,
 *     so the prompt does not grow without bound).
 *
 * This is the substrate behind the "knowledge base of working trajectories" the
 * agent searches: the curated block IS the retrieved memory the next run reads.
 * Curation is DETERMINISTIC (no LLM) so a lift it produces is attributable to
 * the lessons, not to model noise in a rewrite. An optional `distill` LLM step
 * can compress raw findings into crisp imperatives; default is verbatim.
 *
 * Fail-loud: never fabricates a lesson. With no findings and no prior memory it
 * returns no candidate (nothing learned yet — gen 0). It does not throw on an
 * empty generation because early generations legitimately have no findings.
 */

import { callLlm, type LlmClientOptions } from '../../llm-client'
import type { ImprovementDriver, MutableSurface, ProposeContext, ProposedCandidate } from '../types'

const BLOCK_START = '<!-- BEGIN curated-memory (auto-managed by memoryCurationDriver) -->'
const BLOCK_END = '<!-- END curated-memory -->'

export interface MemoryCurationDriverOptions {
  /** Top-K lessons retained in the surface memory block. Default 12. */
  maxEntries?: number
  /** Heading rendered above the lessons inside the block. Default below. */
  sectionHeading?: string
  /**
   * Optional LLM distillation: compress raw findings into crisp, generalizable
   * one-line imperatives before curating. Omit for verbatim (deterministic).
   */
  distill?: {
    baseUrl: string
    apiKey?: string
    model: string
    fetchImpl?: LlmClientOptions['fetch']
  }
}

const DEFAULT_HEADING = '## Learned from prior runs (curated memory)'

const DISTILL_SYSTEM =
  'You compress raw trace-analysis findings into crisp, generalizable agent guidance. ' +
  'Output ONLY a JSON array of strings, each one imperative lesson the agent should follow ' +
  '(e.g. "Always fetch a resource before mutating it"). No prose outside the JSON. ' +
  'Deduplicate; keep the most actionable and general; drop case-specific noise.'

function surfaceToText(surface: MutableSurface): string {
  if (typeof surface === 'string') return surface
  throw new Error(
    `memoryCurationDriver: surface must be a string prompt, got a ${surface.kind}-tier surface (${surface.worktreeRef}) — memory curation is prompt-tier`,
  )
}

/** A finding can be a raw string or a structured analyst finding. */
function findingToLesson(f: unknown): string | null {
  if (typeof f === 'string') return f.trim() || null
  if (f && typeof f === 'object') {
    const o = f as Record<string, unknown>
    const cand = o.recommended_action ?? o.claim ?? o.lesson ?? o.text ?? o.message
    if (typeof cand === 'string' && cand.trim()) return cand.trim()
  }
  return null
}

/** Normalize for dedup: lowercase, collapse whitespace, strip trailing punctuation. */
function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.;:!?\s]+$/, '')
    .trim()
}

/** Pull the lessons already curated into the parent surface's memory block. */
function extractExistingLessons(text: string): string[] {
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  if (start === -1 || end === -1 || end < start) return []
  return text
    .slice(start + BLOCK_START.length, end)
    .split('\n')
    .map((l) => l.replace(/^\s*-\s+/, '').trim())
    .filter((l) => l && !l.startsWith('#'))
}

/** Remove the memory block (and surrounding blank lines) so we can re-emit it. */
function stripBlock(text: string): string {
  const start = text.indexOf(BLOCK_START)
  const end = text.indexOf(BLOCK_END)
  if (start === -1 || end === -1 || end < start) return text.trimEnd()
  return (text.slice(0, start) + text.slice(end + BLOCK_END.length)).trimEnd()
}

async function distillLessons(
  raw: string[],
  distill: NonNullable<MemoryCurationDriverOptions['distill']>,
): Promise<string[]> {
  const res = await callLlm(
    {
      model: distill.model,
      messages: [
        { role: 'system', content: DISTILL_SYSTEM },
        { role: 'user', content: `Findings:\n${raw.map((r) => `- ${r}`).join('\n')}` },
      ],
    },
    { baseUrl: distill.baseUrl, apiKey: distill.apiKey, fetch: distill.fetchImpl },
  )
  try {
    const parsed = JSON.parse(res.content.trim())
    if (Array.isArray(parsed)) {
      const lessons = parsed.filter(
        (x): x is string => typeof x === 'string' && x.trim().length > 0,
      )
      if (lessons.length > 0) return lessons
    }
  } catch {
    // Distillation is a best-effort refinement; fall back to the verbatim
    // findings rather than dropping real lessons on a malformed LLM reply.
  }
  return raw
}

/** Build the CURATOR driver. */
export function memoryCurationDriver(opts: MemoryCurationDriverOptions = {}): ImprovementDriver {
  const maxEntries = opts.maxEntries ?? 12
  const heading = opts.sectionHeading ?? DEFAULT_HEADING
  return {
    kind: 'memory-curation',
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      const parent = surfaceToText(ctx.currentSurface)

      // (1) Collect lessons: this generation's findings + memory already in the
      //     parent (accumulation across generations).
      const fresh: string[] = []
      for (const f of ctx.findings ?? []) {
        const l = findingToLesson(f)
        if (l) fresh.push(l)
      }
      const carried = extractExistingLessons(parent)
      if (fresh.length === 0 && carried.length === 0) return [] // nothing learned yet

      const distilled =
        opts.distill && fresh.length > 0 ? await distillLessons(fresh, opts.distill) : fresh

      // (2) Curate: dedup by normalized key, rank by recurrence (carried lessons
      //     start with a recurrence prior of 1; each fresh occurrence adds).
      const byKey = new Map<string, { text: string; count: number }>()
      for (const l of carried) {
        const k = normKey(l)
        if (k) byKey.set(k, { text: l, count: 1 })
      }
      for (const l of distilled) {
        const k = normKey(l)
        if (!k) continue
        const e = byKey.get(k)
        if (e) e.count += 1
        else byKey.set(k, { text: l, count: 1 })
      }

      // (3) Rank + top-K. Stable: by count desc, then lexicographic for determinism.
      const ranked = [...byKey.values()]
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
        .slice(0, maxEntries)
      if (ranked.length === 0) return []

      const block = [BLOCK_START, heading, ...ranked.map((e) => `- ${e.text}`), BLOCK_END].join(
        '\n',
      )
      const next = `${stripBlock(parent)}\n\n${block}\n`
      if (next === parent) return [] // no change (same lessons already curated)

      return [
        {
          surface: next,
          label: 'memory-curation',
          rationale: `curated ${ranked.length} lessons (from ${fresh.length} new finding(s) + ${carried.length} carried)`,
        },
      ]
    },
  }
}
