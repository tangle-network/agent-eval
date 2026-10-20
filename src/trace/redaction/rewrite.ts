import { createHmac, randomBytes } from 'node:crypto'
import type {
  RedactionFinding,
  RedactionProfile,
  RedactionReport,
  RedactOptions,
  SafetyCategory,
} from './contract'
import { classifyKeyName } from './keys'
import { isPlaceholder, marker } from './markers'
import {
  DECODABLE_TEXT_MIME,
  decodeDataUriPayload,
  decodedPayloadIsUnsafe,
  matchDataUri,
} from './media'
import { MAX_DEPTH, PROFILE_RULES, type ProfileRules, REDACTION_VERSION } from './profiles'
import {
  credentialIn,
  detectPersonalData,
  knownSecretForms,
  PERSONAL_DATA_DETECTORS,
} from './values'

interface WalkState {
  rules: ProfileRules
  maxStringBytes: number
  knownSecrets: string[]
  report: RedactionReport
  /** Created on first use: most calls pseudonymize nothing. */
  pseudonymKey?: Buffer
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

export function pointer(parent: string, key: string | number): string {
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
  // A known secret is an exact value, so it is cut out where it stands and the
  // text around it survives: an error message keeps its diagnosis.
  let output = text
  for (const form of state.knownSecrets) {
    if (!output.includes(form)) continue
    output = output.split(form).join(marker('known-secret'))
    record(state, path, 'credential', 'known-secret', 'redacted')
  }
  const dataUri = matchDataUri(output)
  if (dataUri) {
    if (DECODABLE_TEXT_MIME.test(dataUri.mime)) {
      const decoded = decodeDataUriPayload(dataUri.payload)
      if (decoded === undefined) {
        // Can't verify what an undecodable payload holds — fail closed rather
        // than pass it through as if it were opaque, harmless media.
        record(state, path, 'credential', 'data-uri-payload', 'redacted')
        return marker('data-uri-payload')
      }
      if (decodedPayloadIsUnsafe(decoded, dataUri.mime, state.knownSecrets)) {
        record(state, path, 'credential', 'data-uri-payload', 'redacted')
        return marker('data-uri-payload')
      }
      // Decoded clean: still opaque bytes to a downstream reader once
      // embedded, so it's subject to the ordinary media rule below, same as
      // any other data URI.
    }
    if (!state.rules.redactMedia) return output
    record(state, path, 'media', 'media', 'redacted')
    return marker('media')
  }
  // A value shape, or a whole-string base64 payload that holds a known secret
  // at any byte offset, replaces the whole string. The detectors themselves
  // only ever see a bounded prefix (`boundForScan`): a credential that lives
  // entirely beyond `maxStringBytes` would be truncated out of the output
  // below anyway, so scanning past the bound costs time without changing
  // what can leak. The untouched tail is reattached after the personal-data
  // pass so later truncation still sees (and cuts) the full length.
  const boundLen = Math.min(output.length, state.maxStringBytes)
  let scanTarget = output.slice(0, boundLen)
  const tail = output.slice(boundLen)
  const credential = credentialIn(scanTarget, state.knownSecrets)
  if (credential) {
    record(state, path, 'credential', credential, 'redacted')
    return marker(credential)
  }
  for (const detector of PERSONAL_DATA_DETECTORS) {
    if (detector.requires && !scanTarget.includes(detector.requires)) continue
    scanTarget = scanTarget.replace(detector.pattern, (match) => {
      if (detector.accept && !detector.accept(match)) return match
      record(state, path, 'personal-data', detector.id, 'redacted')
      return marker(detector.id)
    })
  }
  output = scanTarget + tail
  const truncated = truncateUtf8(output, state.maxStringBytes)
  if (truncated === undefined) return output
  record(state, path, 'raw-content', 'size-cap', 'truncated')
  return truncated
}

function pseudonym(value: string | number, state: WalkState): string {
  state.pseudonymKey ??= randomBytes(32)
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
      // A personal-data value used AS a key (an email or card number mapping
      // to something) is just as reachable as one in a value — walk() only
      // ever inspects keys for a credential shape, so `{'alice@x.com': 3}`
      // passed through unchanged with verdict SAFE.
      const keyPersonalData = keyCredential ? undefined : detectPersonalData(key)[0]
      if (keyCredential) {
        renamed += 1
        outKey = `${marker(keyCredential)}#${renamed}`
        record(state, pointer(path, outKey), 'credential', keyCredential, 'redacted')
      } else if (keyPersonalData) {
        renamed += 1
        outKey = `${marker(keyPersonalData)}#${renamed}`
        record(state, pointer(path, outKey), 'personal-data', keyPersonalData, 'redacted')
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
