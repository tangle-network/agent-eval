/**
 * Toolchain error-count extractor.
 *
 * Given stderr/stdout from a compiler or test runner, count the number
 * of reported errors/failures. Patterns are deliberately narrow —
 * unknown stderr returns `null` rather than zero so callers can
 * distinguish "no errors" from "different toolchain, couldn't parse".
 *
 * All patterns are anchored to the start of a line and use bounded
 * character classes to avoid catastrophic backtracking on pathological
 * inputs.
 *
 * Add new toolchains by appending to {@link ERROR_COUNT_PATTERNS};
 * order matters only in the sense that the first matching pattern wins.
 */

export interface ErrorCountPattern {
  /** Stable identifier for logging + tests. */
  name: string
  /** Must be global (`g` flag) — the extractor counts matches. */
  regex: RegExp
  /** Optional post-processing to extract a count from a single captured match. */
  transform?: (match: RegExpMatchArray) => number
}

export const ERROR_COUNT_PATTERNS: ErrorCountPattern[] = [
  {
    // tsc / ts-node: `src/foo.ts(12,3): error TS1234: ...`
    name: 'typescript-tsc',
    regex: /[\w./-]+\(\d+,\d+\): error TS\d+:/g,
  },
  {
    // pytest: `FAILED tests/test_foo.py::test_bar`
    name: 'pytest-failed',
    regex: /^FAILED\s+\S+/gm,
  },
  {
    // rustc: `error[E0308]: ...` or `error: ...`
    name: 'rustc',
    regex: /^error(?:\[[A-Z]\d+\])?:/gm,
  },
  {
    // go build: `./foo.go:12:3: ...` — any file:line:col: is an error line
    name: 'golang',
    regex: /^\.\/[\w./-]+\.go:\d+:\d+:/gm,
  },
  {
    // eslint default formatter per-line: `  12:34  error  message  rule-id`
    name: 'eslint',
    regex: /^\s+\d+:\d+\s+error\s+/gm,
  },
  {
    // eslint summary line: `✖ 17 problems (12 errors, 5 warnings)`
    // Use this only when the per-line formatter isn't present; transform
    // reads the errors count directly.
    name: 'eslint-summary',
    regex: /✖\s+\d+\s+problems?\s+\((\d+)\s+errors?/gm,
    transform: (m) => Number(m[1] ?? 0),
  },
]

export interface ExtractOptions {
  /** Restrict to named patterns — default: all patterns. */
  only?: string[]
  /** Additional patterns to consider BEFORE the built-in list. */
  extra?: ErrorCountPattern[]
}

export interface ExtractResult {
  /** Total count of matched errors, or null when no pattern matched. */
  count: number | null
  /** Name of the pattern that matched, or null. */
  matched: string | null
  /** Original matches for callers that want to surface specifics. */
  samples: string[]
}

/**
 * Try each pattern in order; return the first with matches.
 *
 * Returning `null` (instead of zero) on no-match is deliberate — a
 * callsite that greps for "typescript errors" on cargo output should
 * NOT treat that as "zero TS errors" because the toolchain is wrong.
 */
export function extractErrorCount(text: string, opts: ExtractOptions = {}): ExtractResult {
  if (!text) return { count: null, matched: null, samples: [] }

  const patterns = [...(opts.extra ?? []), ...ERROR_COUNT_PATTERNS].filter(
    (p) => !opts.only || opts.only.includes(p.name),
  )

  for (const p of patterns) {
    const matches = Array.from(text.matchAll(p.regex))
    if (matches.length === 0) continue

    const count = p.transform
      ? matches.reduce((sum, m) => sum + p.transform!(m), 0)
      : matches.length

    return {
      count,
      matched: p.name,
      samples: matches.slice(0, 5).map((m) => m[0]),
    }
  }

  return { count: null, matched: null, samples: [] }
}
