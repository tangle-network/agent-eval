import type { SafetyCategory } from '../redact'

// ── Key classifier ───────────────────────────────────────────────────────

/**
 * Canonical snake_case form of a field name, so camelCase, kebab-case, dotted
 * and snake_case spellings match one list: `userPassword`, `user-password` and
 * `user.password` all become `user_password`.
 */
export function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Counts, limits and model vocabulary that contain the word "token" but are not credentials. */
const NON_CREDENTIAL_TOKEN_KEYS: ReadonlySet<string> = new Set([
  'tokens',
  'max_tokens',
  'min_tokens',
  'ls_max_tokens',
  'token_count',
  'token_limit',
  'token_budget',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cached_tokens',
  'prompt_tokens',
  'completion_tokens',
  'reasoning_tokens',
  'bos_token',
  'eos_token',
  'pad_token',
  'unk_token',
  'sep_token',
  'cls_token',
  'mask_token',
  'stop_token',
  // Pagination cursors are opaque but not credentials.
  'page_token',
  'next_page_token',
  'prev_page_token',
  'next_token',
  'continuation_token',
  'cursor_token',
  'sync_token',
])

const CREDENTIAL_KEYS = [
  'authorization',
  'auth',
  'cookie',
  'api_key',
  'apikey',
  'api_token',
  'access_key',
  'secret_key',
  'private_key',
  'signing_key',
  'encryption_key',
  'master_key',
  'session_key',
  'client_secret',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'bearer',
  'dsn',
  'database_url',
  'connection_string',
  'pat',
] as const

/** Email fields are personal data in every profile. */
const EMAIL_KEYS = ['email', 'email_address'] as const

/** Personal-data fields removed by the share and strict profiles. */
const SHARE_PERSONAL_KEYS = [
  'phone',
  'phone_number',
  'mobile',
  'ip',
  'ip_address',
  'remote_addr',
  'street_address',
  'postal_address',
  'home_address',
  'billing_address',
  'shipping_address',
  'mailing_address',
  'date_of_birth',
  'dob',
  'ssn',
] as const

/** Identifiers pseudonymized by the share and strict profiles. */
const IDENTIFIER_KEYS = [
  'user_id',
  'user_uuid',
  'account_id',
  'account_uuid',
  'customer_id',
  'tenant_id',
  'org_id',
  'organization_id',
  'organisation_id',
  'team_id',
  'enduser_id',
  'actor_id',
  'principal_id',
  'member_id',
  'session_id',
  'request_id',
  'correlation_id',
  'device_id',
  'installation_id',
] as const

/** Fields that carry prompts, model output, tool payloads or other free text. Removed by `strict`. */
const RAW_CONTENT_KEYS = [
  'prompt',
  'prompts',
  'system_prompt',
  'completion',
  'input',
  'output',
  'message',
  'messages',
  'content',
  'text',
  'thinking',
  'reasoning',
  'transcript',
  'context',
  'document',
  'documents',
  'chunk',
  'chunks',
  'retrieval',
  'query',
  'args',
  'arguments',
  'result',
  'body',
  'command',
  'full_command',
  'input_value',
  'output_value',
  'instructions',
  'system_instructions',
  'stdout',
  'stderr',
  'stacktrace',
  'status_description',
  'input_preview',
  'output_preview',
  'current_task',
  'user_input',
  'request_text',
] as const

/**
 * A key matches a list entry exactly or as a suffix (`openai_api_key`,
 * `db_password`, `tool_output`). Prefix compounds (`secret_name`,
 * `password_min_length`, `auth_type`, `content_type`) do not match: they name
 * or describe a value rather than hold it, and flagging them would make the
 * share verdict refuse ordinary traces. Value detectors still catch a
 * credential-shaped value under any key.
 */
function matchesKeyList(normalized: string, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (normalized === key || normalized.endsWith(`_${key}`)) return true
  }
  return false
}

function isTokenCredentialKey(normalized: string): boolean {
  if (NON_CREDENTIAL_TOKEN_KEYS.has(normalized)) return false
  if (normalized === 'token') return true
  // access_token and refreshToken are credentials; max_tokens and input_tokens are counts.
  if (normalized.endsWith('tokens')) return false
  return normalized.endsWith('token')
}

