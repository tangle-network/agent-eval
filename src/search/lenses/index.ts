/**
 * Search lenses: pure projections of a `SearchStateView`, each returning JSON
 * for a view and one named signal a `SearchPolicy` can read.
 */

export {
  EDIT_CREDIT_SIGNAL,
  type EditCreditData,
  type EditCreditOptions,
  type EditCreditResult,
  type EditGene,
  type EditGeneVerdict,
  type EditInteraction,
  type EditLineageRow,
  type EditSkillCandidate,
  editCredit,
  editCreditText,
} from './edit-credit'
export type { SearchLensResult, SearchLensSignal } from './types'
