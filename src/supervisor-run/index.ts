/**
 * Supervisor-run analysis — single-rollout trace analysis, one dimension up.
 *
 * `analyzeSupervisorRun(runDir | reader | sources)` answers the questions a
 * supervision tree raises that a solo transcript cannot: did the brain steer
 * anyone mid-task, how many spawn waves, how concurrent, how much of the wall
 * clock had zero workers running, what did each role cost, what evidence came
 * back, what was accepted. `rollupSupervisorRuns` aggregates across runs
 * without ever turning a missing measurement into a zero.
 *
 * `supervisorRunRolloutLines` emits the tree as `tangle.rollout.v1` rows —
 * the same row type solo rollouts use, joined by `parent_rollout_id`.
 */

export {
  analyzeSupervisorRunSources,
  type CloseRow,
  parsePatch,
  parseSupervisorTree,
  rollupSupervisorRuns,
  type SpawnRow,
  type SupervisorTreeFacts,
  type WorkerLogFacts,
} from './analyze'
export {
  analyzeSupervisorRun,
  findSupervisorRunDirIn,
  findSupervisorRunDirs,
  type LoopsReaderOptions,
  loopsSupervisorRunReader,
  readLoopsSupervisorRun,
  reportSupervisorRound,
  supervisorReportStem,
  type WriteSupervisorRunOptions,
  writeSupervisorRunReport,
  writeSupervisorRunReportSafe,
} from './loops-reader'
export {
  renderSupervisorRollupMarkdown,
  renderSupervisorRunHeadline,
  renderSupervisorRunMarkdown,
} from './render'
export { type SupervisorRolloutOptions, supervisorRunRolloutLines } from './rollout-nodes'
export {
  type DecisionMetrics,
  type EconomicsMetrics,
  isUnavailable,
  type Measured,
  type OrchestrationMetrics,
  type OutcomeMetrics,
  type PatchStats,
  type PerWorkerRow,
  type RoleSpend,
  type RollupCellRow,
  type SteerBreakdown,
  SUPERVISOR_RUN_ROLLUP_SCHEMA,
  SUPERVISOR_RUN_SCHEMA,
  type SupervisorRunReader,
  type SupervisorRunReport,
  type SupervisorRunRollup,
  type SupervisorRunSources,
  type SupervisorRunTree,
  showMeasured,
  type Unavailable,
  unavailable,
  type WallDistribution,
  type WorkerLogSource,
} from './types'
