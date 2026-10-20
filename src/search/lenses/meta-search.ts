/**
 * `metaSearch(searches)`: a search of searches (search-tree-design §12).
 *
 * Every search is one node. Its genome is the configuration that ran it: the
 * expansion policy and allocator its header declares (their names carry
 * their parameters, such as patience, operator weights and rung sizes), its
 * budget, and the proposer its edges and candidate-generation operations
 * name, with the proposer's model. Its score is the held-out lift its claim
 * measured, per known dollar of the whole search.
 *
 * The held-out lift is `estimateNode` of one node against the root on the
 * sealed test split, from the test cells themselves: the shipped node on
 * `ship`; on `hold`, the first finalist not decided invalid, in the claim's
 * order, which the claim fixed from selection data before any test cell ran.
 * A hold's measured lift counts rather than being dropped: keeping only the
 * searches whose test was significant would inflate a configuration's mean.
 * A search whose claim is open, missing, `test-cannot-resolve`, contradicted
 * by its own ledger (`verifySearchClaim`), held with no finalist tested, or
 * whose lift pairs fewer than 2 test units is unscored with its reason, never
 * 0, and every configuration reports how many of its searches were scored.
 *
 * Dollars are the search's committed spend: every cell and operation, the
 * claim's test cells included. An unknown-cost cell or operation leaves only a
 * floor, so that search's lift per dollar is a bound, not a value, and stays
 * out of every estimate. A search that recorded no spend has none either.
 *
 * Searches arrange into a forest by derivation (`derivedFrom`: a search that
 * started from a node of another) and containment (`containment`: a search
 * that ran inside a cell of another). A search contained in an outer search's
 * cell belongs to that cell's node: the outer node is its configuration, and
 * the outer node's lineage is the configuration's lineage.
 *
 * Configurations group searches with one genome and one objective (subject,
 * metric, direction). A configuration's lift per dollar summarizes its scored
 * searches as independent units with `summarizeSamples` (a percentile
 * bootstrap of the mean); a configuration with one scored search carries that
 * search's own paired interval, whose units are its test units. The signal
 * names the configuration with the largest estimate within one objective.
 */

import { verifySearchClaim } from '../../campaign/search-claim'
import type { SearchStateView } from '../../campaign/search-state'
import { compareCodeUnits, hashCanonical } from '../../ledger-core/canonical'
import { best, configure } from './meta-search-configuration'
import type {
  BestPolicyConfiguration,
  MetaSearchData,
  MetaSearchEntry,
  MetaSearchOptions,
  MetaSearchParent,
} from './meta-search-contract'
import { searchPolicyGenome } from './meta-search-genome'
import { scoreSearch } from './meta-search-score'
import type { LensResult } from './shared'

export type {
  BestPolicyConfiguration,
  MetaSearchConfiguration,
  MetaSearchConfigurationEstimate,
  MetaSearchData,
  MetaSearchEntry,
  MetaSearchLiftPerUsd,
  MetaSearchOptions,
  MetaSearchParent,
  MetaSearchScore,
  MetaSearchSpend,
  MetaSearchUnscoredReason,
  SearchPolicyGenome,
} from './meta-search-contract'

export { searchPolicyGenome } from './meta-search-genome'

export {
  META_SEARCH_SCORE_SOURCE,
  metaSearchScore,
} from './meta-search-score'

export {
  type MetaSearchTextOptions,
  renderMetaSearchText,
} from './meta-search-text'

/** The signal's name, as a policy or a view reads it. */
export const META_SEARCH_SIGNAL = 'metaSearch.bestPolicyConfiguration'

const DEFAULT_GLYPH_NODES = 64

