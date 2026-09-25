/**
 * The redaction core: the one place that decides what must not leave a
 * process or a machine. Every trace writer, exporter, uploader and share path
 * calls it.
 *
 * Three profiles, each a superset of the one before:
 *   - `default` removes credentials, found by key name and by value shape, and
 *     personal data (email addresses, card numbers, SSNs, phone numbers).
 *     Content is kept. Strings are capped at 1 MiB.
 *   - `share` also removes phone, IP and postal-address fields, replaces
 *     account, user, tenant, session and request identifiers with pseudonyms
 *     that stay consistent within one call, and caps strings at 64 KiB.
 *   - `strict` also removes prompt, completion, message, tool payload and other
 *     raw-content fields and embedded media, and caps strings at 4 KiB.
 *
 * A string that holds a credential is replaced whole with
 * `[REDACTED:<detector>]`. Replacing only the matched span can leave part of a
 * secret behind when a pattern's boundary is wrong. Personal data inside prose
 * is replaced in place, so the rest of the text stays readable.
 *
 * `assessShareSafety` reads a value without changing it and returns SAFE,
 * SAFE_WITH_WARNINGS, UNSAFE or UNKNOWN. UNKNOWN means the scanner could not
 * read part of the value (a cycle, binary data, nesting past the depth limit);
 * it is never reported as safe. `redactForShare` redacts and then assesses the
 * redacted output, so a detector gap shows up as UNSAFE instead of a leak.
 *
 * Reports and findings carry paths, categories and detector ids, never the
 * values they matched.
 *
 * The key classifier and the credential detector list are adapted from
 * agent-inspect (MIT, commit 3c3cbeda). `scripts/redaction-corpus.json` holds
 * the must-flag and must-not-flag cases, including the copied agent-inspect
 * safety corpus with its MIT notice; `pnpm redaction:corpus` runs this module
 * over every case.
 */

import { createHmac, randomBytes } from 'node:crypto'

export type RedactionProfile = 'default' | 'share' | 'strict'

export const REDACTION_PROFILES: readonly RedactionProfile[] = ['default', 'share', 'strict']

/** What a finding is about. `media` is embedded binary content (a `data:` URI) no text detector can read. */
export type SafetyCategory = 'credential' | 'personal-data' | 'identifier' | 'raw-content' | 'media'

/**
 * Version of the detector set and profile rules. Stored work that depends on
 * redaction behavior (saved optimizer inputs, per-span redaction stamps) keys
 * on it, so bump it whenever a detector, key list, cap or marker changes.
 */
export const REDACTION_VERSION = '2.0.0'

export interface RedactionFinding {
  /** JSON Pointer (RFC 6901) to the value or key that was changed. */
  path: string
  category: SafetyCategory
  detector: string
  action: 'redacted' | 'pseudonymized' | 'truncated'
}

export interface RedactionReport {
  version: string
  profile: RedactionProfile
  /** Values and keys replaced, pseudonymized or truncated. */
  redactionCount: number
  byDetector: Record<string, number>
  truncatedCount: number
  findings: RedactionFinding[]
}

export interface RedactOptions {
  /** Default `default`. */
  profile?: RedactionProfile
  /** Lower the profile's per-string cap. A value above the profile cap is ignored. */
  maxStringBytes?: number
  /**
   * Exact values the caller knows are secret (an API key the run was given, a
   * password from the environment). A string or key that contains one, or its
   * base64, base64url or URL-encoded form, is replaced whole with
   * `[REDACTED:known-secret]`, whatever shape the value has.
   */
  knownSecrets?: readonly string[]
  /** Add this call's findings to an existing report instead of a new one. */
  report?: RedactionReport
}

export interface AssessOptions {
  /** Default `default`. */
  profile?: RedactionProfile
  /** As in `RedactOptions`: any surviving occurrence makes the verdict UNSAFE. */
  knownSecrets?: readonly string[]
}

export type ShareSafetyStatus = 'SAFE' | 'SAFE_WITH_WARNINGS' | 'UNSAFE' | 'UNKNOWN'

export interface ShareSafetyFinding {
  category: SafetyCategory
  detector: string
  severity: 'error' | 'warning'
  count: number
  /** Up to five JSON Pointers where the detector fired. */
  paths: string[]
}

export interface ShareSafetyVerdict {
  status: ShareSafetyStatus
  profile: RedactionProfile
  findings: ShareSafetyFinding[]
  /** Parts the scanner could not read, as `<path>: <reason>`. Any entry makes the status UNKNOWN. */
  unreadable: string[]
}

