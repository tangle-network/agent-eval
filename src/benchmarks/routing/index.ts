/**
 * Routing benchmark — synthetic, dependency-free, ships in the
 * package. 16 cross-category items in `dataset.ts`. See
 * `routing/README.md` for the format.
 *
 * `evaluate` does case-insensitive exact match against the canonical
 * route plus declared synonyms. The first valid route token in the
 * response wins; everything else is ignored. Wrong answers also
 * report whether they hit a hard negative — useful when triaging
 * "always picks the popular route" failure modes.
 */

import type { RunSplitTag } from '../../run-record'
import type { BenchmarkAdapter, BenchmarkDatasetItem, BenchmarkEvaluation } from '../types'
import { deterministicSplit } from '../types'
import { ROUTING_DATASET, type RoutingItem } from './dataset'

export type { RoutingItem }
export type RoutingPayload = RoutingItem
export type RoutingDatasetItem = BenchmarkDatasetItem<RoutingPayload>

class RoutingAdapter implements BenchmarkAdapter<RoutingDatasetItem, RoutingPayload> {
  async loadDataset(split: RunSplitTag): Promise<RoutingDatasetItem[]> {
    return ROUTING_DATASET.map((item) => ({ id: item.id, payload: item })).filter(
      (it) => assignSplitImpl(it.id) === split,
    )
  }

  async evaluate(item: RoutingDatasetItem, response: string): Promise<BenchmarkEvaluation> {
    const tokens = extractRouteTokens(response)
    const correct = new Set<string>(
      [item.payload.route, ...item.payload.synonyms].map((s) => s.toLowerCase()),
    )
    const hardNeg = new Set<string>(item.payload.hardNegatives.map((s) => s.toLowerCase()))
    const firstMatch = tokens.find((t) => correct.has(t.toLowerCase())) ?? null
    const firstHardNeg = tokens.find((t) => hardNeg.has(t.toLowerCase())) ?? null
    const score = firstMatch ? 1 : 0
    return {
      score,
      raw: {
        firstToken: tokens[0] ?? null,
        matchedRoute: firstMatch,
        hitHardNegative: Boolean(firstHardNeg),
        hardNegativeRoute: firstHardNeg,
        category: item.payload.category,
      },
    }
  }

  assignSplit(itemId: string): RunSplitTag {
    return assignSplitImpl(itemId)
  }
}

function assignSplitImpl(itemId: string): RunSplitTag {
  return deterministicSplit(`routing::${itemId}`)
}

/**
 * Pull route-shaped tokens out of a model response. Routes look like
 * `category.action` (`fs.write`, `chat.reply`). Bare alphanumerics
 * are not routes, but `category.action` patterns are robust to most
 * model wrappers (JSON output, prose explanations, code fences).
 */
export function extractRouteTokens(response: string): string[] {
  const matches = response.match(/[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*/gi)
  return matches ?? []
}

const adapter = new RoutingAdapter()

export const loadDataset = adapter.loadDataset.bind(adapter)
export const evaluate = adapter.evaluate.bind(adapter)
export const assignSplit = adapter.assignSplit.bind(adapter)
export { ROUTING_DATASET, RoutingAdapter }
