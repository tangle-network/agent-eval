/**
 * Deterministic held-out partitioning over stable ids.
 *
 * A promotion gate's paired-delta math needs a fixed partition: the same
 * scenario id lands in the same bucket forever, regardless of when it ran or
 * which loop emitted the record — otherwise the gate has nothing paired to
 * compare against. Picking one global split per run is wrong: every run then
 * stamps either ALL search or ALL holdout, and no id is ever observed on both
 * sides. Per-id deterministic hashing fixes that.
 *
 * Two consumers hand-roll this (agent-builder's `deterministicSplit` and the
 * frontier persona-splitter). The substrate already has a 3-way benchmark
 * `deterministicSplit` in `./benchmarks`; this is the generic, validated batch
 * partitioner: it takes a list of ids, splits them by a stable FNV-1a hash, and
 * fails loud when the inputs can't support a trustworthy held-out comparison
 * (duplicate ids, or a holdout set below the significance floor).
 */

import { ValidationError } from './errors'

/** 32-bit FNV-1a hash. Stable, allocation-free, deterministic across runtimes —
 *  the same id+seed maps to the same bucket on every machine and process. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Map an id+seed to the half-open unit interval [0, 1) deterministically. */
export function hashToUnit(id: string, seed: string): number {
  // Newline separator: 'ab' + '\n' + 'c' can't collide with 'a' + '\n' + 'bc'.
  return fnv1a32(`${id}\n${seed}`) / 0x1_0000_0000
}

export interface PartitionHeldOutOptions {
  /** Partition seed. Bumping it reshuffles every assignment — do that only when
   *  the corpus/policy changes meaningfully so old and new records can't pair.
   *  Default 'held-out-v1'. */
  seed?: string
  /** Fraction routed to the held-out bucket, in (0, 1). Default 0.5. */
  holdoutFraction?: number
  /**
   * Minimum held-out ids required for the split to be admissible. Below this,
   * a paired comparison has too few observations to be significant, so the
   * partition throws rather than hand back an underpowered holdout. Default 1
   * (only the empty-holdout degenerate case is rejected). Raise it to enforce
   * real statistical power. */
  minHoldout?: number
  /** Same floor for the search side. Default 1. */
  minSearch?: number
}

export interface HeldOutPartition {
  /** Ids the optimizer is allowed to read/optimize against. */
  search: string[]
  /** Ids reserved for gated, held-out evaluation. */
  holdout: string[]
  seed: string
  holdoutFraction: number
}

/**
 * Assign a single id to `'search'` or `'holdout'` deterministically. Same
 * `(id, seed)` always returns the same tag — the invariant the gate relies on.
 * Use this in a `splitTag:` field literal when stamping records one at a time;
 * use `partitionHeldOut` when you have the whole id list up front and want the
 * validated disjoint split.
 */
export function assignHeldOutTag(
  id: string,
  options: { seed?: string; holdoutFraction?: number } = {},
): 'search' | 'holdout' {
  const seed = options.seed ?? 'held-out-v1'
  const holdoutFraction = options.holdoutFraction ?? 0.5
  assertFraction(holdoutFraction)
  return hashToUnit(id, seed) < holdoutFraction ? 'holdout' : 'search'
}

/**
 * Partition a list of stable ids into disjoint `search` / `holdout` sets by a
 * deterministic hash. Fail-loud:
 *   - empty input throws,
 *   - duplicate ids throw (a dup would be observed on both sides, double-counting),
 *   - a holdout (or search) set below its floor throws (underpowered comparison).
 *
 * Order within each bucket follows the input order, so the result is stable and
 * reproducible.
 */
export function partitionHeldOut(
  ids: string[],
  options: PartitionHeldOutOptions = {},
): HeldOutPartition {
  const seed = options.seed ?? 'held-out-v1'
  const holdoutFraction = options.holdoutFraction ?? 0.5
  const minHoldout = options.minHoldout ?? 1
  const minSearch = options.minSearch ?? 1
  assertFraction(holdoutFraction)
  if (ids.length === 0) {
    throw new ValidationError('partitionHeldOut: no ids supplied')
  }

  const seen = new Set<string>()
  const search: string[] = []
  const holdout: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ValidationError(
        `partitionHeldOut: ids must be non-empty strings, got ${JSON.stringify(id)}`,
      )
    }
    if (seen.has(id)) {
      throw new ValidationError(
        `partitionHeldOut: duplicate id "${id}" — a paired comparison must not double-count`,
      )
    }
    seen.add(id)
    if (hashToUnit(id, seed) < holdoutFraction) holdout.push(id)
    else search.push(id)
  }

  if (holdout.length < minHoldout) {
    throw new ValidationError(
      `partitionHeldOut: holdout set has ${holdout.length} id(s), below the floor of ${minHoldout} ` +
        `(n=${ids.length}, holdoutFraction=${holdoutFraction}) — too few for a significant comparison`,
    )
  }
  if (search.length < minSearch) {
    throw new ValidationError(
      `partitionHeldOut: search set has ${search.length} id(s), below the floor of ${minSearch} ` +
        `(n=${ids.length}, holdoutFraction=${holdoutFraction})`,
    )
  }

  return { search, holdout, seed, holdoutFraction }
}

function assertFraction(f: number): void {
  if (!Number.isFinite(f) || f <= 0 || f >= 1) {
    throw new ValidationError(`partitionHeldOut: holdoutFraction must be in (0, 1), got ${f}`)
  }
}
