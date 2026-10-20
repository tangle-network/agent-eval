// ── Value detectors ──────────────────────────────────────────────────────

interface ValueDetector {
  id: string
  pattern: RegExp
}

/**
 * High-confidence credential shapes. A hit replaces the whole string. Each
 * pattern is written without the `g` flag so `test` stays stateless.
 *
 * The provider-branded prefixes below (`sk-ant-`, `AIza`, `ghp_`, `xoxb-`,
 * `AKIA`, `hubcap_`, `eyJ`…) have no leading `\b`. A `\b` word-boundary
 * assertion does not fire between two word characters, so it silently passed
 * a real token when something else glued a word character directly in front
 * of it — a compound identifier like `env.GITHUB_TOKEN_ghp_<token>` (a `_`
 * before `ghp_`) or `BACKUP_AKIA<key>` (a `_` before `AKIA`). These prefixes
 * are distinctive enough on their own, so scanning without that boundary
 * catches the same real credential wherever it is glued, at the cost of no
 * meaningful new false positives (`scripts/redaction-corpus.json` covers
 * both).
 */
const CREDENTIAL_DETECTORS: readonly ValueDetector[] = [
  { id: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'bearer', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  {
    id: 'authorization-header',
    pattern: /^\s*(?:basic|digest|apikey)\s+[A-Za-z0-9._~+/=:-]{8,}\s*$/i,
  },
  { id: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { id: 'provider-key', pattern: /sk-(?:proj-|tan-)?[A-Za-z0-9_-]{16,}/ },
  { id: 'stripe-key', pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{10,}/ },
  { id: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{20,}/ },
  { id: 'github-token', pattern: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'slack-token', pattern: /xox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'aws-access-key', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'tangle-capability', pattern: /(?:hubcap_|hct_)[A-Za-z0-9_=-]{8,}/ },
  {
    // Scheme, userinfo user and password each bounded (32/512/512 chars): the
    // unbounded `*`/`+` here made `detectCredential` catastrophically slow on
    // adversarial text with no `://` at all — 256 KiB of `"a."` took ~59s,
    // measured before this fix (scratchpad/rv/before.ts). A real URL's scheme
    // and userinfo are always far under these bounds.
    id: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,512}:[^\s/@]{1,512}@/i,
  },
  {
    id: 'url-secret-param',
    pattern:
      /[?&](?:access_token|api_key|apikey|auth|token|secret|password|sig|signature|x-amz-signature|x-goog-signature)=[^&\s"'#)]{8,}/i,
  },
  {
    // `GH_TOKEN=…`, `--api-key=…`, `"client_secret": "…"`, `password: …` in free
    // text. The value must mix letters and digits and be at least 12
    // characters, so prose (`token: string`), variable references (`$TOKEN`)
    // and dotenvx ciphertext (`encrypted:…`) pass. The pattern starts at the
    // key word itself, with no identifier prefix, so it scans in linear time.
    // The two mixed-content lookaheads and the value itself are bounded to
    // 512 chars: unbounded, `'token='` repeated took ~20s at 256 KiB and
    // `'password:x'` repeated took ~12s at 256 KiB (measured before this fix,
    // scratchpad/rv/before.ts). A real credential value is always far under
    // 512 chars.
    id: 'secret-assignment',
    pattern:
      /(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|password|passwd|passphrase|credentials?)["']?[ \t]*[:=][ \t]*["']?(?!encrypted:)(?![$`<[{(%])(?=[^\s"'`,;&|]{0,512}[0-9])(?=[^\s"'`,;&|]{0,512}[A-Za-z])[^\s"'`,;&|]{12,512}/i,
  },
  {
    // `{"password": "hunter2"}` or `'client_secret': '…'` inside serialized
    // JSON, YAML or a log line. A quoted credential field name followed by a
    // quoted value holds a secret whatever the value's shape or length. Bare
    // `"token"` is left out: model logprob output uses it for text tokens.
    // Placeholders (`[REDACTED…]`, `$VAR`, `{env:VAR}`, `***`, `<value>`) and
    // prose with two or more spaces (a field description) do not match.
    id: 'json-secret',
    pattern:
      /["'][A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|secret|password|passwd|passphrase|credentials?|(?:access|refresh|id|auth|session|bearer|api|github|gh|slack|npm)[_-]?token)["'][ \t]*:[ \t]*["'](?!\[REDACTED|[$*{<])(?![^"'\r\n]* [^"'\r\n]* )[^"'\r\n]{3,}["']/i,
  },
  {
    // `DB_PASSWORD=CorrectHorseBatteryStaple`, `PGPASSWORD=postgres`: unlike
    // `secret-assignment` above, the all-upper-case env-var name ending in a
    // credential word is itself the signal, so a letters-only or short real
    // password still matches (no digit-mixing or 12-char minimum). Requires
    // the name to be immediately followed by `=`, so `MAX_TOKENS=16` and
    // `TOKEN_EXPIRY=…` (the word isn't the end of the name) do not match.
    id: 'env-secret-assignment',
    pattern:
      /\b[A-Z][A-Z0-9_]*?(?:PASSWORD|PASSWD|SECRET|PASSPHRASE|APIKEY|API_KEY|TOKEN|CREDENTIALS?)[ \t]*=[ \t]*(?!\$|<|\*|\{|%|encrypted:)[^\s"'`,;&|]{4,}/,
  },
  // Bare-key shapes not covered above. Each requires a distinctive prefix so
  // it does not fire on ordinary identifiers — same reasoning as the
  // provider-branded block above, and the same leading-`\b` bug: a token
  // glued to preceding text by a digit or underscore (`1ghp_…`, `_sk_live_…`)
  // is invisible to an anchored detector.
  { id: 'huggingface-token', pattern: /hf_[A-Za-z0-9]{20,}/ },
  { id: 'npm-token', pattern: /npm_[A-Za-z0-9]{20,}/ },
  { id: 'gitlab-token', pattern: /glpat-[A-Za-z0-9_-]{16,}/ },
  { id: 'groq-key', pattern: /gsk_[A-Za-z0-9]{20,}/ },
  { id: 'xai-key', pattern: /xai-[A-Za-z0-9]{16,}/ },
  // ElevenLabs and similar bare `sk_<hex>` shapes — underscore, unlike the
  // hyphenated `sk-…` `provider-key` pattern above, so the two never overlap.
  { id: 'bare-sk-key', pattern: /sk_[A-Za-z0-9]{32,}\b/ },
  {
    // `Cookie: sessionid=…; csrftoken=…` in free text or a captured header.
    id: 'cookie-header',
    pattern: /\bcookie\s*:\s*[A-Za-z0-9_-]+=[^;\r\n]{3,}(?:;\s*[A-Za-z0-9_-]+=[^;\r\n]{3,})*/i,
  },
]

/** Personal-data shapes, replaced in place so the surrounding text survives. */
export const PERSONAL_DATA_DETECTORS: readonly (ValueDetector & {
  /** A substring the text must contain before the pattern runs. */
  requires?: string
  accept?: (match: string) => boolean
})[] = [
  {
    id: 'email',
    requires: '@',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    accept: isEmailAddress,
  },
  {
    // Card numbers: a card-network prefix and a valid Luhn digit, written
    // unbroken (13-19 digits) or in printed groups (4-4-4-4, 4-4-4-4-3, Amex
    // 4-6-5). A word character or hyphen on either side rejects the match, so
    // digits inside UUIDs, dated file names and hyphenated ids never match.
    id: 'card-number',
    pattern:
      /(?<![\w-])(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{3})?|\d{4}([ -])\d{6}\2\d{5})(?![\w-])/g,
    accept: (match) => {
      const digits = match.replace(/[ -]/g, '')
      return CARD_PREFIX.test(digits) && luhnValid(digits)
    },
  },
  { id: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    // Separators are required: a bare ten-digit run is usually an epoch second or an id.
    id: 'phone',
    pattern: /(?:\+1[-.\s]?)?(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g,
  },
]

/** Visa, Mastercard, Amex, Diners, JCB, Discover and UnionPay issuer prefixes. */
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[04-9]|6(?:011|4[4-9]|5|2))/

/**
 * Top-level domains that are file extensions: `icon@2x.png`, `worker@3.service`
 * and `notes@AGENTS.md` are not addresses.
 */
const NON_EMAIL_TLDS: ReadonlySet<string> = new Set([
  'md',
  'mdx',
  'txt',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'lock',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rs',
  'go',
  'sh',
  'css',
  'html',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'service',
  'socket',
  'timer',
  'mount',
  'target',
])

function isEmailAddress(match: string): boolean {
  // `git@github.com:org/repo` is an SSH remote, not a person.
  if (match.toLowerCase().startsWith('git@')) return false
  const tld = match.slice(match.lastIndexOf('.') + 1).toLowerCase()
  return !NON_EMAIL_TLDS.has(tld)
}

function luhnValid(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/** The first credential detector that matches, or undefined. */
export function detectCredential(text: string): string | undefined {
  for (const detector of CREDENTIAL_DETECTORS) {
    if (detector.pattern.test(text)) return detector.id
  }
  return undefined
}

/** Personal-data detector ids that match somewhere in `text`. */
export function detectPersonalData(text: string): string[] {
  const hits: string[] = []
  for (const detector of PERSONAL_DATA_DETECTORS) {
    if (detector.requires && !text.includes(detector.requires)) continue
    detector.pattern.lastIndex = 0
    for (const match of text.matchAll(detector.pattern)) {
      if (!detector.accept || detector.accept(match[0])) {
        hits.push(detector.id)
        break
      }
    }
  }
  return hits
}

/**
 * Every form in which a known secret can appear in a trace: as written,
 * base64, base64url and URL-encoded. Values shorter than 4 characters are
 * ignored; they would match ordinary text.
 */
export function knownSecretForms(values: readonly string[] | undefined): string[] {
  const forms = new Set<string>()
  for (const value of values ?? []) {
    if (value.length < 4) continue
    const bytes = Buffer.from(value, 'utf8')
    forms.add(value)
    forms.add(bytes.toString('base64'))
    forms.add(bytes.toString('base64url'))
    forms.add(encodeURIComponent(value))
  }
  // Longest first, so a secret that contains another is reported as itself.
  return [...forms].sort((left, right) => right.length - left.length)
}

const BASE64_TEXT = /^[A-Za-z0-9+/_-]+={0,2}$/

// A base64 blob embedded in larger text — `Authorization: Basic <base64>` is
// the common case — can hold a known secret without the WHOLE string being
// base64. Bounded to 4096 chars per candidate: this scans in linear time (the
// sum of candidate lengths is at most `text.length`), so no ReDoS risk.
const EMBEDDED_BASE64 = /[A-Za-z0-9+/]{16,4096}={0,2}/g

function containsKnownSecret(text: string, forms: readonly string[]): boolean {
  if (forms.length === 0) return false
  if (forms.some((form) => text.includes(form))) return true
  // A whole-string base64 payload can hold a secret at any byte offset.
  if (text.length >= 8 && BASE64_TEXT.test(text)) {
    const decoded = Buffer.from(
      text,
      text.includes('-') || text.includes('_') ? 'base64url' : 'base64',
    ).toString('utf8')
    if (forms.some((form) => decoded.includes(form))) return true
  }
  // `Basic <base64(user:key)>` jointly encodes the userinfo, so the secret's
  // OWN base64 form (added to `forms` above) is generally not a substring of
  // it — 3-byte base64 group alignment shifts with whatever precedes the
  // secret in the original bytes. Decode any embedded base64-looking run and
  // check its plaintext directly instead of relying on aligned forms.
  for (const match of text.matchAll(EMBEDDED_BASE64)) {
    if (match[0] === text) continue // already checked above
    try {
      const decoded = Buffer.from(match[0], 'base64').toString('utf8')
      if (forms.some((form) => decoded.includes(form))) return true
    } catch {
      // Not valid base64 (e.g. wrong padding) — not a candidate.
    }
  }
  return false
}

/** The detector that marks `text` as a credential: a known secret first, then the value shapes. */
export function credentialIn(text: string, knownSecrets: readonly string[]): string | undefined {
  return containsKnownSecret(text, knownSecrets) ? 'known-secret' : detectCredential(text)
}