// ── Profiles ─────────────────────────────────────────────────────────────

interface ProfileRules {
  maxStringBytes: number
  /** Key categories whose values are removed or pseudonymized. */
  redactKeys: ReadonlySet<'share-personal' | 'identifier' | 'raw-content'>
  redactMedia: boolean
  severity: Record<SafetyCategory, 'error' | 'warning' | undefined>
}

const KIB = 1024

const PROFILE_RULES: Record<RedactionProfile, ProfileRules> = {
  default: {
    maxStringBytes: 1024 * KIB,
    redactKeys: new Set(),
    redactMedia: false,
    severity: {
      credential: 'error',
      'personal-data': 'warning',
      identifier: undefined,
      'raw-content': 'warning',
      media: 'warning',
    },
  },
  share: {
    maxStringBytes: 64 * KIB,
    redactKeys: new Set(['share-personal', 'identifier']),
    redactMedia: false,
    severity: {
      credential: 'error',
      'personal-data': 'error',
      identifier: 'warning',
      'raw-content': 'warning',
      media: 'warning',
    },
  },
  strict: {
    maxStringBytes: 4 * KIB,
    redactKeys: new Set(['share-personal', 'identifier', 'raw-content']),
    redactMedia: true,
    severity: {
      credential: 'error',
      'personal-data': 'error',
      identifier: 'warning',
      'raw-content': 'error',
      media: 'error',
    },
  },
}

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

