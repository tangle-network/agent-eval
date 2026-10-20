import { classifyKey } from './keys'
import { credentialIn, detectPersonalData } from './values'

// The whole string must be the data URI — `$` at the end, not just a `^`
// prefix check. A prefix-only check let `data:text/plain;base64,…\n` PLUS
// arbitrary trailing text through as unread "media", when the trailing text
// (or, for text/json mimes, the payload itself once decoded) is exactly the
// kind of prose a credential or personal-data detector should see.
const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+-]+=[\w.+-]+)*;base64,([A-Za-z0-9+/=\s]*)$/i

/** A data: URI's mime type and base64 payload, only when the whole string is the URI. */
export function matchDataUri(text: string): { mime: string; payload: string } | undefined {
  const m = DATA_URI.exec(text)
  if (!m) return undefined
  return { mime: (m[1] ?? '').toLowerCase(), payload: m[2] ?? '' }
}

/** Decodes a data: URI's base64 payload to text, or undefined if it is not valid base64. */
export function decodeDataUriPayload(payload: string): string | undefined {
  const cleaned = payload.replace(/\s+/g, '')
  if (cleaned.length === 0) return ''
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) return undefined
  try {
    return Buffer.from(cleaned, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

export const READABLE_IMAGE_MIME = /^image\//

/** Mimes whose payload is text a detector can read once decoded. */
export const DECODABLE_TEXT_MIME = /^text\/|^application\/json$/

/** Whether a decoded data: URI payload holds a credential or personal data,
 *  by key name (for application/json) or by value shape (for any text). */
export function decodedPayloadIsUnsafe(
  decoded: string,
  mime: string,
  knownSecrets: readonly string[],
): boolean {
  if (mime === 'application/json') {
    try {
      return jsonValueIsUnsafe(JSON.parse(decoded), knownSecrets)
    } catch {
      // Not actually valid JSON despite the mime type — fall through to plain text.
    }
  }
  if (credentialIn(decoded, knownSecrets)) return true
  return detectPersonalData(decoded).length > 0
}

function jsonValueIsUnsafe(value: unknown, knownSecrets: readonly string[]): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string')
    return credentialIn(value, knownSecrets) !== undefined || detectPersonalData(value).length > 0
  if (typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => jsonValueIsUnsafe(item, knownSecrets))
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const category = classifyKey(key)
    if (category === 'credential') return true
    if (category === 'personal-data' && (typeof item === 'string' || typeof item === 'number'))
      return true
    if (jsonValueIsUnsafe(item, knownSecrets)) return true
  }
  return false
}
