/**
 * Declarative oracles — ground-truth assertions without an LLM.
 *
 * Lifted from browser-agent-driver's _oracle.mjs. When you know the
 * expected outcome exactly (a URL, a text fragment, a JSON shape), you
 * don't need an LLM judge — you need a regex. These oracles are
 * composable pass/fail checks over an observation bundle.
 *
 * Each oracle returns { pass, detail, evidence? } and has a short
 * `id` for reporting. `evaluateOracles` runs a batch and aggregates.
 */

export interface OracleObservation {
  /** Final observable text output from the agent (response, page snapshot, stdout). */
  text?: string
  /** Final URL — for browser-style scenarios. */
  url?: string
  /** Any structured JSON the agent produced. */
  json?: unknown
  /** Free-form context used by custom oracles. */
  context?: Record<string, unknown>
}

export interface OracleResult {
  id: string
  pass: boolean
  detail: string
  evidence?: string
}

export interface Oracle {
  id: string
  check(obs: OracleObservation): OracleResult
}

export function textInSnapshot(needle: string, opts: { caseSensitive?: boolean } = {}): Oracle {
  const id = `text-in-snapshot(${needle})`
  return {
    id,
    check(obs) {
      const hay = obs.text ?? ''
      const found = opts.caseSensitive
        ? hay.includes(needle)
        : hay.toLowerCase().includes(needle.toLowerCase())
      return {
        id,
        pass: found,
        detail: found ? `"${needle}" found` : `"${needle}" not present in observation`,
        evidence: found ? excerpt(hay, needle, opts.caseSensitive) : undefined,
      }
    },
  }
}

export function urlContains(fragment: string): Oracle {
  const id = `url-contains(${fragment})`
  return {
    id,
    check(obs) {
      const url = obs.url ?? ''
      const pass = url.toLowerCase().includes(fragment.toLowerCase())
      return {
        id,
        pass,
        detail: pass ? `url ok (${url})` : `url "${url}" missing "${fragment}"`,
        evidence: url,
      }
    },
  }
}

export function jsonShape(expected: Record<string, unknown>): Oracle {
  const id = `json-shape(${Object.keys(expected).join(',')})`
  return {
    id,
    check(obs) {
      const json = obs.json
      if (!isObject(json)) {
        return { id, pass: false, detail: 'observation.json missing or not an object' }
      }
      for (const [k, v] of Object.entries(expected)) {
        if (!(k in json)) return { id, pass: false, detail: `key "${k}" missing` }
        const actual = (json as Record<string, unknown>)[k]
        if (typeof v === 'string' && v.startsWith('re:')) {
          const re = new RegExp(v.slice(3))
          if (typeof actual !== 'string' || !re.test(actual)) {
            return { id, pass: false, detail: `key "${k}" failed regex ${v}` }
          }
        } else if (actual !== v) {
          return {
            id,
            pass: false,
            detail: `key "${k}" = ${JSON.stringify(actual)}, expected ${JSON.stringify(v)}`,
          }
        }
      }
      return { id, pass: true, detail: 'all keys match' }
    },
  }
}

export function regexMatches(pattern: RegExp): Oracle {
  const id = `regex(${pattern.source})`
  return {
    id,
    check(obs) {
      const hay = obs.text ?? ''
      const m = hay.match(pattern)
      return {
        id,
        pass: m !== null,
        detail: m ? `matched "${m[0]}"` : `pattern ${pattern.source} not matched`,
        evidence: m?.[0],
      }
    },
  }
}

/**
 * Anti-bot detector — distinguishes genuine failures from blocked navigation
 * (cloudflare, recaptcha, etc). Returns an Oracle that PASSES when no block
 * marker is present; on block, detail names the blocker so runners can tag
 * results as "blocked" rather than "failed". Lifted from browser-agent-driver.
 */
export function notBlocked(): Oracle {
  const id = 'not-blocked'
  const markers: Array<{ name: string; re: RegExp }> = [
    { name: 'cloudflare', re: /just a moment|verifying you are human|cf-chl-|cloudflare/i },
    { name: 'recaptcha', re: /recaptcha|i'?m not a robot|challenge.?form/i },
    { name: 'hcaptcha', re: /hcaptcha/i },
    { name: 'akamai', re: /akamai|pragma: no-cache/i },
    { name: 'perimeterx', re: /perimeterx|px-captcha/i },
    { name: 'rate-limit', re: /rate.?limit|429 too many requests/i },
    { name: 'access-denied', re: /access denied|403 forbidden/i },
  ]
  return {
    id,
    check(obs) {
      const hay = obs.text ?? ''
      for (const { name, re } of markers) {
        if (re.test(hay)) {
          return {
            id,
            pass: false,
            detail: `blocked by ${name}`,
            evidence: (hay.match(re) ?? [])[0],
          }
        }
      }
      return { id, pass: true, detail: 'no anti-bot block detected' }
    },
  }
}

export interface OracleReport {
  results: OracleResult[]
  pass: boolean
  passCount: number
  failCount: number
  /** 0-1 ratio of oracles passed. */
  score: number
}

/** Run all oracles against one observation and aggregate. */
export function evaluateOracles(obs: OracleObservation, oracles: Oracle[]): OracleReport {
  const results = oracles.map((o) => o.check(obs))
  const passCount = results.filter((r) => r.pass).length
  const failCount = results.length - passCount
  return {
    results,
    pass: failCount === 0 && results.length > 0,
    passCount,
    failCount,
    score: results.length ? passCount / results.length : 0,
  }
}

function excerpt(hay: string, needle: string, caseSensitive = false): string {
  const haySearch = caseSensitive ? hay : hay.toLowerCase()
  const needleSearch = caseSensitive ? needle : needle.toLowerCase()
  const idx = haySearch.indexOf(needleSearch)
  if (idx === -1) return ''
  const start = Math.max(0, idx - 20)
  const end = Math.min(hay.length, idx + needle.length + 20)
  return (start > 0 ? '…' : '') + hay.slice(start, end) + (end < hay.length ? '…' : '')
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
