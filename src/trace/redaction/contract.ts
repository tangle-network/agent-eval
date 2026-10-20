export type RedactionProfile = 'default' | 'share' | 'strict'

/** What a finding is about. `media` is embedded binary content (a `data:` URI) no text detector can read. */
export type SafetyCategory = 'credential' | 'personal-data' | 'identifier' | 'raw-content' | 'media'

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
   * password from the environment), whatever shape they have. Each occurrence
   * in a string, as written or base64, base64url or URL-encoded, becomes
   * `[REDACTED:known-secret]` and the text around it is kept. A key that
   * contains one, and a whole-string base64 payload that holds one at any byte
   * offset, is replaced whole.
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
