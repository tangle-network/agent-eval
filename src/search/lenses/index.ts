/**
 * Search lenses (search-tree-design §12): pure functions of `SearchState`.
 * Each returns JSON for a view and exactly one named signal a `SearchPolicy`
 * can read. No lens renders anything and none reads a record type beyond
 * `SearchState`/`SearchStateView`. `agent-eval search show` prints each
 * lens's text form (see `../../search-command.ts`); Intelligence, discovery
 * lab, VerticalBench and agent-runtime `improve()` read the same JSON with no
 * extra code.
 *
 * This module carries the `basic` group: `tree`, `operatorYield`, `front`,
 * `taskMatrix`. `metaSearch`, `editCredit`, `landscape` and `skillManifold`
 * are built in sibling groups against the same contract.
 */

export type { FrontData, FrontExtraAxis, FrontOptions, FrontRow, FrontSignal } from './front'
export { front } from './front'

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