function classifyKeyName(key: string): KeyClass | undefined {
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

interface ValueDetector {
  id: string
  pattern: RegExp
}

/**
 * High-confidence credential shapes. A hit replaces the whole string. Each
 * pattern is written without the `g` flag so `test` stays stateless.
 */
const CREDENTIAL_DETECTORS: readonly ValueDetector[] = [
  { id: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'bearer', pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  {
    id: 'authorization-header',
    pattern: /^\s*(?:basic|digest|apikey)\s+[A-Za-z0-9._~+/=:-]{8,}\s*$/i,
  },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { id: 'provider-key', pattern: /\bsk-(?:proj-|tan-)?[A-Za-z0-9_-]{16,}/ },
  { id: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{10,}/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { id: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: 'slack-token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: 'tangle-capability', pattern: /\b(?:hubcap_|hct_)[A-Za-z0-9_=-]{8,}/ },
  { id: 'url-credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
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
    id: 'secret-assignment',
    pattern:
      /(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|secret|token|password|passwd|passphrase|credentials?)["']?[ \t]*[:=][ \t]*["']?(?!encrypted:)(?![$`<[{(%])(?=[^\s"'`,;&|]*[0-9])(?=[^\s"'`,;&|]*[A-Za-z])[^\s"'`,;&|]{12,}/i,
  },
]

/** Personal-data shapes, replaced in place so the surrounding text survives. */
const PERSONAL_DATA_DETECTORS: readonly (ValueDetector & {
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
function knownSecretForms(values: readonly string[] | undefined): string[] {
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

function containsKnownSecret(text: string, forms: readonly string[]): boolean {
  if (forms.length === 0) return false
  if (forms.some((form) => text.includes(form))) return true
  // A whole-string base64 payload can hold a secret at any byte offset.
  if (text.length < 8 || !BASE64_TEXT.test(text)) return false
  const decoded = Buffer.from(
    text,
    text.includes('-') || text.includes('_') ? 'base64url' : 'base64',
  ).toString('utf8')
  return forms.some((form) => decoded.includes(form))
}

/** The detector that marks `text` as a credential: a known secret first, then the value shapes. */
function credentialIn(text: string, knownSecrets: readonly string[]): string | undefined {
  return containsKnownSecret(text, knownSecrets) ? 'known-secret' : detectCredential(text)
}

const MARKER_PREFIX = '[REDACTED:'

function marker(detector: string): string {
  return `${MARKER_PREFIX}${detector}]`
}

/**
 * Placeholders other tools write for a removed value. A credential field that
 * holds one of these is already redacted and is not flagged again.
 */
const REDACTED_PLACEHOLDER =
  /^(?:\[(?:REDACTED|redacted)(?::[^\]]*)?\]|\[ID:[0-9a-f]{12}\]|\*{3,}|<redacted>|«redacted»|\[HASH:[0-9a-f]{8,}\])$/

function isPlaceholder(value: string): boolean {
  return value === '' || REDACTED_PLACEHOLDER.test(value)
}

const DATA_URI = /^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,/i

// ── Redaction ────────────────────────────────────────────────────────────

const MAX_DEPTH = 64

interface WalkState {
  rules: ProfileRules
  maxStringBytes: number
  knownSecrets: string[]
  report: RedactionReport
  pseudonymKey: Buffer
  seen: WeakSet<object>
}

function record(
  state: WalkState,
  path: string,
  category: SafetyCategory,
  detector: string,
  action: RedactionFinding['action'],
): void {
  const report = state.report
  if (action === 'truncated') report.truncatedCount += 1
  report.redactionCount += 1
  report.byDetector[detector] = (report.byDetector[detector] ?? 0) + 1
  report.findings.push({ path, category, detector, action })
}

function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`
}

function truncateUtf8(text: string, maxBytes: number): string | undefined {
  if (text.length <= maxBytes / 4) return undefined
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return undefined
  // Step back to the first byte of a UTF-8 sequence so no character is split.
  let cut = maxBytes
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut -= 1
  return `${bytes.subarray(0, cut).toString('utf8')}…[truncated ${bytes.length - cut} bytes]`
}

function redactStringAt(text: string, path: string, state: WalkState): string {
  if (isPlaceholder(text)) return text
  if (DATA_URI.test(text)) {
    if (!state.rules.redactMedia) return text
    record(state, path, 'media', 'media', 'redacted')
    return marker('media')
  }
  const credential = credentialIn(text, state.knownSecrets)
  if (credential) {
    record(state, path, 'credential', credential, 'redacted')
    return marker(credential)
  }
  let output = text
  for (const detector of PERSONAL_DATA_DETECTORS) {
    if (detector.requires && !output.includes(detector.requires)) continue
    output = output.replace(detector.pattern, (match) => {
      if (detector.accept && !detector.accept(match)) return match
      record(state, path, 'personal-data', detector.id, 'redacted')
      return marker(detector.id)
    })
  }
  const truncated = truncateUtf8(output, state.maxStringBytes)
  if (truncated === undefined) return output
  record(state, path, 'raw-content', 'size-cap', 'truncated')
  return truncated
}

function pseudonym(value: string | number, state: WalkState): string {
  const digest = createHmac('sha256', state.pseudonymKey).update(String(value)).digest('hex')
  return `[ID:${digest.slice(0, 12)}]`
}

function redactKeyed(
  key: string,
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
): unknown {
  const kind = classifyKeyName(key)
  if (value === null || value === undefined || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string' && isPlaceholder(value)) return value
  // Numbers under a credential name are limits and counts (`password_max_age`), not secrets.
  if (kind === 'credential' && typeof value !== 'number') {
    record(state, path, 'credential', 'credential-key', 'redacted')
    return marker('credential-key')
  }
  if (
    kind === 'email' ||
    (kind === 'share-personal' && state.rules.redactKeys.has('share-personal'))
  ) {
    if (typeof value === 'string' || typeof value === 'number') {
      record(state, path, 'personal-data', 'personal-data-key', 'redacted')
      return marker('personal-data-key')
    }
  }
  if (kind === 'identifier' && state.rules.redactKeys.has('identifier')) {
    if (typeof value === 'string' || typeof value === 'number') {
      record(state, path, 'identifier', 'identifier-key', 'pseudonymized')
      return pseudonym(value, state)
    }
  }
  if (
    kind === 'raw-content' &&
    state.rules.redactKeys.has('raw-content') &&
    typeof value !== 'number'
  ) {
    record(state, path, 'raw-content', 'raw-content-key', 'redacted')
    return marker('raw-content-key')
  }
  return walk(value, path, depth + 1, state)
}

function walk(value: unknown, path: string, depth: number, state: WalkState): unknown {
  if (typeof value === 'string') return redactStringAt(value, path, state)
  if (value === null || typeof value !== 'object') return value
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    record(state, path, 'media', 'binary', 'redacted')
    return marker('binary')
  }
  if (value instanceof Date) return value
  if (depth > MAX_DEPTH) {
    record(state, path, 'raw-content', 'depth-limit', 'truncated')
    return marker('depth-limit')
  }
  if (state.seen.has(value)) {
    record(state, path, 'raw-content', 'circular', 'redacted')
    return marker('circular')
  }
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, pointer(path, index), depth + 1, state))
    }
    const out: Record<string, unknown> = {}
    let renamed = 0
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      let outKey = key
      const keyCredential = credentialIn(key, state.knownSecrets)
      if (keyCredential) {
        renamed += 1
        outKey = `${marker(keyCredential)}#${renamed}`
        record(state, pointer(path, outKey), 'credential', keyCredential, 'redacted')
      }
      out[outKey] = redactKeyed(key, item, pointer(path, outKey), depth, state)
    }
    return out
  } finally {
    state.seen.delete(value)
  }
}

function newReport(profile: RedactionProfile): RedactionReport {
  return {
    version: REDACTION_VERSION,
    profile,
    redactionCount: 0,
    byDetector: {},
    truncatedCount: 0,
    findings: [],
  }
}

function newState(options: RedactOptions, report?: RedactionReport): WalkState {
  const profile = options.profile ?? 'default'
  const rules = PROFILE_RULES[profile]
  if (!rules) throw new Error(`unknown redaction profile: ${String(profile)}`)
  const requested = options.maxStringBytes
  const maxStringBytes =
    typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
      ? Math.min(Math.floor(requested), rules.maxStringBytes)
      : rules.maxStringBytes
  return {
    rules,
    maxStringBytes,
    knownSecrets: knownSecretForms(options.knownSecrets),
    report: report ?? newReport(profile),
    pseudonymKey: randomBytes(32),
    seen: new WeakSet(),
  }
}

/**
 * Return a redacted deep copy of `value` and a report of what changed. Pure:
 * the input is not mutated. Never throws on the value's shape; cycles, binary
 * data and nesting past 64 levels are replaced with markers.
 */
export function redact<T>(
  value: T,
  options: RedactOptions = {},
): { value: T; report: RedactionReport } {
  const state = newState(options, options.report)
  const out = walk(value, '', 0, state) as T
  return { value: out, report: state.report }
}

/**
 * Redact one free-text string with the value detectors (no field name is
 * known). Pass `report` to accumulate counts across calls.
 */
export function redactText(text: string, options: RedactOptions = {}): string {
  const state = newState(options, options.report)
  return redactStringAt(text, '', state)
}

/** An empty report to accumulate `redactText` calls into. */
export function emptyRedactionReport(profile: RedactionProfile = 'default'): RedactionReport {
  return newReport(profile)
}

// ── Share-safety assessment ──────────────────────────────────────────────

interface ScanState {
  profile: RedactionProfile
  rules: ProfileRules
  knownSecrets: string[]
  findings: Map<string, ShareSafetyFinding>
  unreadable: string[]
  seen: WeakSet<object>
}

function flag(state: ScanState, path: string, category: SafetyCategory, detector: string): void {
  const severity = state.rules.severity[category]
  if (!severity) return
  const id = `${category}\u0000${detector}`
  const existing = state.findings.get(id)
  if (existing) {
    existing.count += 1
    if (existing.paths.length < 5) existing.paths.push(path)
    return
  }
  state.findings.set(id, { category, detector, severity, count: 1, paths: [path] })
}

function scanString(text: string, path: string, state: ScanState): void {
  if (isPlaceholder(text)) return
  if (DATA_URI.test(text)) {
    flag(state, path, 'media', 'media')
    return
  }
  const credential = credentialIn(text, state.knownSecrets)
  if (credential) {
    flag(state, path, 'credential', credential)
    return
  }
  for (const detector of detectPersonalData(text)) flag(state, path, 'personal-data', detector)
}

function scanKeyed(
  key: string,
  value: unknown,
  path: string,
  depth: number,
  state: ScanState,
): void {
  if (value === null || value === undefined || typeof value === 'boolean') return
  if (typeof value === 'string' && isPlaceholder(value)) return
  const category = classifyKey(key)
  if (category === 'credential' && typeof value !== 'number') {
    flag(state, path, 'credential', 'credential-key')
    return
  }
  const scalar = typeof value === 'string' || typeof value === 'number'
  if (category === 'personal-data' && scalar) {
    const kind = classifyKeyName(key)
    // Phone, IP and address fields are flagged from the share profile up; email always.
    if (kind === 'email' || state.profile !== 'default') {
      flag(state, path, 'personal-data', 'personal-data-key')
      return
    }
  }
  if (category === 'identifier' && scalar) flag(state, path, 'identifier', 'identifier-key')
  if (category === 'raw-content' && typeof value !== 'number')
    flag(state, path, 'raw-content', 'raw-content-key')
  scan(value, path, depth + 1, state)
}

function scan(value: unknown, path: string, depth: number, state: ScanState): void {
  if (typeof value === 'string') {
    scanString(value, path, state)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    state.unreadable.push(`${path || '/'}: binary data`)
    return
  }
  if (value instanceof Date) return
  if (depth > MAX_DEPTH) {
    state.unreadable.push(`${path || '/'}: nested deeper than ${MAX_DEPTH} levels`)
    return
  }
  if (state.seen.has(value)) {
    state.unreadable.push(`${path || '/'}: circular reference`)
    return
  }
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries())
        scan(item, pointer(path, index), depth + 1, state)
      return
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // A credential used as a key must not reach the finding paths.
      const keyCredential = credentialIn(key, state.knownSecrets)
      const segment = keyCredential ? marker(keyCredential) : key
      if (keyCredential) flag(state, pointer(path, segment), 'credential', keyCredential)
      scanKeyed(key, item, pointer(path, segment), depth, state)
    }
  } finally {
    state.seen.delete(value)
  }
}