type KeyClass = 'credential' | 'email' | 'share-personal' | 'identifier' | 'raw-content'

/** Trace keys repeat on every span, so classifications are cached. */
const keyClassCache = new Map<string, KeyClass | null>()

export function classifyKeyName(key: string): KeyClass | undefined {
  const cached = keyClassCache.get(key)
  if (cached !== undefined) return cached ?? undefined
  const kind = classifyNormalizedKey(normalizeKey(key))
  if (keyClassCache.size >= 10_000) keyClassCache.clear()
  keyClassCache.set(key, kind ?? null)
  return kind
}

function classifyNormalizedKey(normalized: string): KeyClass | undefined {
  if (!normalized || NON_CREDENTIAL_TOKEN_KEYS.has(normalized)) return undefined
  if (isTokenCredentialKey(normalized)) return 'credential'
  if (matchesKeyList(normalized, CREDENTIAL_KEYS)) return 'credential'
  if (matchesKeyList(normalized, EMAIL_KEYS)) return 'email'
  if (matchesKeyList(normalized, SHARE_PERSONAL_KEYS)) return 'share-personal'
  if (matchesKeyList(normalized, IDENTIFIER_KEYS)) return 'identifier'
  if (matchesKeyList(normalized, RAW_CONTENT_KEYS)) return 'raw-content'
  return undefined
}

/**
 * The safety category a field name puts its value in, or undefined for an
 * ordinary field. Token counts and model limits (`inputTokens`, `max_tokens`,
 * `token_count`) and names such as `author` are not credentials.
 */
export function classifyKey(key: string): SafetyCategory | undefined {
  const kind = classifyKeyName(key)
  if (kind === undefined) return undefined
  if (kind === 'credential') return 'credential'
  if (kind === 'identifier') return 'identifier'
  if (kind === 'raw-content') return 'raw-content'
  return 'personal-data'
}

// ── Value detectors ──────────────────────────────────────────────────────

export interface ValueDetectorOptions {
  /** Conservative scanning treats untyped bare numbers as private; formatted preserves the core's existing policy. */
  numericPolicy?: 'formatted' | 'conservative'
}

export interface ValueDetector {
  readonly id: string
  readonly pattern: RegExp
  readonly requires?: string
  readonly substringPattern?: RegExp
  readonly conservativePattern?: RegExp
  readonly accept?: (match: string, options?: ValueDetectorOptions) => boolean
}

/** Stateless UTF-16 ranges for String.slice. Named `secret` groups preserve surrounding syntax. */
export function* matchValueDetector(
  text: string,
  detector: ValueDetector,
  options: ValueDetectorOptions = {},
): Generator<{ start: number; end: number }> {
  if (detector.requires && !text.includes(detector.requires)) return
  const pattern =
    options.numericPolicy === 'conservative'
      ? (detector.conservativePattern ?? detector.substringPattern ?? detector.pattern)
      : (detector.substringPattern ?? detector.pattern)
  const flags = [...new Set(`${pattern.flags}gd`)].join('')
  // A credential shape inside a quoted secret must remove its entire value.
  // Reuse the quoted-value rule; advance one iterator so matches stay linear.
  const quoted =
    detector.id !== 'json-secret' && CREDENTIAL_DETECTORS.includes(detector)
      ? matchValueDetector(
          text,
          CREDENTIAL_DETECTORS.find((rule) => rule.id === 'json-secret')!,
          options,
        )
      : undefined
  let enclosing: { start: number; end: number } | undefined
  let coveredUntil = -1
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    if (detector.accept && !detector.accept(match[0], options)) continue
    let [start, end] = match.indices!.groups?.secret ?? match.indices![0]!
    if (start < coveredUntil) continue
    if (quoted) {
      while (!enclosing || enclosing.end <= start) {
        const next = quoted.next()
        enclosing = next.value
        if (next.done) break
      }
      if (enclosing && enclosing.start <= start && enclosing.end >= end)
        ({ start, end } = enclosing)
    }
    if (start < coveredUntil) continue
    coveredUntil = end
    yield { start, end }
  }
}

const CREDENTIAL_ASSIGNMENT_KEY =
  /(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|password|passwd|passphrase|credentials?)/

