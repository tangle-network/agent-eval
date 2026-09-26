/**
 * `@tangle-network/agent-eval/search`: what a search's ledger shows beyond its
 * summary, and searches whose cells are searches. The ledger, kernel and
 * statistics stay in `./campaign`.
 */

export {
  type BestPolicyConfiguration,
  META_SEARCH_SCORE_SOURCE,
  META_SEARCH_SIGNAL,
  type MetaSearchConfiguration,
  type MetaSearchConfigurationEstimate,
  type MetaSearchData,
  type MetaSearchEntry,
  type MetaSearchLiftPerUsd,
  type MetaSearchOptions,
  type MetaSearchParent,
  type MetaSearchScore,
  type MetaSearchSpend,
  type MetaSearchTextOptions,
  type MetaSearchUnscoredReason,
  metaSearch,
  metaSearchScore,
  objectiveKey,
  renderMetaSearchText,
  type SearchPolicyGenome,
  searchPolicyGenome,
} from './lenses/meta-search'
export {
  type LensResult,
  type LensSignal,
  rankingSplit,
  type SampleSummary,
  summarizeSamples,
} from './lenses/shared'
export {
  type NestedSearchContainment,
  type NestedSearchRunInput,
  nestedSearchId,
  type RunNestedSearchOptions,
  runNestedSearch,
  searchConfigCodec,
} from './nested-search'