/**
 * Read `value` without changing it and say whether it is safe to share under
 * `profile`. UNKNOWN when any part could not be read; UNSAFE when any
 * error-severity finding remains; SAFE_WITH_WARNINGS when only warnings
 * remain (raw content, embedded media, identifiers under `share`).
 */
export function assessShareSafety(value: unknown, options: AssessOptions = {}): ShareSafetyVerdict {
  const profile = options.profile ?? 'default'
  const rules = PROFILE_RULES[profile]
  if (!rules) throw new Error(`unknown redaction profile: ${String(profile)}`)
  const state: ScanState = {
    profile,
    rules,
    knownSecrets: knownSecretForms(options.knownSecrets),
    findings: new Map(),
    unreadable: [],
    seen: new WeakSet(),
  }
  scan(value, '', 0, state)
  return verdictFrom(profile, [...state.findings.values()], state.unreadable)
}

/**
 * One verdict over several parts (files in a directory, spans in a bundle).
 * Callers prefix each part's paths with its source before combining.
 */
export function combineVerdicts(
  profile: RedactionProfile,
  verdicts: readonly ShareSafetyVerdict[],
  unreadable: readonly string[] = [],
): ShareSafetyVerdict {
  const findings = new Map<string, ShareSafetyFinding>()
  for (const verdict of verdicts) {
    for (const finding of verdict.findings) {
      const id = `${finding.category}\u0000${finding.detector}`
      const existing = findings.get(id)
      if (!existing) {
        findings.set(id, { ...finding, paths: [...finding.paths] })
        continue
      }
      existing.count += finding.count
      for (const path of finding.paths) if (existing.paths.length < 5) existing.paths.push(path)
    }
  }
  return verdictFrom(
    profile,
    [...findings.values()],
    [...verdicts.flatMap((verdict) => verdict.unreadable), ...unreadable],
  )
}

