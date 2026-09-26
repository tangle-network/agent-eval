/**
 * Search lenses (search-tree-design §12): pure functions of `SearchState`.
 * Each returns JSON for a view and one named signal a `SearchPolicy` can read.
 * No lens renders anything or reads a record type beyond `SearchStateView`.
 * `agent-eval search show` prints each lens's text form.
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
export type { LensResult, LensSignal, SampleSummary } from './shared'
export { rankingSplit, summarizeSamples } from './shared'
