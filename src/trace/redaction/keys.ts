import type { SafetyCategory } from './contract'

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
