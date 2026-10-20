import type { RedactionProfile, SafetyCategory } from './contract'

export const REDACTION_PROFILES: readonly RedactionProfile[] = ['default', 'share', 'strict']

/**
 * Version of the detector set and profile rules. Stored work that depends on
 * redaction behavior (saved optimizer inputs, per-span redaction stamps) keys
 * on it, so bump it whenever a detector, key list, cap or marker changes.
 */
export const REDACTION_VERSION = '2.4.0'

// ── Profiles ─────────────────────────────────────────────────────────────

export interface ProfileRules {
  maxStringBytes: number
  /** Key categories whose values are removed or pseudonymized. */
  redactKeys: ReadonlySet<'share-personal' | 'identifier' | 'raw-content'>
  redactMedia: boolean
  severity: Record<SafetyCategory, 'error' | 'warning' | undefined>
}

const KIB = 1024

export const PROFILE_RULES: Record<RedactionProfile, ProfileRules> = {
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

// ── Redaction ────────────────────────────────────────────────────────────

export const MAX_DEPTH = 64
