/**
 * Search lenses (search-tree-design §12): pure functions of `SearchState`.
 * Each returns JSON for a view and one named signal a `SearchPolicy` or an
 * allocator can read. No lens renders anything or reads a record type beyond
 * `SearchStateView`. `agent-eval search show` prints each lens's text form.
 *
 * `editCredit` (signal `reusableHunks`); `landscape` (signal `plateau`, which
 * `draftOnPlateau` reads); `metaSearch` (signal: the best policy
 * configuration); `skillManifold` (signal `nextUnit`, which
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
