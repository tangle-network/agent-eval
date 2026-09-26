/**
 * `@tangle-network/agent-eval/search`: what a search's ledger shows beyond its
 * summary, and searches whose cells are searches. The ledger, kernel and
 * statistics stay in `./campaign`.
 */

export * from './lenses'
export {
  type NestedSearchContainment,
  type NestedSearchRunInput,
  nestedSearchId,
  type RunNestedSearchOptions,
  runNestedSearch,
  searchConfigCodec,
} from './nested-search'