function verdictFrom(
  profile: RedactionProfile,
  findings: readonly ShareSafetyFinding[],
  unreadable: readonly string[],
): ShareSafetyVerdict {
  const status: ShareSafetyStatus =
    unreadable.length > 0
      ? 'UNKNOWN'
      : findings.some((finding) => finding.severity === 'error')
        ? 'UNSAFE'
        : findings.length > 0
          ? 'SAFE_WITH_WARNINGS'
          : 'SAFE'
  return { status, profile, findings: [...findings], unreadable: [...unreadable] }
}

/** Whether a verdict allows sharing: SAFE or SAFE_WITH_WARNINGS. UNSAFE and UNKNOWN refuse. */
export function shareAllowed(verdict: ShareSafetyVerdict): boolean {
  return verdict.status === 'SAFE' || verdict.status === 'SAFE_WITH_WARNINGS'
}

/**
 * Redact `value` under `profile`, then assess the redacted output. The
 * verdict describes what would actually be shared: a detector that failed to
 * remove something shows up as UNSAFE here.
 */
export function redactForShare<T>(
  value: T,
  options: RedactOptions = {},
): { value: T; report: RedactionReport; verdict: ShareSafetyVerdict } {
  const redacted = redact(value, options)
  const verdict = assessShareSafety(redacted.value, {
    profile: options.profile,
    knownSecrets: options.knownSecrets,
  })
  return { value: redacted.value, report: redacted.report, verdict }
}
