/**
 * Groundedness — "did the retrieval PROVIDER surface what the task needed?"
 *
 * A search/research provider returns text; the task needed certain facts or
 * symbols to be solvable (the CURRENT API, a version number, a function name).
 * This module scores how much of that required knowledge the provider's results
 * actually surfaced — isolating PROVIDER quality (was the right thing
 * retrievable / returned) from AGENT skill (did the agent then use it). A high
 * groundedness score with a failed run blames the agent; a low score blames the
 * provider. That separation is the whole point — pass/fail alone cannot make it.
 *
 * Structural sibling of `../authenticity`:
 *   - authenticity scores the agent's PRODUCED files for realness.
 *   - groundedness scores the provider's RETRIEVED text for coverage.
 *   Both are pure deterministic scorers whose DOMAIN config is supplied by the
 *   consumer (authenticity: `AuthenticitySignals`; groundedness:
 *   `requiredKnowledge: string[]`) — neither bakes in a benchmark's vocabulary.
 *
 * Relationship to `keyword-coverage-judge`: that judge scores the agent's
 * SERVED OUTPUT (HTML + assets) for expected concepts — a different input
 * (produced deliverable) answering a different question (deliverable quality).
 * Groundedness reads the RETRIEVAL side (provider results). They are
 * complementary coverage scorers over different stages of the run, not
 * duplicates; do not collapse one into the other.
 *
 * Two seams, neither forked:
 *   - PURE SCORER `scoreGroundedness(resultText, requiredKnowledge)` — case-
 *     insensitive substring containment over a deduped key set. Fail-open: with
 *     no required knowledge there is nothing to ground, so `score = 1`.
 *   - TRACE EXTRACTOR `extractRetrievedText(spans, opts?)` — pulls the provider's
 *     returned text out of the canonical `TraceSchema` spans (`RetrievalSpan.hits`
 *     + provider `ToolSpan.result`) instead of re-parsing bespoke run files. This
 *     is the retrieval-side analog of `extractProducedState` (events → produced
 *     files): structural span input, no IO, no disk walking.
 */

import type { RetrievalSpan, Span, ToolSpan } from '../trace/schema'
import { isRetrievalSpan, isToolSpan } from '../trace/schema'

// ── Pure scorer ──────────────────────────────────────────────────────────────

export interface GroundednessResult {
  /** 0..1 share of required knowledge surfaced by the provider's results.
   *  1 when there is nothing to ground (`requiredKnowledge` empty) — fail-open. */
  score: number
  /** The required-knowledge keys the result text surfaced (deduped, original casing). */
  found: string[]
  /** The required-knowledge keys the result text did NOT surface. */
  missing: string[]
  /** Distinct required-knowledge keys after dedup — the denominator of `score`. */
  total: number
  /** Did the provider return any result text at all? Distinguishes "provider
   *  surfaced nothing" (`!hadResults`) from "returned text but missed the facts"
   *  (`hadResults && score < 1`) — the same provider-vs-agent split as the score. */
  hadResults: boolean
}

/**
 * Dedup a knowledge-key list, case-insensitively, keeping first-seen casing and
 * dropping blanks. The score denominator is distinct keys, so a config that
 * lists the same symbol twice (or with different casing) can't inflate `total`.
 */
function dedupeKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of keys) {
    const k = raw.trim()
    if (!k) continue
    const lower = k.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(k)
  }
  return out
}

/**
 * Score how much of `requiredKnowledge` the retrieval provider's `resultText`
 * surfaced. Pure — same inputs, same output. No IO, no LLM.
 *
 * Matching is case-insensitive substring containment: each required key is
 * checked against the lower-cased result text. This is intentionally the same
 * cheap, deterministic containment the authenticity scorer uses for its
 * structural signals — a key is "surfaced" if the provider's returned text
 * mentions it. Semantic / paraphrase coverage is a separate (LLM) layer a
 * consumer can stack on top, exactly as authenticity stacks its nuance judge.
 *
 * Fail-open at `total === 0`: a task with no required knowledge has nothing for
 * the provider to ground, so it cannot be penalized (`score = 1`). The benchmark
 * caller decides what `requiredKnowledge` is — the substrate never derives it.
 */
