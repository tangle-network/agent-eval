/**
 * Canonical FNV-1a (32-bit) string hash. A leaf module (imports nothing) so any
 * file can use it without an import cycle. One copy so content-addressing and
 * stable seeding cannot drift between call sites.
 */

/** FNV-1a 32-bit hash of a string → unsigned 32-bit number. */
export function fnv1a32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** FNV-1a 32-bit hash as a zero-padded 8-char hex string. */
export function fnv1aHex(s: string): string {
  return fnv1a32(s).toString(16).padStart(8, '0')
}
