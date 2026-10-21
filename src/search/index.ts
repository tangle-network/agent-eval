/**
 * `@tangle-network/agent-eval/search`: what a search's ledger shows beyond its
 * summary, and searches whose cells are searches. The ledger, kernel and
 * statistics stay in `./campaign`.
 */

export { META_SEARCH_SCORE_SOURCE, MIN_OUTCOMES_FOR_WEIGHT, draftOnPlateau, editCredit, editCreditText, front, landscape, lineageEdits, metaSearch, metaSearchScore, nextUnitExtension, operatorYield, renderMetaSearchText, searchPolicyGenome, skillCalibration, skillManifold, summarizeSamples, surfaceTextEdits, taskMatrix, tree, vectorEmbedding } from './lenses'
export type { BestPolicyConfiguration, DraftOnPlateauOptions, EditCreditData, EditCreditOptions, EditCreditResult, EditCreditSignal, EditGene, EditGeneVerdict, EditInteraction, EditIntroduction, EditLineageRow, EditSkillCandidate, ExpansionOperator, FrontData, FrontExtraAxis, FrontOptions, FrontRow, FrontSignal, GeometryLensResult, GeometrySignal, LandscapeBasin, LandscapeData, LandscapeEmbedding, LandscapeGrid, LandscapeNode, LandscapeOptions, LensResult, LensSignal, MetaSearchConfiguration, MetaSearchConfigurationEstimate, MetaSearchData, MetaSearchEntry, MetaSearchLiftPerUsd, MetaSearchOptions, MetaSearchParent, MetaSearchScore, MetaSearchSpend, MetaSearchTextOptions, MetaSearchUnscoredReason, OperatorOutcomeCounts, OperatorYieldData, OperatorYieldOptions, OperatorYieldRow, OperatorYieldSignal, LensSampleSummary, SearchPlateau, SearchPlateauOptions, SearchPlateauView, SearchPolicyGenome, SkillCalibration, SkillManifoldData, SkillManifoldNextUnit, SkillManifoldNode, SkillManifoldOptions, SkillManifoldUnit, TaskMatrixCell, TaskMatrixCluster, TaskMatrixData, TaskMatrixOptions, TaskMatrixSignal, TaskMatrixSpecialistRow, TreeData, TreeNode } from './lenses'
export {
  type NestedSearchContainment,
  type NestedSearchRunInput,
  nestedSearchId,
  type RunNestedSearchOptions,
  runNestedSearch,
  searchConfigCodec,
} from './nested-search'