const SECRET_ASSIGNMENT = new RegExp(
  CREDENTIAL_ASSIGNMENT_KEY.source +
    '["\']?[ \\t]*[:=][ \\t]*["\']?(?!encrypted:)(?![$`<[{(%])(?=[^\\s"\'`,;&|]{0,512}[0-9])(?=[^\\s"\'`,;&|]{0,512}[A-Za-z])(?<secret>[^\\s"\'`,;&|]{12,512})',
  'i',
)

const QUOTED_CREDENTIAL_FIELD =
  /["'][A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|secret|password|passwd|passphrase|credentials?|(?:access|refresh|id|auth|session|bearer|api|github|gh|slack|npm)[_-]?token)["'][ \t]*:[ \t]*/

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
export const CREDENTIAL_DETECTORS: readonly ValueDetector[] = [
  {
    id: 'private-key',
    pattern: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[^"'`]*?(?:-----END \1-----|(?=["'`]|$))/,
  },
  { id: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'bearer', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  {
    id: 'authorization-header',
    pattern: /^\s*(?:basic|digest|apikey)\s+[A-Za-z0-9._~+/=:-]{8,}\s*$/i,
  },
  { id: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { id: 'tangle-key', pattern: /sk-tan-[A-Za-z0-9_-]{8,}/ },
  { id: 'gtm-operator-key', pattern: /gak_[A-Za-z0-9_-]{8,}/ },
  { id: 'agent-app-key', pattern: /lak_[A-Za-z0-9_-]{8,}/ },
  { id: 'platform-labs-key', pattern: /plabs_[A-Za-z0-9_-]{8,}/ },
  { id: 'stripe-webhook-secret', pattern: /whsec_[A-Za-z0-9]{8,}/ },
  { id: 'provider-key', pattern: /sk-(?:proj-|tan-)?[A-Za-z0-9_-]{16,}/ },
  { id: 'stripe-key', pattern: /(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_]{8,}/ },
  { id: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{20,}/ },
  { id: 'github-token', pattern: /(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/ },
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
    pattern: /\b[a-z][a-z0-9+.-]{0,31}:\/\/(?<secret>[^\s/:@]{1,512}:[^\s/@]{1,512})@/i,
  },
  {
    id: 'url-secret-param',
    pattern:
      /[?&](?:access_token|api_key|apikey|auth|token|secret|password|sig|signature|x-amz-signature|x-goog-signature)=(?<secret>[^&\s"'#)]{8,})/i,
  },
  {
    // `GH_TOKEN=…`, `--api-key=…`, `"client_secret": "…"`, `password: …` in free
    // text. The value must mix letters and digits and be at least 12
    // characters, so prose (`token: string`), variable references (`$TOKEN`)
    // and dotenvx ciphertext (`encrypted:…`) pass. The pattern starts at the
    // key word itself, with no identifier prefix, so it scans in linear time.
    // Detection and its mixed-content lookaheads are bounded to 512 chars:
    // unbounded, `'token='` repeated took ~20s at 256 KiB and
    // `'password:x'` repeated took ~12s at 256 KiB (measured before this fix,
    // scratchpad/rv/before.ts). Substring replacement consumes the complete
    // detected token so a long value cannot leave an unrecognized tail.
    id: 'secret-assignment',
    pattern: SECRET_ASSIGNMENT,
    // Only the consumed range is unbounded; detection lookaheads remain bounded.
    substringPattern: new RegExp(
      SECRET_ASSIGNMENT.source.replace('{12,512}', '{12,}'),
      SECRET_ASSIGNMENT.flags,
    ),
  },
  {
    // `{"password": "hunter2"}` or `'client_secret': '…'` inside serialized
    // JSON, YAML or a log line. A quoted credential field name followed by a
    // quoted value holds a secret whatever the value's shape or length. Bare
    // `"token"` is left out: model logprob output uses it for text tokens.
    // Placeholders (`[REDACTED…]`, `$VAR`, `{env:VAR}`, `***`, `<value>`) and
    // prose with two or more spaces (a field description) do not match.
    id: 'json-secret',
    pattern: new RegExp(
      String.raw`${QUOTED_CREDENTIAL_FIELD.source}["'](?!\[REDACTED|[$*{<])(?![^"'\r\n]* [^"'\r\n]* )(?<secret>[^"'\r\n]{3,})["']`,
      'i',
    ),
    // Quoted fields and assignments cover spaces and escaped quotes in the whole value.
    substringPattern: new RegExp(
      String.raw`(?:${QUOTED_CREDENTIAL_FIELD.source}|${CREDENTIAL_ASSIGNMENT_KEY.source}[ \t]*[:=][ \t]*)(?<quote>["'])(?!\[REDACTED|[$*{<])(?<secret>(?:\\.|(?!\k<quote>)[^\\\r\n]){3,})\k<quote>`,
      'i',
    ),
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
      /\b[A-Z][A-Z0-9_]*?(?:PASSWORD|PASSWD|SECRET|PASSPHRASE|APIKEY|API_KEY|TOKEN|CREDENTIALS?)[ \t]*=[ \t]*(?!\$|<|\*|\{|%|encrypted:)(?<secret>[^\s"'`,;&|]{4,})/,
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
    substringPattern:
      /\bcookie\s*:\s*(?<secret>[A-Za-z0-9_-]+=(?:(?<quote>\\?")[^\r\n]*?\k<quote>|[^;\s"'\r\n]{3,})(?:;\s*[A-Za-z0-9_-]+=(?:(?<quote2>\\?")[^\r\n]*?\k<quote2>|[^;\s"'\r\n]{3,}))*)/i,
  },
]

const CARD_NUMBER =
  /(?<![\w-])(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{3})?|\d{4}([ -])\d{6}\2\d{5})(?![\w-])/g
const PHONE_NUMBER = /(?:\+1[-.\s]?)?(?:\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g

// Whole UUIDs and decimals are exemptions, not prefixes of a neighboring value.
// Reuse formatted rules; whitespace cannot join otherwise independent numbers.
const NUMERIC_PRIVACY = new RegExp(
  String.raw`(?<![A-Za-z0-9_])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_])|(?<![A-Za-z0-9_.-])\d+\.\d+(?![\w.])|${CARD_NUMBER.source}|${PHONE_NUMBER.source}|(?<![A-Za-z0-9_-])\+\d{1,3}[ \t.-](?:\(\d{1,4}\)|\d{1,4})[ \t.-](?:\d{3,4}[ \t.-]\d{3,4}|\d{5,8})(?![\w-])|(?<![A-Za-z0-9_-])\+?\d[\d().-]{8,}\d(?![A-Za-z0-9_])`,
  'gi',
)

function numericPrivacyKind(
  value: string,
  options: ValueDetectorOptions = {},
): 'card-number' | 'phone' | undefined {
  if (
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ||
    /^\d*\.\d+$/.test(value) ||
    /\d\.\d{5,}/.test(value)
  )
    return
  const digits = value.replace(/\D/g, '')
  const conservative = options.numericPolicy === 'conservative'
  if (
    digits.length >= 13 &&
    digits.length <= 19 &&
    (conservative || CARD_PREFIX.test(digits)) &&
    luhnValid(digits, conservative)
  )
    return 'card-number'
  if (digits.length >= 10 && digits.length <= 15) return 'phone'
}

/** Ordered rules. Conservative numeric scanning is explicit; core patterns keep their existing defaults. */
export const PERSONAL_DATA_DETECTORS: readonly ValueDetector[] = [
  {
    id: 'email',
    requires: '@',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    accept: isEmailAddress,
  },
  {
    id: 'card-number',
    pattern: CARD_NUMBER,
    conservativePattern: NUMERIC_PRIVACY,
    accept: (value, options) => numericPrivacyKind(value, options) === 'card-number',
  },
  { id: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    id: 'phone',
    pattern: PHONE_NUMBER,
    conservativePattern: NUMERIC_PRIVACY,
    accept: (value, options) => numericPrivacyKind(value, options) === 'phone',
  },
]

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

function luhnValid(digits: string, allowRepeated = false): boolean {
  if (!allowRepeated && /^(\d)\1+$/.test(digits)) return false
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
  return PERSONAL_DATA_DETECTORS.filter(
    (detector) => !matchValueDetector(text, detector).next().done,
  ).map((detector) => detector.id)
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
