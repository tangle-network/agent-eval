/**
 * Redaction — remove PII / secrets from trace payloads before persist.
 *
 * Pre-persistence rules mean raw traces in storage are already scrubbed.
 * Unredacted variants (for debugging / post-mortems) live in a separate
 * storage layer with stricter access controls; this module only covers
 * the default scrub-then-persist path.
 *
 * Rules compose: pass an array of `RedactionRule`, each is applied in
 * order. Strings that match get replaced with a tagged sentinel so the
 * eval framework can count how many redactions happened per run
 * (surfaced via `redaction_applied` events).
 */

export interface RedactionRule {
  id: string
  pattern: RegExp
  /** Replacement — e.g. '[PII:email]'. Defaults to `[redacted:{id}]`. */
  replacement?: string
}

export interface RedactionReport {
  redactionCount: number
  byRule: Record<string, number>
}

/** OWASP / common-sense defaults — extend per-domain. */
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  { id: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { id: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { id: 'credit-card', pattern: /\b(?:\d[ -]*?){13,16}\b/g },
  { id: 'phone-us', pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { id: 'ipv4', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi },
  { id: 'sk-key', pattern: /\bsk-[A-Za-z0-9_-]{10,}\b/g },
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g,
  },
]

export const REDACTION_VERSION = '1.0.0'

/**
 * Redact a single string. Returns the new string and a per-rule count of
 * how many substitutions fired.
 */
export function redactString(
  input: string,
  rules: RedactionRule[] = DEFAULT_REDACTION_RULES,
): { output: string; report: RedactionReport } {
  const byRule: Record<string, number> = {}
  let redactionCount = 0
  let output = input
  for (const rule of rules) {
    let hits = 0
    output = output.replace(rule.pattern, () => {
      hits++
      return rule.replacement ?? `[redacted:${rule.id}]`
    })
    if (hits > 0) {
      byRule[rule.id] = hits
      redactionCount += hits
    }
  }
  return { output, report: { redactionCount, byRule } }
}

/**
 * Walk a JSON-ish value applying `redactString` to every string leaf.
 * Arrays and plain objects are recursed; other types pass through
 * untouched. Circular references throw — traces should be tree-shaped.
 */
export function redactValue(
  value: unknown,
  rules: RedactionRule[] = DEFAULT_REDACTION_RULES,
  report: RedactionReport = { redactionCount: 0, byRule: {} },
): { value: unknown; report: RedactionReport } {
  if (typeof value === 'string') {
    const { output, report: r } = redactString(value, rules)
    report.redactionCount += r.redactionCount
    for (const [k, v] of Object.entries(r.byRule)) {
      report.byRule[k] = (report.byRule[k] ?? 0) + v
    }
    return { value: output, report }
  }
  if (Array.isArray(value)) {
    return {
      value: value.map((v) => redactValue(v, rules, report).value),
      report,
    }
  }
  if (value !== null && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      next[k] = redactValue(v, rules, report).value
    }
    return { value: next, report }
  }
  return { value, report }
}
