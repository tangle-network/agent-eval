/**
 * The secret filter every diagnosis input passes through before any model or
 * report reads it.
 *
 * Two layers:
 *   - `secret-assignment` is the line-anchored credential-assignment pattern
 *     trace-archive uses to keep plaintext-secret files out of the archive
 *     (`holds_secret` in tangle-tools trace-archive/archive.py). It is ported
 *     here verbatim so both the archive and the miner refuse the same lines.
 *     That pattern is line-anchored on purpose, so a secret quoted inside a
 *     JSON record or a prose line passes it;
 *   - the token-shape rules close that gap: they match the credential itself
 *     wherever it appears (`sk-`, `sk-ant-`, GitHub, Slack, AWS, Google, JWT,
 *     bearer headers, URL passwords, PEM blocks, and JSON `"...key": "..."`).
 *
 * A redacted value becomes `[REDACTED:<rule id>]`, so a report can state what
 * was removed by class without carrying any of it. The filter never throws on
 * input shape: non-string leaves pass through unchanged.
 */

export interface SecretRule {
  id: string
  pattern: RegExp
  /** Rebuilds the match with the secret replaced; receives the regex groups. */
  replace: (match: string, ...groups: string[]) => string
}

export interface SecretFilterReport {
  redactionCount: number
  byRule: Record<string, number>
}

const marker = (id: string) => `[REDACTED:${id}]`
const whole = (id: string) => () => marker(id)

/**
 * The trace-archive `SECRET_ASSIGNMENT` pattern (tangle-tools
 * trace-archive/archive.py), with the prefix captured so the key name survives
 * and only the value is replaced.
 */
export const SECRET_ASSIGNMENT_PATTERN =
  /^([ \t]*(?:export[ \t]+)?["']?(?:[A-Za-z_][A-Za-z0-9_.-]*)?(?:key|token|secret|password|passwd|passphrase|credentials?)[A-Za-z0-9_]*["']?[ \t]*[=:][ \t]*["']?)(?!encrypted:)(?![$`])(?=[^\s"'#,]*[0-9])(?=[^\s"'#,]*[A-Za-z])[^\s"'#,]{16,}(["']?[ \t]*,?[ \t]*(?:#.*)?\r?)$/gim

export const DIAGNOSIS_SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'pem-block',
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: whole('pem-block'),
  },
  {
    id: 'secret-assignment',
    pattern: SECRET_ASSIGNMENT_PATTERN,
    replace: (_match, prefix, suffix) => `${prefix}${marker('secret-assignment')}${suffix}`,
  },
  {
    id: 'json-secret',
    pattern:
      /("[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|passphrase|credentials?)[A-Za-z0-9_]*"[ \t]*:[ \t]*")(?!encrypted:)(?![$`])(?=[^"\s]*[0-9])(?=[^"\s]*[A-Za-z])[^"\s]{16,}(")/gi,
    replace: (_match, prefix, suffix) => `${prefix}${marker('json-secret')}${suffix}`,
  },
  {
    // The same key vocabulary anywhere in a line (`cd x && GH_TOKEN=... gh pr`,
    // `--api-key=...`), which the line-anchored pattern lets through.
    id: 'inline-assignment',
    pattern:
      /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|passphrase|credentials?)[A-Za-z0-9_]*["']?[ \t]*[=:][ \t]*["']?)(?!encrypted:)(?![$`[])(?=[^\s"'#,&;]*[0-9])(?=[^\s"'#,&;]*[A-Za-z])[^\s"'#,&;]{16,}/gi,
    replace: (_match, prefix) => `${prefix}${marker('inline-assignment')}`,
  },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: whole('anthropic-key') },
  { id: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: whole('openai-key') },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
    replace: whole('github-token'),
  },
  {
    id: 'slack-token',
    pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
    replace: whole('slack-token'),
  },
  {
    id: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: whole('aws-access-key'),
  },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: whole('google-api-key') },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: whole('jwt'),
  },
  {
    id: 'bearer',
    pattern: /\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (_match, word) => `${word} ${marker('bearer')}`,
  },
  {
    id: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi,
    replace: (_match, prefix) => `${prefix}${marker('url-credentials')}@`,
  },
]

/** Redact one string, adding the per-rule counts to `report`. */
export function redactSecrets(
  input: string,
  report: SecretFilterReport = emptySecretFilterReport(),
  rules: readonly SecretRule[] = DIAGNOSIS_SECRET_RULES,
): string {
  let output = input
  for (const rule of rules) {
    let hits = 0
    rule.pattern.lastIndex = 0
    output = output.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      hits += 1
      // `replace` passes the groups first, then the offset and the whole
      // string; an unmatched optional group arrives as undefined and becomes ''.
      const captured = rest
        .slice(0, countGroups(rule.pattern))
        .map((value) => (typeof value === 'string' ? value : ''))
      return rule.replace(match, ...captured)
    })
    if (hits > 0) {
      report.redactionCount += hits
      report.byRule[rule.id] = (report.byRule[rule.id] ?? 0) + hits
    }
  }
  return output
}

/** Whether any rule matches: the miner's equivalent of trace-archive `holds_secret`. */
export function holdsSecret(
  input: string,
  rules: readonly SecretRule[] = DIAGNOSIS_SECRET_RULES,
): boolean {
  return rules.some((rule) => {
    rule.pattern.lastIndex = 0
    const found = rule.pattern.test(input)
    rule.pattern.lastIndex = 0
    return found
  })
}

/** Redact every string leaf of a JSON-like value. Keys are kept; values are filtered. */
export function redactSecretsDeep(value: unknown, report: SecretFilterReport): unknown {
  if (typeof value === 'string') return redactSecrets(value, report)
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, report))
  if (value !== null && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      next[key] = redactSecretsDeep(item, report)
    }
    return next
  }
  return value
}

export function emptySecretFilterReport(): SecretFilterReport {
  return { redactionCount: 0, byRule: {} }
}

const groupCounts = new WeakMap<RegExp, number>()

function countGroups(pattern: RegExp): number {
  const cached = groupCounts.get(pattern)
  if (cached !== undefined) return cached
  // An alternation with the empty string always matches, so exec reports the
  // pattern's capture-group count as match.length - 1.
  const count = (new RegExp(`${pattern.source}|`).exec('')?.length ?? 1) - 1
  groupCounts.set(pattern, count)
  return count
}
