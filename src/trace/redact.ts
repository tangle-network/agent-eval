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

import { assessShareSafety } from './redaction/assessment'
import type { RedactionReport, RedactOptions, ShareSafetyVerdict } from './redaction/contract'
import { redact } from './redaction/rewrite'

export { assessShareSafety, combineVerdicts, shareAllowed } from './redaction/assessment'
export type {
  AssessOptions,
  RedactionFinding,
  RedactionProfile,
  RedactionReport,
  RedactOptions,
  SafetyCategory,
  ShareSafetyFinding,
  ShareSafetyStatus,
  ShareSafetyVerdict,
} from './redaction/contract'
export { classifyKey, normalizeKey } from './redaction/keys'
export { REDACTION_PROFILES, REDACTION_VERSION } from './redaction/profiles'
export { emptyRedactionReport, redact, redactText } from './redaction/rewrite'
export { detectCredential, detectPersonalData } from './redaction/values'

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