export function scoreGroundedness(
  resultText: string,
  requiredKnowledge: readonly string[],
): GroundednessResult {
  const keys = dedupeKeys(requiredKnowledge)
  const total = keys.length
  const text = resultText ?? ''
  const hadResults = text.trim().length > 0
  const haystack = text.toLowerCase()

  if (total === 0) {
    return { score: 1, found: [], missing: [], total: 0, hadResults }
  }

  const found: string[] = []
  const missing: string[] = []
  for (const key of keys) {
    if (haystack.includes(key.toLowerCase())) found.push(key)
    else missing.push(key)
  }

  return { score: found.length / total, found, missing, total, hadResults }
}

// ── Trace extractor ────────────────────────────────────────────────────────

/**
 * Predicate selecting which `ToolSpan`s are retrieval-PROVIDER calls (whose
 * `result` carries returned text), by tool name. A parameter — never a baked-in
 * literal — so the substrate stays free of any one benchmark's tool vocabulary,
 * exactly as `AuthenticitySignals` keeps all domain regexes consumer-supplied.
 */
export type ProviderToolMatcher = (toolName: string) => boolean

/**
 * Default provider matcher: tool names that look like search/research but not a
 * plain fetch/read. A sensible starting point for the common "search arm" shape;
 * any consumer with different tool names passes its own matcher. `RetrievalSpan`s
 * are ALWAYS included regardless of this matcher (they are retrieval by kind);
 * the matcher only selects which generic `ToolSpan`s also count as provider calls.
 */
export const defaultProviderToolMatcher: ProviderToolMatcher = (name) =>
  /search|research/i.test(name) && !/fetch/i.test(name)

export interface ExtractRetrievedTextOptions {
  /** Which `ToolSpan`s count as provider calls. Default: {@link defaultProviderToolMatcher}. */
  isProviderTool?: ProviderToolMatcher
}

/** Stringify a `ToolSpan.result` of unknown shape into searchable text. */
function resultToText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

/** Pull the retrieved text out of a `RetrievalSpan`: every hit's `content`. */
function retrievalSpanText(span: RetrievalSpan): string {
  return span.hits
    .map((h) => h.content ?? '')
    .filter((c) => c.length > 0)
    .join('\n')
}

/**
 * Extract the retrieval PROVIDER's returned text from a span stream — the
 * retrieval-side analog of `extractProducedState`. Reads the canonical
 * `TraceSchema` carriers, NOT bespoke run files:
 *   - every `RetrievalSpan`'s `hits[].content` (kind 'retrieval' — the
 *     substrate's first-class search/research result carrier; the same `.hits`
 *     the `bad_retrieval` failure detector already reads), and
 *   - `ToolSpan.result` for tool spans whose `toolName` the provider matcher
 *     accepts (kind 'tool').
 *
 * Pure and total: spans of other kinds, and provider tools with no result, are
 * skipped. Returns one text blob ready for `scoreGroundedness`.
 */
export function extractRetrievedText(
  spans: readonly Span[],
  opts: ExtractRetrievedTextOptions = {},
): string {
  const isProviderTool = opts.isProviderTool ?? defaultProviderToolMatcher
  const parts: string[] = []
  for (const span of spans) {
    if (isRetrievalSpan(span)) {
      const t = retrievalSpanText(span)
      if (t) parts.push(t)
    } else if (isToolSpan(span)) {
      const ts = span as ToolSpan
      if (isProviderTool(ts.toolName)) {
        const t = resultToText(ts.result)
        if (t) parts.push(t)
      }
    }
  }
  return parts.join('\n')
}

// ── Convenience: extract-then-score ───────────────────────────────────────────

/**
 * Extract the provider's retrieved text from a run's spans and score it against
 * `requiredKnowledge` in one call — the analog of authenticity's file-in
 * convenience. The primary contract is the standalone `scoreGroundedness`; this
 * is the ergonomic path for a consumer holding a persisted run's `Span[]`
 * (e.g. from `TraceStore.spans(...)`).
 */
export function scoreGroundednessForRun(
  spans: readonly Span[],
  requiredKnowledge: readonly string[],
  opts: ExtractRetrievedTextOptions = {},
): GroundednessResult {
  return scoreGroundedness(extractRetrievedText(spans, opts), requiredKnowledge)
}
