/**
 * The ONE identifier mint for records this package emits — run ids, span ids,
 * event ids, session ids.
 *
 * `globalThis.crypto.randomUUID` is available on every runtime this package
 * supports (`engines.node >= 20`, and every browser that ships Web Crypto), so
 * there is no weaker time-plus-`Math.random` path to fall back to. A private
 * fallback is how two records end up with ids minted by different rules.
 */
export function newRecordId(): string {
  return globalThis.crypto.randomUUID()
}
