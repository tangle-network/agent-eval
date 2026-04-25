/**
 * GoldenMatcher — fuzzy matcher for "did the agent produce the expected things?".
 *
 * Universal primitive across agent-eval consumers. Use it for:
 *   - Test suites: did the run hit the expected assertions?
 *   - Tool agents: did the agent emit the expected tool call sequence?
 *   - Judges: did the verdict include the expected concepts?
 *   - Design audits: did the auditor surface the planted defects?
 *
 * Match rule (per golden):
 *   - Any phrase in `golden.any` (case-insensitive substring) appears in the
 *     candidate's text fields, OR
 *   - Any pattern in `golden.anyRegex` (case-insensitive) matches.
 *
 * Recall is severity-weighted by default: critical=3, major=2, minor=1.
 * Missing one critical hurts more than missing three minors.
 */

export type GoldenSeverity = 'critical' | 'major' | 'minor'

export interface GoldenSpec {
  /** Stable identifier — survives across runs so consumers can grep by id. */
  id: string
  /** Severity drives recall weighting. */
  severity: GoldenSeverity
  /**
   * Substring phrases (case-insensitive). A hit on ANY phrase counts as a
   * match. Keep these SHORT (3-6 words) and SPECIFIC.
   */
  any: string[]
  /** Optional regex patterns. ORed with `any`. */
  anyRegex?: string[]
  /** Free-form note — surfaces in reports for humans. */
  hint?: string
  /** Optional category for grouping/filtering. */
  category?: string
}

export interface MatchResult {
  /** Same length as goldens; `true` when matched. */
  matches: boolean[]
  /** Convenience: count of hits. */
  hits: number
  /** Convenience: total goldens. */
  total: number
}

/**
 * Match each golden against `candidates`, where each candidate exposes one or
 * more text fields the matcher should search. Defaults to searching all
 * string-typed fields concatenated.
 */
export function matchGoldens<T>(
  goldens: GoldenSpec[],
  candidates: T[],
  options: {
    /**
     * Extract the searchable text for a candidate. Default: concatenate every
     * top-level string field with a space.
     */
    text?: (candidate: T) => string
  } = {},
): MatchResult {
  const extract = options.text ?? defaultExtract
  const haystacks = candidates.map((c) => extract(c).toLowerCase())
  const matches = goldens.map((golden) => goldenMatched(golden, haystacks))
  return {
    matches,
    hits: matches.filter(Boolean).length,
    total: goldens.length,
  }
}

function defaultExtract(candidate: unknown): string {
  if (typeof candidate === 'string') return candidate
  if (candidate && typeof candidate === 'object') {
    const parts: string[] = []
    for (const v of Object.values(candidate as Record<string, unknown>)) {
      if (typeof v === 'string') parts.push(v)
    }
    return parts.join(' ')
  }
  return String(candidate ?? '')
}

function goldenMatched(golden: GoldenSpec, haystacks: string[]): boolean {
  for (const phrase of golden.any) {
    const needle = phrase.toLowerCase().trim()
    if (!needle) continue
    if (haystacks.some((h) => h.includes(needle))) return true
  }
  for (const pattern of golden.anyRegex ?? []) {
    let re: RegExp
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      continue
    }
    if (haystacks.some((h) => re.test(h))) return true
  }
  return false
}

/** Severity weights — exposed so consumers can override (rare). */
export const DEFAULT_SEVERITY_WEIGHTS: Record<GoldenSeverity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
}

/** Severity-weighted recall over a MatchResult + the goldens that produced it. */
export function weightedRecall(
  goldens: GoldenSpec[],
  result: MatchResult,
  weights: Record<GoldenSeverity, number> = DEFAULT_SEVERITY_WEIGHTS,
): number {
  if (goldens.length === 0) return 1
  const total = goldens.reduce((s, g) => s + (weights[g.severity] ?? 1), 0)
  if (total === 0) return 1
  const hit = goldens.reduce(
    (s, g, i) => s + (result.matches[i] ? (weights[g.severity] ?? 1) : 0),
    0,
  )
  return hit / total
}

/**
 * Precision proxy: fraction of emitted candidates that match SOME golden.
 *
 * No human-labelled negatives means unmatched candidates are SOFT false
 * positives — punishes verbose agents that pad with filler. Doesn't punish
 * unknown-but-real findings; the way to tighten this is to grow the golden
 * set, not to invent a stricter score.
 */
export function precision<T>(
  goldens: GoldenSpec[],
  candidates: T[],
  options: { text?: (candidate: T) => string } = {},
): number {
  if (candidates.length === 0) return 1
  const extract = options.text ?? defaultExtract
  let matched = 0
  for (const cand of candidates) {
    const haystack = extract(cand).toLowerCase()
    const matchedAny = goldens.some((g) =>
      g.any.some((phrase) => phrase.length > 0 && haystack.includes(phrase.toLowerCase())) ||
      (g.anyRegex ?? []).some((pat) => {
        try { return new RegExp(pat, 'i').test(haystack) } catch { return false }
      }),
    )
    if (matchedAny) matched++
  }
  return matched / candidates.length
}
