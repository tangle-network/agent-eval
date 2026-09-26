/**
 * Search lenses (search-tree-design §12): pure functions of `SearchState`.
 * Each returns JSON for a view and exactly one named signal a `SearchPolicy`
 * can read. No lens renders anything and none reads a record type beyond
 * `SearchState`/`SearchStateView`. `agent-eval search show` prints each
 * lens's text form (see `../../search-command.ts`); Intelligence, discovery
 * lab, VerticalBench and agent-runtime `improve()` read the same JSON with no
 * extra code.
 *
 * This module carries lenses from every group: `tree`, `operatorYield`,
 * `front`, `taskMatrix` (basic), `editCredit` (credit) and `metaSearch`
 * (meta), against the same contract. `landscape` and `skillManifold` land
 * from their own sibling group.
 */

export {
  EDIT_CREDIT_ESTIMATOR,
  EDIT_CREDIT_SIGNAL,
  type EditCreditData,
  type EditCreditOptions,
  type EditCreditResult,
  type EditCreditSignal,
  type EditGene,
  type EditGeneVerdict,
  type EditInteraction,
  type EditIntroduction,
  type EditLineageRow,
  type EditSkillCandidate,
  editCredit,
  editCreditText,
} from './edit-credit'
export type { FrontData, FrontExtraAxis, FrontOptions, FrontRow, FrontSignal } from './front'
export { front } from './front'

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
} from './meta-search'

export type {
  ExpansionOperator,
  OperatorOutcomeCounts,
  OperatorYieldData,
  OperatorYieldOptions,
  OperatorYieldRow,
  OperatorYieldSignal,
} from './operator-yield'
export { EXPANSION_OPERATORS, MIN_OUTCOMES_FOR_WEIGHT, operatorYield } from './operator-yield'
export type { LensResult, LensSignal, SampleSummary } from './shared'
export { rankingSplit, summarizeSamples } from './shared'

export type {
  TaskMatrixCell,
  TaskMatrixCluster,
  TaskMatrixData,
  TaskMatrixOptions,
  TaskMatrixSignal,
  TaskMatrixSpecialistRow,
} from './task-matrix'
export { taskMatrix } from './task-matrix'

export type { TreeData, TreeNode } from './tree'
export { tree } from './tree'
