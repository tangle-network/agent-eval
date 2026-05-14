/**
 * Keyword-coverage judge — baseline complement to the semantic concept
 * judge.
 *
 * Where {@link runSemanticConceptJudge} uses an LLM to read source code
 * and decide whether a concept is REALLY implemented (not just
 * keyword-mentioned), this judge does the cheap, deterministic version:
 * fetch the served preview, concatenate every linked CSS/JS asset, and
 * substring-match each expected concept's keywords against the
 * concatenated haystack. Optional `requiredElement` selector adds a
 * structural gate so "supply counter" can require an actual `<input>` or
 * `<table>`, not just a comment containing the word.
 *
 * Use both judges. Keyword coverage is a fast 0-cost gate — a stub page
 * with the right keywords passes here, fails the semantic judge. Score
 * divergence between the two is itself a signal: high keyword coverage
 * + low semantic = "the agent slapped the right words on the right
 * scaffold but didn't wire any of it up."
 *
 * Pure functions, soft-fail on fetch error, no LLM dependency.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface KeywordConceptSpec {
  name: string
  keywords: string[]
  /**
   * Optional CSS selector that must match in the HTML for the concept
   * to count as present. Tiny subset:
   *   - `tag`               (e.g. `form`)
   *   - `tag[attr="value"]` (e.g. `input[type="number"]`)
   *   - `tag[attr]`         (presence only)
   * Anything more complex is rejected with `null` (treated as
   * "unenforced", not "failed").
   */
  requiredElement?: string
}

export interface KeywordCoverageFinding {
  concept: string
  found: boolean
  matchedKeywords: string[]
  /** True iff the optional requiredElement selector matched; null when no selector. */
  requiredElementPresent: boolean | null
}

export interface KeywordCoverageResult {
  /** 0..1 share of concepts satisfied. */
  score: number
  presentCount: number
  totalCount: number
  findings: KeywordCoverageFinding[]
  durationMs: number
  /** Total bytes assembled across html + linked assets. */
  totalAssembledBytes: number
  /** Soft-failure reason if the audit couldn't run. */
  error?: string
}

export interface KeywordCoverageOptions {
  /** Override fetch implementation — for tests. */
  fetch?: typeof fetch
  /** Per-asset fetch timeout (default 3s). */
  assetTimeoutMs?: number
  /** Initial-HTML fetch timeout (default 5s). */
  htmlTimeoutMs?: number
}

// ─── Selector matcher ──────────────────────────────────────────────────

/**
 * Element-presence check using a tiny CSS-selector subset. Returns
 * null when the selector isn't supported — caller treats that as
 * "unenforced" rather than "failed."
 */
export function htmlContainsElement(html: string, selector: string): boolean | null {
  const tagOnly = /^([a-zA-Z][\w-]*)$/.exec(selector)
  if (tagOnly) {
    const re = new RegExp(`<${tagOnly[1]}\\b`, 'i')
    return re.test(html)
  }
  const tagAttrEq = /^([a-zA-Z][\w-]*)\[([\w-]+)\s*=\s*["']?([^"'\]]+)["']?\]$/.exec(selector)
  if (tagAttrEq) {
    const [, tag, attr, value] = tagAttrEq
    const re = new RegExp(
      `<${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']${value!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
      'i',
    )
    return re.test(html)
  }
  const tagAttrPresence = /^([a-zA-Z][\w-]*)\[([\w-]+)\]$/.exec(selector)
  if (tagAttrPresence) {
    const [, tag, attr] = tagAttrPresence
    const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\b`, 'i')
    return re.test(html)
  }
  return null
}

// ─── Asset extraction ─────────────────────────────────────────────────

/**
 * Pull every `<link rel=stylesheet href>` and `<script src>` from a
 * raw HTML body. Returns absolute URLs resolved against `baseUrl`.
 * Permissive regex — agent-authored markup doesn't always quote
 * attributes the same way.
 */
export function extractAssetUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>()
  const linkRe = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  for (const re of [linkRe, scriptRe]) {
    let match: RegExpExecArray | null
    while ((match = re.exec(html)) !== null) {
      const raw = match[1]!
      try {
        urls.add(new URL(raw, baseUrl).toString())
      } catch {
        // unresolvable refs (e.g. data: URLs) — skip
      }
    }
  }
  return Array.from(urls)
}

