import { ValidationError } from '../errors'

/** Tiny seedable PRNG (mulberry32) — deterministic resampling/shuffling, not
 *  cryptographic. Exported so e-process shuffles and bootstrap resampling
 *  share ONE PRNG implementation. Every distinct 32-bit seed gives a distinct
 *  stream, including 0. */
export function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) {
    throw new ValidationError(`mulberry32: seed must be a finite number, got ${seed}`)
  }
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
