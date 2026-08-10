/**
 * TB-Repair: turn an analyst's claim about a recorded failure into an
 * executed repair, and measure what the repair was worth.
 *
 * The analyst sees a blinded trajectory prefix and returns exactly one
 * finding — a step k, what went wrong there, and one action to run instead —
 * or the literal `no-decisive-failure`. Everything else in this module exists
 * to make that answer cost what it should:
 *
 *   admission             four executed checks, none of which reads a finding
 *   action-budget         one action, one payload, at most 4 KB
 *   analyst-response      the answer grammar, including the honest decline
 *   funnel                t0 parsed, t1 reproduced, t2 executes, t3 local
 *                         flip, t4 repair flip — and the credit vector with
 *                         no term for reproduction
 *   grade                 one row, one answer, executed at the named k
 *   delta-repair          paired per row, bootstrapped over rows
 *   test-oracle           the held-out suite, injected from outside the box
 *   degenerate-strategies what would score without repairing, and what stops it
 *
 * Containers, models and suites are injected. This module owns what counts.
 */

export {
  type ActionPayloadKind,
  type BudgetCheck,
  type BudgetMeasurement,
  type BudgetViolation,
  checkInterventionBudget,
  classifyActionPayload,
  type InterventionBudget,
  NO_OP_ACTIONS,
  normalizeActionForComparison,
  SCAFFOLD_INTERVENTION_BUDGET,
  SUBMIT_SENTINEL,
  scanShellAction,
} from './action-budget'
export {
  type AdmissionCriteria,
  type AdmissionEvidence,
  type AdmissionOutcome,
  type AdmissionRejection,
  type AdmittedRow,
  admitRow,
  type ControlArmEvidence,
  type PrefixFidelityEvidence,
  TB_REPAIR_ADMISSION_CRITERIA,
} from './admission'
export {
  type AnalystResponse,
  NO_DECISIVE_FAILURE,
  type ParseAnalystResponseOutcome,
  parseAnalystResponse,
  type RepairDeclined,
  type RepairFinding,
  type RepairIntervention,
  type ResponseParseFailure,
  repairFinding,
} from './analyst-response'
export {
  BLINDED_FIELDS,
  type BlindedStep,
  type BlindedTrajectoryPrefix,
  type BlindTrajectoryOptions,
  blindTrajectory,
} from './blinding'
export {
  DEGENERATE_STRATEGIES,
  type DegenerateDefeatKind,
  type DegenerateStrategy,
  type DegenerateStrategyId,
  degenerateStrategy,
} from './degenerate-strategies'
export {
  type DeltaRepairInterval,
  type DeltaRepairOptions,
  type DeltaRepairReport,
  deltaRepair,
  type RepairThreat,
  type RepairThreatId,
  renderDeltaRepairReport,
} from './delta-repair'
export {
  CREDIT_TERMS,
  countFunnel,
  type InterventionExecution,
  type PrefixReplayEvidence,
  type RepairArmEvidence,
  type RepairCredit,
  type RepairFunnelCounts,
  type RepairGrade,
  type RepairRejection,
  type RepairRolloutEvidence,
  type ReproductionEvidence,
  reachedT0,
  reachedT1,
  reachedT2,
  repairCredit,
  type TestRunEvidence,
} from './funnel'
export {
  type GradeRepairOptions,
  gradeRepairRow,
  RepairArmSymmetryError,
  type RepairRowResult,
} from './grade'
export type {
  InjectedAction,
  RepairArm,
  RepairContinuationOutcome,
  RepairContinuationRequest,
  RepairContinuationRunner,
  RepairExecResult,
  RepairSession,
  RepairSessionFactory,
  RepairSessionRequest,
  TestOracle,
  TestOracleContext,
  TestOracleOutcome,
} from './ports'
export {
  type InjectedTestOracleOptions,
  injectedTestOracle,
  TestOracleError,
  type TestSuiteFile,
  TestSuiteTamperedError,
  testSuiteDigest,
} from './test-oracle'