// ─── Coverage scorer ──────────────────────────────────────────────────

/**
 * Score expected concepts against an already-fetched HTML payload + any
 * pre-fetched CSS/JS assets. Use when the runner has the bytes in hand
 * and doesn't want a fresh HTTP round-trip — e.g. sandbox runtime where
 * the preview content was fetched via curl from inside the container.
 */
export function runKeywordCoverageJudge(
  html: string,
  expectedConcepts: ReadonlyArray<KeywordConceptSpec>,
  assets: ReadonlyArray<string> = [],
): KeywordCoverageResult {
  const start = Date.now()
  if (expectedConcepts.length === 0) {
    return {
      score: 0,
      presentCount: 0,
      totalCount: 0,
      findings: [],
      durationMs: 0,
      totalAssembledBytes: 0,
    }
  }
  const haystack = `${html}\n${assets.join('\n')}`.toLowerCase()
  const findings: KeywordCoverageFinding[] = expectedConcepts.map((concept) => {
    const matchedKeywords: string[] = []
    for (const kw of concept.keywords) {
      if (haystack.includes(kw.toLowerCase())) matchedKeywords.push(kw)
    }
    const requiredElementPresent = concept.requiredElement
      ? htmlContainsElement(html, concept.requiredElement)
      : null
    const passesElementGate = requiredElementPresent === null || requiredElementPresent === true
    const found = matchedKeywords.length > 0 && passesElementGate
    return { concept: concept.name, found, matchedKeywords, requiredElementPresent }
  })
  const presentCount = findings.filter((f) => f.found).length
  return {
    score: presentCount / expectedConcepts.length,
    presentCount,
    totalCount: expectedConcepts.length,
    findings,
    durationMs: Date.now() - start,
    totalAssembledBytes: haystack.length,
  }
}

/**
 * URL-fetch flavor — GET the preview, parallel-fetch every linked
 * stylesheet + script (with bounded timeouts, soft-fail individually),
 * then score via {@link runKeywordCoverageJudge}.
 */
export async function runKeywordCoverageJudgeUrl(
  previewUrl: string,
  expectedConcepts: ReadonlyArray<KeywordConceptSpec>,
  options: KeywordCoverageOptions = {},
): Promise<KeywordCoverageResult> {
  const start = Date.now()
  const fetchFn = options.fetch ?? globalThis.fetch
  const htmlTimeout = options.htmlTimeoutMs ?? 5_000
  const assetTimeout = options.assetTimeoutMs ?? 3_000

  if (expectedConcepts.length === 0) {
    return {
      score: 0,
      presentCount: 0,
      totalCount: 0,
      findings: [],
      durationMs: 0,
      totalAssembledBytes: 0,
    }
  }

  let html = ''
  try {
    const resp = await fetchFn(previewUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(htmlTimeout),
    })
    if (!resp.ok) {
      return softFail(expectedConcepts, start, `preview HTTP ${resp.status}`)
    }
    html = await resp.text()
  } catch (err) {
    return softFail(expectedConcepts, start, err instanceof Error ? err.message : String(err))
  }

  const assetUrls = extractAssetUrls(html, previewUrl)
  const assetBodies = await Promise.all(
    assetUrls.map(async (u) => {
      try {
        const r = await fetchFn(u, {
          redirect: 'follow',
          signal: AbortSignal.timeout(assetTimeout),
        })
        if (!r.ok) return ''
        return await r.text()
      } catch {
        return ''
      }
    }),
  )

  return runKeywordCoverageJudge(html, expectedConcepts, assetBodies)
}

function softFail(
  expectedConcepts: ReadonlyArray<KeywordConceptSpec>,
  start: number,
  error: string,
): KeywordCoverageResult {
  return {
    score: 0,
    presentCount: 0,
    totalCount: expectedConcepts.length,
    findings: expectedConcepts.map((c) => ({
      concept: c.name,
      found: false,
      matchedKeywords: [],
      requiredElementPresent: null,
    })),
    durationMs: Date.now() - start,
    totalAssembledBytes: 0,
    error,
  }
}
