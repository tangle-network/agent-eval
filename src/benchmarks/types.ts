/**
 * Shared types for the reference benchmark wrappers under
 * `src/benchmarks/`. Each wrapper exports the three functions in
 * `BenchmarkAdapter` plus its own typed `DatasetItem` shape.
 */

import type { RunSplitTag } from '../run-record'

export interface BenchmarkDatasetItem<TPayload = unknown> {
  /** Stable dataset-local item id (used for split assignment + paper
   *  references). Unique within a benchmark. */
  id: string
  /** Free-form payload. Each benchmark defines its own shape. */
  payload: TPayload
}

export interface BenchmarkEvaluation {
  /** [0, 1] score for the response on this item. Exact-match
   *  benchmarks use 0/1; partial-credit benchmarks may return
   *  fractional values. */
  score: number
  /** Optional bag of raw scoring signals — e.g. parsed numeric
   *  answer, regex match, judge sub-scores. */
  raw: Record<string, unknown>
}

/** Common signature implemented by every adapter under `src/benchmarks/*`. */
// `TPayload` is the per-item payload type; `_TItem` is preserved for
// downstream type-narrowing extensions (a richer `BenchmarkDatasetItem`
// subclass that adds e.g. provenance metadata) but is intentionally
// unused here. `noUnusedLocals` requires the leading underscore.
export interface BenchmarkAdapter<_TItem = unknown, TPayload = unknown> {
  /** Load the dataset for the given split. May hit the network on
   *  first call but should be cache-friendly. Adapters that don't
   *  ship the dataset itself MUST throw a clearly-marked error
   *  pointing the caller at the loader script. */
  loadDataset(split: RunSplitTag): Promise<BenchmarkDatasetItem<TPayload>[]>
  /** Score a single response. Pure with respect to the inputs. */
  evaluate(item: BenchmarkDatasetItem<TPayload>, response: string): Promise<BenchmarkEvaluation>
  /** Deterministic split assignment via item id hashing. The
   *  fraction of items in each split is implementation-defined but
   *  MUST be stable across processes and platforms. */
  assignSplit(itemId: string): RunSplitTag
}

// ── Deterministic split assignment ───────────────────────────────────

/**
 * 32-bit FNV-1a hash. Stable, allocation-free, deterministic across
 * runtimes. We use it to assign items to splits rather than depending
 * on a polyfilled crypto.subtle path.
 */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i) & 0xff
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

/** Split-assignment seed shared across all benchmarks. Bumping this
 *  value reshuffles every split — do NOT do that lightly. */
export const BENCHMARK_SPLIT_SEED = 'agent-eval-v1'

/**
 * Assign an item id to one of `'search' | 'dev' | 'holdout'` using a
 * stable 32-bit hash of `${seed}::${id}`. Default proportions:
 *
 *   search: 60%   (optimization-readable)
 *   dev:    20%   (held-out for tuning, leak-on-purpose during dev)
 *   holdout:20%   (paper-grade held-out, gated reads)
 */
export function deterministicSplit(
  itemId: string,
  seed: string = BENCHMARK_SPLIT_SEED,
): RunSplitTag {
  const h = fnv1a32(`${seed}::${itemId}`)
  const pos = h / 0x100000000
  if (pos < 0.6) return 'search'
  if (pos < 0.8) return 'dev'
  return 'holdout'
}
