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
  type Experiment,
  type ExperimentRep,
  type ExperimentStats,
  ExperimentTracker,
  type ExperimentVerdict,
  fileExperimentStore,
  inMemoryExperimentStore,
} from '../experiment-tracker'
export {
  comparePairedArms,
  type MatchedPair,
  type PairArmsOptions,
  type PairArmsResult,
  type PairedArmRow,
  pairArms,
  pairRunRecords,
} from '../paired-arms'
export {
  evaluateHypothesis,
  type HypothesisManifest,
  type HypothesisResult,
  hashJson,
  manifestContentDigest,
  type SignedManifest,
  type SignedManifestAlgo,
  signManifest,
  verifyManifest,
} from '../pre-registration'
export {
  type PairedEvalueOptions,
  type PairedEvalueSequence,
  type PairedEvalueStep,
  pairedEvalueSequence,
  type SequentialCrossingHorizon,
  type SequentialCrossingHorizonOptions,
  sequentialCrossingHorizon,
} from '../sequential'
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
export {
  type AdmissionPartition,
  type AdmissionRule,
  type AdmissionStage,
  type BudgetRule,
  type ComputedInterval,
  type Condition,
  classifyReissue,
  computeEstimand,
  computeInterval,
  type DecisionBranch,
  type DecisionOutcome,
  type DecisionRule,
  type DerivedQuantities,
  type Estimand,
  type EstimandResult,
  type EvidenceRecord,
  evaluateCondition,
  evaluateHaltRule,
  evaluateIdentityGate,
  evaluateOracleDeterminismGate,
  evaluatePopulationReproducibilityGate,
  evaluatePowerFloorGate,
  evaluatePredicate,
  evaluateProvenanceGate,
  executeDecisionRule,
  type GateResult,
  type HaltOutcome,
  type HaltRule,
  type IntervalSpec,
  type JsonValue,
  type MatchedBudgetRule,
  type NLadderProjection,
  type Obligation,
  type Predicate,
  projectNLadderBudget,
  type ReissuePolicy,
  type ReissueVerdict,
  readField,
  runSelectionRule,
  runUniformPassBudget,
  type SelectionRule,
  type SetExpr,
  type UniformPassDecision,
  type UniformPassSchedule,
  type ValidityGate,
} from './ast'
// ── Matched-budget refusal ───────────────────────────────────────────
export {
  type ArmRealizedBudget,
  assertMatchedBudgets,
  MatchedBudgetError,
  type MatchedBudgetVerdict,
  verifyMatchedBudgets,
} from './budget'
// ── Define, seal, amend, execute ─────────────────────────────────────
export {
  type ArmSpec,
  amendExperiment,
  defineExperiment,
  type ExperimentSpec,
  type GateEvidence,
  type OutcomeSpec,
  openSealedExperiment,
  type RegisteredExperiment,
  type SealAmendment,
  type SealedExperiment,
  SealIntegrityError,
  type SeedDerivation,
  sealExperiment,
  verifySealedExperiment,
} from './define'
// ── Runtime↔Eval evidence identity ───────────────────────────────────
export {
  type CreateEvidenceReceiptInput,
  createEvidenceReceipt,
  EVIDENCE_AUTHORITY_KINDS,
  EVIDENCE_RECEIPT_VERSION,
  type EvidenceAuthority,
  type EvidenceAuthorityKind,
  type EvidenceBinding,
  type EvidenceReceipt,
  type EvidenceReceiptVerification,
  INDEPENDENT_EVIDENCE_AUTHORITY_KINDS,
  isIndependentEvidence,
  verifyEvidenceReceipt,
} from './evidence-receipt'
// ── Evidence registry records (evidence/records/*.json) ──────────────
export {
  EVIDENCE_STATES,
  type EvidenceDenominator,
  type EvidenceRegistryRecord,
  type EvidenceState,
  evidenceRegistryRecordSchema,
  parseEvidenceRegistryRecord,
  renderEvidenceIndex,
  validateEvidenceRegistry,
} from './evidence-record'
// ── Denominator chain ────────────────────────────────────────────────
export {
  type AdmissionExecution,
  assertFunnelReconciles,
  buildFunnel,
  composeFunnels,
  type ExperimentFunnel,
  executeAdmissionRule,
  FunnelIntegrityError,
  type FunnelPartitionCount,
  type FunnelStageCount,
  type FunnelStageInput,
  renderFunnelTable,
} from './funnel'
// ── Cluster-aware power with refusal ─────────────────────────────────
export {
  assertDesignAdequate,
  type ClusteredPowerOptions,
  type ClusteredPowerPoint,
  type ClusteredPowerRefusal,
  type ClusteredPowerResult,
  clusteredPower,
  DesignRefusalError,
  type SignFlipFloor,
} from './power'
