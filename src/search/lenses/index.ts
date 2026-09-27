/**
 * Search lenses (search-tree-design §12): pure functions of `SearchState`.
 * Each returns JSON for a view and exactly one named signal a `SearchPolicy`
 * or an allocator can read. No lens renders anything and none reads a record
 * type beyond `SearchState`/`SearchStateView`. `agent-eval search show` prints
 * each lens's text form (see `../../search-command.ts`); Intelligence,
 * discovery lab, VerticalBench and agent-runtime `improve()` read the same
 * JSON with no extra code.
 *
 * Lenses and the signal each exposes: `tree` (none, the base view),
 * `operatorYield` (operator weights, which the operator bandit reads),
 * `front` (front membership), `taskMatrix` (specialist gain per task family),
 * `editCredit` (reusable hunks), `metaSearch` (the best policy
 * configuration), `landscape` (`plateau`, which `draftOnPlateau` reads) and
 * `skillManifold` (`nextUnit`, which
 * `asha({ extend: nextUnitExtension(calibration) })` reads).
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
export type { GeometryLensResult, GeometrySignal } from './geometry'
export { screenedNodes } from './geometry'
export type {
  LandscapeBasin,
  LandscapeData,
  LandscapeEmbedding,
  LandscapeGrid,
  LandscapeNode,
  LandscapeOptions,
} from './landscape'
export {
  formatLandscape,
  landscape,
  lineageEdits,
  lineEditDistance,
  nearestNeighbours,
  profileTextLines,
  surfaceDigestEdits,
  surfaceTextEdits,
  vectorEmbedding,
} from './landscape'
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
export type {
  DraftOnPlateauOptions,
  SearchPlateau,
  SearchPlateauOptions,
  SearchPlateauView,
} from './plateau'
export { draftOnPlateau, searchPlateau } from './plateau'
export type { LensResult, LensSignal, SampleSummary } from './shared'
export { rankingSplit, summarizeSamples } from './shared'
export type {
  SkillCalibration,
  SkillManifoldData,
  SkillManifoldNextUnit,
  SkillManifoldNode,
  SkillManifoldOptions,
  SkillManifoldUnit,
} from './skill-manifold'
export {
  formatSkillManifold,
  nextUnitExtension,
  skillCalibration,
  skillManifold,
} from './skill-manifold'
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
