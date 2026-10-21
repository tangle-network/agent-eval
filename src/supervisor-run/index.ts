/**
 * Supervisor-run analysis — single-rollout trace analysis, one dimension up.
 *
 * `analyzeSupervisorRun(runDir | reader | sources)` answers the questions a
 * supervision tree raises that a solo transcript cannot: did the brain steer
 * anyone mid-task, how many spawn waves, how concurrent, how much of the wall
 * clock had zero workers running, what did each role cost, what evidence came
 * back, what was accepted. `rollupSupervisorRuns` aggregates across runs
 * without ever turning a missing measurement into a zero — and without the
 * converse either: one record a store marked unknown never deletes the records
 * beside it that were measured.
 *
 * `supervisorRunRolloutLines` emits the tree as `tangle.rollout.v1` rows —
 * the same row type solo rollouts use, joined by `parent_rollout_id`.
 */

export { analyzeSupervisorRunSources } from './analyze'
export { type ClaudeCodeReaderOptions } from './claude-code-reader'
export {
  analyzeSupervisorRunIntegrity,
  SUPERVISOR_RUN_INTEGRITY_SCHEMA,
  type SupervisorRunIntegrityEvidence,
  type SupervisorRunIntegrityIssue,
  type SupervisorRunIntegrityIssueCode,
  type SupervisorRunIntegrityOptions,
  type SupervisorRunIntegrityReport,
  type SupervisorRunIntegritySeverity,
  type SupervisorRunSourceOnlyCheckCode,
} from './integrity'
export { parsePatch } from './patch-stats'
export { analyzeSupervisorRun, findSupervisorRunDirs, type WriteSupervisorRunOptions } from './reader'
export {
  renderSupervisorRollupMarkdown,
  renderSupervisorRunHeadline,
  renderSupervisorRunMarkdown,
} from './render'
export { type SupervisorRunCommandIo, type SupervisorRunReportFormat } from './report-command'
export { type SupervisorRolloutOptions, supervisorRunRolloutLines } from './rollout-nodes'
export { rollupSupervisorRuns } from './rollup'
export { isRuntimeSupervisorRunDir, type RuntimeReaderOptions, readRuntimeSupervisorRun } from './runtime-reader'
export {
  type CloseRow,
  parseSupervisorTree,
  type SpawnRow,
  type SteerAcknowledgementFact,
  type SteerRequestFact,
  type SupervisorJournalDialect,
  type SupervisorTreeFacts,
  type WorkerLogFacts,
} from './source-facts'
export {
  NO_TERMINAL_RECORD,
  RUNTIME_FAILED_STATUS,
  readTerminalRecord,
  type TerminalRecord,
  type TerminalRecordInput,
} from './terminal-record'
export { type DecisionMetrics, type EconomicsMetrics, isUnavailable, type Measured, type NamedResourceReceipt, type OrchestrationMetrics, type OutcomeMetrics, type PatchStats, type PerWorkerRow, type ResourceSpendRecord, type RoleSpend, type RollupCellRow, type SourceLimits, type SpendMeasurement, type SpendMeasurements, type SteerBreakdown, type SupervisorRunNodeRole, type SupervisorRunReader, type SupervisorRunReport, type SupervisorRunRollup, type SupervisorRunSources, type SupervisorRunTree, type SupervisorRunTreeGap, type SupervisorRunTreeGapCode, type SupervisorStatusSource, showMeasured, type TerminalFailure, type Unavailable, unavailable, type WallDistribution, type WorkerLogSource, type WorkerNativeSession, type WorkerTurnCoverage } from './types'
