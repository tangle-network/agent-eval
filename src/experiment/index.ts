/**
 * `@tangle-network/agent-eval/experiment` — experiments as sealed objects.
 *
 * The covenant: the registered rule IS the executed rule. Rules are data
 * (a typed AST), sealing hashes the whole tree, and the execution surface
 * takes only sealed rules plus evidence — no parameter for alpha, threshold,
 * metric, or stopping rule. Refusals (inadequate cluster counts, mismatched
 * arm budgets, non-monotone funnels) are verdict objects inside artifacts,
 * never prose beside them.
 *
 * New here: the registered-rule AST and seal (`defineExperiment`,
 * `sealExperiment`, `openSealedExperiment`), cluster-aware power with a
 * refusal (`clusteredPower`), the denominator-chain object (`buildFunnel`),
 * matched-budget verification (`verifyMatchedBudgets`), and content-attested
 * evidence receipts that join Runtime pursuits/runs to independent evaluation.
 * Everything statistical underneath is re-exported from its existing home —
 * this subpath adds registration, refusal, and evidence identity, not estimator forks.
 *
 * Full doctrine: docs/experiment.md.
 */

export {
  type PowerPreflight,
  type PowerPreflightOptions,
  powerPreflight,
} from '../campaign/gates/power-preflight'
export {
  buildEvidenceVector,
  type EvidenceVector,
  type PromotionPolicy,
  paretoPolicy,
  paretoSignificanceGate,
} from '../campaign/gates/promotion-policy'
export {
  type SequentialDecision,
  type SequentialObservation,
  type SequentialPairedGate,
  type SequentialPairedGateOptions,
  sequentialDecide,
  sequentialPairedGate,
} from '../campaign/gates/sequential'
export {
  type HeldoutSignificance,
  type HeldoutSignificanceOptions,
  heldoutSignificance,
  type PairedHoldout,
  pairHoldout,
} from '../campaign/gates/statistical-heldout'
export {
  comparePairedArms,
  type MatchedPair,
  type PairArmsOptions,
  type PairArmsResult,
  type PairedArmRow,
  pairArms,
  pairRunRecords,
} from '../paired-arms'
export { type HypothesisManifest, type HypothesisResult, hashJson, manifestContentDigest, type SignedManifest, type SignedManifestAlgo, signManifest, verifyManifest } from '../pre-registration'
export { type PairedEvalueOptions, type PairedEvalueSequence, type PairedEvalueStep, pairedEvalueSequence, type SequentialCrossingHorizon, type SequentialCrossingHorizonOptions } from '../sequential'
// ── Fold-in: estimators and registration primitives, from their homes ─
export {
  BOOTSTRAP_GATE_MIN_N,
  benjaminiHochberg,
  bonferroni,
  type EProcess,
  type EProcessOptions,
  type EProcessState,
  type EProcessStep,
  eProcess,
  holm,
  mcnemar,
  mcnemarPower,
  mcnemarRequiredN,
  mulberry32,
  type PairedBootstrapOptions,
  type PairedBootstrapResult,
  type ProportionInterval,
  pairedBootstrap,
  pairedMde,
  pairedRiskDifference,
  pairedRiskDifferenceExact,
  pairedRiskDifferenceScore,
  requiredPairedSampleSize,
  requiredSampleSize,
  wilson,
} from '../statistics'
// ── The registered-rule AST and its interpreters ─────────────────────
export { type BudgetRule, type HaltOutcome, type HaltRule, type MatchedBudgetRule, type NLadderProjection, type UniformPassDecision, type UniformPassSchedule } from './ast/budget'
export {
  type Condition,
  type DecisionBranch,
  type DecisionOutcome,
  type DecisionRule,
  type DerivedQuantities,
  evaluateCondition,
  executeDecisionRule,
} from './ast/decision'
export { type Estimand, type EstimandResult, type SetExpr } from './ast/estimand'
export type { EvidenceRecord, JsonValue } from './ast/evidence'
export { type ComputedInterval, computeInterval, type IntervalSpec } from './ast/interval'
export { type Predicate, readField } from './ast/predicate'
export { type ReissuePolicy, type ReissueVerdict } from './ast/reissue'
export { type AdmissionPartition, type AdmissionRule, type AdmissionStage, type SelectionRule } from './ast/selection'
export { evaluatePowerFloorGate, type GateResult, type Obligation, type ValidityGate } from './ast/validity'
// ── Matched-budget refusal ───────────────────────────────────────────
export { type ArmRealizedBudget, assertMatchedBudgets, type MatchedBudgetVerdict, verifyMatchedBudgets } from './budget'
export { type CampaignEvidenceContext, createCampaignEvidenceReceipt } from './campaign-evidence'
export {
  defineEvaluationClaim,
  type EvaluationClaim,
  type EvaluationUnitSummary,
  summarizeEvaluationUnits,
} from './claim'
// ── Define, seal, amend, execute ─────────────────────────────────────
export { type ArmSpec, amendExperiment, defineExperiment, type ExperimentSpec, type GateEvidence, type OutcomeSpec, openSealedExperiment, type RegisteredExperiment, type SealAmendment, type SealedExperiment, type SeedDerivation, sealExperiment, verifySealedExperiment } from './define'
// ── Runtime↔Eval evidence identity ───────────────────────────────────
export { type CreateEvidenceReceiptInput, createEvidenceReceipt, type EvidenceAuthority, type EvidenceAuthorityKind, type EvidenceBinding, type EvidenceReceipt, type EvidenceReceiptVerification, isIndependentEvidence, verifyEvidenceReceipt } from './evidence-receipt'
// ── Evidence registry records (evidence/records/*.json) ──────────────
export { EVIDENCE_STATES, type EvidenceDenominator, type EvidenceRegistryRecord, type EvidenceState, evidenceRegistryRecordSchema } from './evidence-record'
export {
  FinalEvidenceConflictError,
  FinalEvidenceError,
  type FinalEvidenceLedger,
  type FinalEvidenceMeasurement,
  type FinalEvidenceOutcome,
  type FinalEvidenceRecord,
  type FinalEvidenceReservation,
  openFinalEvidenceLedger,
} from './final-evidence'
// ── Denominator chain ────────────────────────────────────────────────
export { type AdmissionExecution, buildFunnel, composeFunnels, type ExperimentFunnel, executeAdmissionRule, type FunnelPartitionCount, type FunnelStageCount, type FunnelStageInput, renderFunnelTable } from './funnel'
// ── Cluster-aware power with refusal ─────────────────────────────────
export { assertDesignAdequate, type ClusteredPowerOptions, type ClusteredPowerPoint, type ClusteredPowerRefusal, type ClusteredPowerResult, clusteredPower, type SignFlipFloor } from './power'
export {
  joinProspectiveCanaryReceipts,
  type ProspectiveCanaryAssignment,
  type ProspectiveCanaryBilling,
  type ProspectiveCanaryExecution,
  type ProspectiveCanaryJoinInput,
  type ProspectiveCanaryOutcome,
} from './prospective-canary-join'
export {
  type CanaryArm,
  type CanaryAssignmentReceipt,
  type CanaryCohortReceipt,
  type CanaryCohortVerifier,
  type CanaryObservation,
  type CanaryRefusal,
  decideRandomizedCanary,
  type RandomizedCanaryDecision,
  type RandomizedCanaryRule,
  randomizedCanaryObservationDigest,
  randomizedCanaryRosterDigest,
  type SealedRandomizedCanaryRule,
  sealRandomizedCanaryRule,
} from './randomized-canary'
