/**
 * Deterministic scrubbing pass over rollout-ledger lines before public release.
 *
 * Every rule is a pure regex rewrite applied to every string value in a line
 * (messages, artifacts, run ids, tool arguments — everywhere), so the scrubbed
 * line is still a valid `tangle.rollout.v1` line. Rules are idempotent:
 * scrub(scrub(x)) === scrub(x), and a second pass counts zero hits — that is
 * the property the release pipeline relies on to prove nothing half-scrubbed
 * ships. Rule order matters: whole `KEY=value` env pairs are redacted before
 * the bare-key rule so one secret is never counted twice.
 */

import { assertMinted, type MintedRolloutLine } from '../schema'

export interface ScrubRule {
  name: string
  pattern: RegExp
  /** Rewrite for one match; `g1` is the first capture group when present. */
  rewrite: (match: string, g1?: string) => string
}

const SCRUB_RULES: readonly ScrubRule[] = [
  {
    // /home/<user> and /Users/<user> prefixes → $WORK ($HOME-derived paths).
    name: 'home-path',
    pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+/g,
    rewrite: () => '$WORK',
  },
  {
    // Harness stores encode cwd as a dashed path segment (-home-drew-…);
    // strip the leading -home-<user> so the username never ships.
    name: 'home-path-encoded',
    pattern: /(?<=\/)-(?:home|Users)-[A-Za-z0-9_.]+/g,
    rewrite: () => '$WORK',
  },
  {
    // pytest names its tmpdir after the invoking user (/tmp/pytest-of-drew).
    name: 'tmp-user-dir',
    pattern: /\/tmp\/pytest-of-[A-Za-z0-9._-]+/g,
    rewrite: () => '/tmp/pytest-of-$USER',
  },
  {
    // `ls -l` owner/group columns leak the username in captured tool output.
    // The `(?!user user…)` guard keeps a second pass at zero rewrites.
    name: 'ls-owner',
    pattern:
      /([-bcdlps][-rwxsStT]{9}[.+@]?\s+\d+\s+)(?!user user(?=\s))[A-Za-z0-9._-]+\s+[A-Za-z0-9._-]+(?=\s)/g,
    rewrite: (_match, prefix) => `${prefix}user user`,
  },
  {
    // Env-var-shaped secrets: NAME=value where NAME looks credential-bearing.
    // The (?!\[REDACTED:) guard keeps the rule idempotent on its own output.
    name: 'env-secret',
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))=(?!\[REDACTED:)("[^"]*"|'[^']*'|[^\s"']+)/g,
    rewrite: (_match, name) => `${name}=[REDACTED:env]`,
  },
  {
    name: 'bearer-token',
    pattern: /\b(Bearer|Basic)\s+(?!\[REDACTED:)[A-Za-z0-9\-._~+/=]{8,}/g,
    rewrite: (_match, scheme) => `${scheme} [REDACTED:bearer]`,
  },
  {
    // Bare provider-prefixed keys (OpenAI/Anthropic sk-, GitHub ghp_/gho_/…,
    // fine-grained PATs, HuggingFace hf_, Slack xox*, AWS AKIA).
    name: 'api-key',
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    rewrite: () => '[REDACTED:api-key]',
  },
  {
    // Our infra hostnames → placeholder domain, subdomain preserved
    // (router.tangle.tools → router.internal.example).
    name: 'infra-host',
    pattern: /(?<![A-Za-z0-9.-])((?:[A-Za-z0-9-]+\.)*)tangle\.(?:tools|network)(?![A-Za-z0-9-])/g,
    rewrite: (_match, prefix) => `${prefix ?? ''}internal.example`,
  },
  {
    // Known workstation hostnames leak through email Message-IDs and fqdn
    // lookups inside captured test output; extend the list as machines join.
    name: 'machine-host',
    pattern: /\b[A-Za-z0-9]+-GTR-Pro\b/g,
    rewrite: () => 'workstation',
  },
]

/** Rule name → number of matches rewritten. Always carries every rule (0 is data). */
export type ScrubCounts = Record<string, number>

export function emptyScrubCounts(): ScrubCounts {
  return Object.fromEntries(SCRUB_RULES.map((rule) => [rule.name, 0]))
}

export function addScrubCounts(into: ScrubCounts, from: ScrubCounts): ScrubCounts {
  for (const [name, count] of Object.entries(from)) into[name] = (into[name] ?? 0) + count
  return into
}

export function scrubText(text: string, counts: ScrubCounts): string {
  let out = text
  for (const rule of SCRUB_RULES) {
    out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      counts[rule.name] = (counts[rule.name] ?? 0) + 1
      return rule.rewrite(match, typeof rest[0] === 'string' ? rest[0] : undefined)
    })
  }
  return out
}

function scrubValue(value: unknown, counts: ScrubCounts): unknown {
  if (typeof value === 'string') return scrubText(value, counts)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, counts))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = scrubValue(item, counts)
    return out
  }
  return value
}

