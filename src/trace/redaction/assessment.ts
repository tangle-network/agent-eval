import type {
  AssessOptions,
  RedactionProfile,
  SafetyCategory,
  ShareSafetyFinding,
  ShareSafetyStatus,
  ShareSafetyVerdict,
} from './contract'
import { classifyKey, classifyKeyName } from './keys'
import { isPlaceholder, marker } from './markers'
import {
  DECODABLE_TEXT_MIME,
  decodeDataUriPayload,
  matchDataUri,
  READABLE_IMAGE_MIME,
} from './media'
import { MAX_DEPTH, PROFILE_RULES, type ProfileRules } from './profiles'
import { pointer } from './rewrite'
import { credentialIn, detectPersonalData, knownSecretForms } from './values'

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
  const dataUri = matchDataUri(text)
  if (dataUri) {
    scanDataUri(dataUri, path, state)
    return
  }
  const credential = credentialIn(text, state.knownSecrets)
  if (credential) {
    flag(state, path, 'credential', credential)
    return
  }
  for (const detector of detectPersonalData(text)) flag(state, path, 'personal-data', detector)
}

function scanDataUri(
  dataUri: { mime: string; payload: string },
  path: string,
  state: ScanState,
): void {
  if (READABLE_IMAGE_MIME.test(dataUri.mime)) {
    flag(state, path, 'media', 'media')
    return
  }
  if (DECODABLE_TEXT_MIME.test(dataUri.mime)) {
    const decoded = decodeDataUriPayload(dataUri.payload)
    if (decoded === undefined) {
      state.unreadable.push(`${path || '/'}: data URI payload is not valid base64`)
      return
    }
    if (dataUri.mime === 'application/json') {
      try {
        scan(JSON.parse(decoded), path, 0, state)
        return
      } catch {
        // Not actually valid JSON despite the mime type — fall through to plain text.
      }
    }
    scanString(decoded, path, state)
    return
  }
  // audio/video/octet-stream/etc: bytes no text detector can read. A warning
  // under `default` (matches the existing image rule); under `share` and
  // `strict` — the profiles that actually gate whether something may be sent
  // off the machine — treat it as unreadable so the verdict is UNKNOWN
  // instead of silently allowing it through.
  if (state.profile === 'default') {
    flag(state, path, 'media', 'media')
  } else {
    state.unreadable.push(`${path || '/'}: ${dataUri.mime} data URI cannot be read`)
  }
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
      // A credential or personal-data value used as a key must not reach the
      // finding paths.
      const keyCredential = credentialIn(key, state.knownSecrets)
      const keyPersonalData = keyCredential ? undefined : detectPersonalData(key)[0]
      const keyDetector = keyCredential ?? keyPersonalData
      const segment = keyDetector ? marker(keyDetector) : key
      if (keyCredential) flag(state, pointer(path, segment), 'credential', keyCredential)
      else if (keyPersonalData)
        flag(state, pointer(path, segment), 'personal-data', keyPersonalData)
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