/** The lens: every search as a node of a search of searches. */
export function metaSearch(
  searches: readonly SearchStateView[],
  options: MetaSearchOptions = {},
): LensResult<MetaSearchData, BestPolicyConfiguration> {
  const glyphNodes = options.glyphNodes ?? DEFAULT_GLYPH_NODES
  if (!Number.isSafeInteger(glyphNodes) || glyphNodes < 0) {
    throw new TypeError(`metaSearch: glyphNodes must be a non-negative integer, got ${glyphNodes}`)
  }
  const byId = new Map<string, SearchStateView>()
  for (const state of searches) {
    if (!state.header) throw new Error(`metaSearch: search ${state.searchId} has not been opened`)
    if (byId.has(state.searchId)) {
      throw new Error(`metaSearch: search ${state.searchId} was given twice`)
    }
    byId.set(state.searchId, state)
  }

  const entries = searches.map((state) => entry(state, byId, glyphNodes))
  const entryById = new Map(entries.map((item) => [item.searchId, item]))
  for (const item of entries) {
    if (item.parent?.present) entryById.get(item.parent.searchId)!.children.push(item.searchId)
  }
  const roots = entries.filter((item) => !item.parent?.present).map((item) => item.searchId)
  const assignDepth = (searchId: string, depth: number, seen: Set<string>): void => {
    if (seen.has(searchId)) return
    seen.add(searchId)
    const item = entryById.get(searchId)!
    item.depth = depth
    for (const child of item.children) assignDepth(child, depth + 1, seen)
  }
  const seen = new Set<string>()
  for (const root of roots) assignDepth(root, 0, seen)

  const configurations = configure(entries, byId)
  const objectives = [...new Set(entries.map((item) => item.objectiveKey))].sort(compareCodeUnits)
  const { objective, value } = best(configurations, objectives, options.objective)
  return {
    data: { searches: entries, roots, configurations, objectives, signalObjective: objective },
    signal: { name: META_SEARCH_SIGNAL, value },
  }
}

function entry(
  state: SearchStateView,
  byId: ReadonlyMap<string, SearchStateView>,
  glyphNodes: number,
): MetaSearchEntry {
  const header = state.header!
  const genome = searchPolicyGenome(state)
  const closed = state.closed
  let claim: MetaSearchEntry['claim'] = null
  const verification = closed?.claim ? verifySearchClaim(state) : null
  if (closed?.claim) {
    claim = {
      decision: closed.claim.decision,
      selected: closed.claim.selected,
      verification: verification?.status ?? 'unknown',
      reason: closed.claim.reason,
    }
  }
  const nodes = state.nodes()
  const cells = state.cells()
  return {
    searchId: state.searchId,
    subject: header.subject,
    objective: { metric: header.objective.metric, direction: header.objective.direction },
    objectiveKey: objectiveKey(header),
    status: closed ? 'closed' : 'open',
    closeReason: closed?.reason ?? null,
    genome,
    genomeDigest: hashCanonical(genome),
    seed: header.policy.seed,
    rootArtifactDigest: nodes[0]?.artifactDigest ?? null,
    nodes: nodes.length,
    cells: {
      settled: state.audit.cells.settled,
      test: cells.filter((cell) => cell.split === 'test').length,
    },
    claim,
    score: scoreSearch(state, verification),
    parent: parentOf(state, byId),
    children: [],
    depth: 0,
    glyph: {
      nodes: nodes
        .slice(0, glyphNodes)
        .map((node): [string, string | null, string | null] => [
          node.nodeId,
          node.primaryParentId,
          node.status,
        ]),
      omitted: Math.max(0, nodes.length - glyphNodes),
    },
  }
}

/** `subject · metric (direction)`: the key searches are compared within. */
export function objectiveKey(header: NonNullable<SearchStateView['header']>): string {
  return `${header.subject} · ${header.objective.metric} (${header.objective.direction})`
}

function parentOf(
  state: SearchStateView,
  byId: ReadonlyMap<string, SearchStateView>,
): MetaSearchParent | null {
  const header = state.header!
  if (header.containment) {
    const { searchId, cellId, attempt } = header.containment
    const outer = byId.get(searchId)
    return {
      relation: 'contained',
      searchId,
      cellId,
      attempt,
      nodeId: outer?.cell(cellId)?.nodeId ?? null,
      present: outer !== undefined,
    }
  }
  if (header.derivedFrom) {
    const { searchId, nodeId } = header.derivedFrom
    return { relation: 'derived', searchId, nodeId, present: byId.has(searchId) }
  }
  return null
}
