/**
 * The registered-rule AST: every rule an experiment registers is DATA.
 *
 * A closure cannot be canonicalized or hashed; a node tree can. `sealExperiment`
 * hashes the whole tree, and every interpreter in this file takes only a node
 * plus evidence records — no parameter for alpha, threshold, metric, or
 * stopping rule exists on any executable surface. The registered object and
 * the executed object are therefore the same object, and registered-vs-ran
 * drift is unrepresentable rather than checked.
 *
 * Node families:
 *   Predicate       closed-key comparisons — the only leaf
 *   AdmissionRule   monotone funnel stages with registered waivers
 *   SelectionRule   deterministic subsets over a closed field set
 *   Estimand        what the experiment measures
 *   IntervalSpec    how uncertainty is computed, seed included
 *   Condition       decision guards over named derived quantities
 *   DecisionRule    ordered verdict table, or a registered absence of one
 *   Obligation      a control that must exist before a verdict class is read
 *   ValidityGate    pre-spend design checks
 *   HaltRule        gates as prerequisites — failure refuses the spend
 *   BudgetRule      spend schedules with a named ledger
 *   MatchedBudgetRule  arm budget matching as a refusal
 *   ReissuePolicy   carrier faults are reissued; model outcomes stand
 */

export {
  type BudgetRule,
  evaluateHaltRule,
  type HaltOutcome,
  type HaltRule,
  type MatchedBudgetRule,
  type NLadderProjection,
  projectNLadderBudget,
  runUniformPassBudget,
  type UniformPassDecision,
  type UniformPassSchedule,
} from './ast/budget'
export {
  type Condition,
  type DecisionBranch,
  type DecisionOutcome,
  type DecisionRule,
  type DerivedQuantities,
  evaluateCondition,
  executeDecisionRule,
} from './ast/decision'
export { computeEstimand, type Estimand, type EstimandResult, type SetExpr } from './ast/estimand'
export type { EvidenceRecord, JsonValue } from './ast/evidence'
export {
  type ComputedInterval,
  computeInterval,
  type IntervalSpec,
  intervalSpecProblems,
} from './ast/interval'
export { evaluatePredicate, type Predicate, readField } from './ast/predicate'
export { classifyReissue, type ReissuePolicy, type ReissueVerdict } from './ast/reissue'
export {
  type AdmissionPartition,
  type AdmissionRule,
  type AdmissionStage,
  runSelectionRule,
  type SelectionRule,
} from './ast/selection'
export {
  evaluateIdentityGate,
  evaluateOracleDeterminismGate,
  evaluatePopulationReproducibilityGate,
  evaluatePowerFloorGate,
  evaluateProvenanceGate,
  type GateResult,
  type Obligation,
  powerFloorProblems,
  type ValidityGate,
} from './ast/validity'
