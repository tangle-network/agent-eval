/**
 * The package-canonical seedable PRNG. A leaf module (imports nothing) so any
 * file — including `statistics.ts` — can use it without an import cycle. One
 * mulberry32 so deterministic resampling cannot drift between call sites.
 */

/** Tiny seedable PRNG (mulberry32) — deterministic, not cryptographic.
 *  `undefined` seed → `Math.random`; seed `0` falls back to a fixed constant. */
export function makeRng(seed: number | undefined): () => number {
  if (seed === undefined) return Math.random
  let s = seed | 0 || 0x9e3779b9
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
