/**
 * The procedure registry: versions of skills and workflows keyed by digest,
 * with their lineage, executions, outcomes and decisions, projected from search
 * ledgers and recorded sessions. See `buildProcedureRegistry`.
 */

export type {
  ChangeOutcome,
  ChangeOutcomeIndex,
  ChangeOutcomeReading,
  InvocationChanges,
  SessionChanges,
} from './change-outcome'
export { HOTFIX_WINDOW_DAYS, indexChangeOutcomes, joinInvocationToChanges } from './change-outcome'
export type { ProcedureRegistryCommandIo } from './command'
export { runProcedureRegistryCommand } from './command'
export type {
  CellExecution,
  ChangeCounts,
  ChangeJoinSummary,
  ExecutionMeasures,
  MeasureTotal,
  ProcedureChanges,
  ProcedureDecision,
  ProcedureEdge,
  ProcedureExecution,
  ProcedureKind,
  ProcedureNodeIdentity,
  ProcedureRegistry,
  ProcedureRegistryInput,
  ProcedureRegistryOptions,
  ProcedureVersion,
  SearchAppearance,
  SessionExecution,
} from './registry'
export { buildProcedureRegistry } from './registry'
export { renderProcedureRegistryTable } from './render'