/**
 * Scrub every string value in a line; structure and key order are preserved.
 *
 * `assertMinted` on the way out rather than a cast: scrubbing rebuilds the
 * object, so the brand has to be re-earned, and re-validating proves the rules
 * did not rewrite a field the schema constrains (`reward` is a number, not a
 * string, so no rule should ever touch it — this is what checks that).
 */
function scrubRolloutLine(line: MintedRolloutLine, counts: ScrubCounts): MintedRolloutLine {
  return assertMinted(scrubValue(line, counts), `scrubbed rollout line ${line.rollout_id}`)
}

export function scrubLines(lines: MintedRolloutLine[]): {
  lines: MintedRolloutLine[]
  counts: ScrubCounts
} {
  const counts = emptyScrubCounts()
  return { lines: lines.map((line) => scrubRolloutLine(line, counts)), counts }
}

/**
 * A `RolloutScrubber` (text → text) applying the full rule set — the
 * default hook to pass to `mintRolloutRows({ scrub })` so lines are
 * scrubbed at mint time, before they ever reach a ledger file. Release
 * builds re-run `scrubLines` regardless (idempotent), so double-scrubbing
 * is safe and counted as zero.
 */
export function defaultRolloutScrubber(text: string): string {
  return scrubText(text, emptyScrubCounts())
}

// ---------------------------------------------------------------------------
// Row screen: a secret or private detail drops the WHOLE line.
// ---------------------------------------------------------------------------

/**
 * Redaction leaves the row; this refuses it. A rewrite can only redact the
 * shapes it knows, and a live seat token split across a tool result, or a
 * phone number in a pasted message, sits beside the rest of the context that
 * made it sensitive. So the release build drops any line with one hit and
 * counts the drop by rule, and importers apply the same screen before a line
 * reaches a ledger.
 */
interface PrivacyRule {
  name: string
  hit: (text: string) => boolean
}

const scrubPattern = (name: string): RegExp => {
  const rule = SCRUB_RULES.find((r) => r.name === name)
  if (!rule) throw new Error(`no scrub rule "${name}"`)
  return rule.pattern
}

/** Bits per character over the token's own symbols. */
function entropy(token: string): number {
  const counts = new Map<string, number>()
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / token.length
    bits -= p * Math.log2(p)
  }
  return bits
}

// 32+ chars mixing upper, lower and digits at over 4.3 bits/char: random keys,
// not hex digests (at most 4 bits/char), identifiers or paths.
const ENTROPY_TOKEN = /[A-Za-z0-9+/=_-]{32,}/g
const highEntropy = (text: string): boolean => {
  for (const [token] of text.matchAll(ENTROPY_TOKEN)) {
    if (/[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token) && entropy(token) > 4.3) {
      return true
    }
  }
  return false
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
// RFC 2606 example domains and `git@host` remotes are not personal addresses.
const NOT_PERSONAL_EMAIL = /^git@|@(?:[\w-]+\.)*example\.(?:com|org|net)$/i
const email = (text: string): boolean => {
  for (const [match] of text.matchAll(EMAIL)) if (!NOT_PERSONAL_EMAIL.test(match)) return true
  return false
}

const PRIVACY_RULES: readonly PrivacyRule[] = [
  ...['api-key', 'env-secret', 'bearer-token'].map((name) => {
    const pattern = scrubPattern(name)
    // `search` ignores the global flag's lastIndex, so the shared regex stays stateless.
    return { name, hit: (text: string) => text.search(pattern) >= 0 }
  }),
  { name: 'private-key', hit: (text) => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text) },
  { name: 'high-entropy', hit: highEntropy },
  { name: 'email', hit: email },
  {
    name: 'phone',
    hit: (text) => /(?<![\d.])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d.])/.test(text),
  },
  {
    name: 'postal-address',
    hit: (text) =>
      /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Terrace|Parkway|Pkwy)\b/.test(
        text,
      ),
  },
]

export const PRIVACY_RULE_NAMES: readonly string[] = [
  ...PRIVACY_RULES.map((rule) => rule.name),
  'denylist',
]

function* stringsOf(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const item of value) yield* stringsOf(item)
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) yield* stringsOf(item)
  }
}

/**
 * The first privacy rule any string in `value` hits, or `null` when clean.
 * `denylist` holds literal terms (names, addresses, numbers) matched without
 * case; it is supplied at run time and never committed.
 */
export function privacyHit(value: unknown, denylist: readonly string[] = []): string | null {
  const terms = denylist.map((term) => term.toLowerCase()).filter(Boolean)
  for (const text of stringsOf(value)) {
    for (const rule of PRIVACY_RULES) if (rule.hit(text)) return rule.name
    if (terms.length > 0) {
      const lower = text.toLowerCase()
      if (terms.some((term) => lower.includes(term))) return 'denylist'
    }
  }
  return null
}
