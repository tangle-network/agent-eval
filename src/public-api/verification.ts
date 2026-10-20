// ── verification ──────────────────────────────────────────────────────
// Grading and gating: judges, completion verifiers,
// promotion/release gates, and capture-integrity checks.

export type { ActionExecutionPolicy, ActionPolicyDecision } from '../action-policy'
export { evaluateActionPolicy } from '../action-policy'

export type {
  AttestationProvenance,
  AttestationVerification,
  AttestedReport,
} from '../attestation'
export { ATTESTATION_ALGORITHM, attest, verifyAttestation } from '../attestation'

export type {
  CanaryAlert,
  CanaryEvaluation,
  CanaryKind,
  CanaryOptions,
  CanaryReport,
} from '../canary'
export { runCanaries } from '../canary'

export type {
  CompletionRequirement,
  CompletionVerdict,
  CorrectnessChecker,
  LlmCorrectnessCheckerOpts,
  ProducedProposal,
  ProducedState,
  RequirementCheck,
  SatisfiedBy,
  TaskGold,
} from '../completion-verifier'
export {
  completionVerdict,
  createLlmCorrectnessChecker,
  verifyCompletion,
} from '../completion-verifier'

export type { CanaryLeak } from '../contamination-guard'
export { checkCanaries } from '../contamination-guard'

export type {
  DeployGateLayerInput,
  DeployRunner,
  DeployRunResult,
  ViteDeployRunnerInput,
  WranglerDeployRunnerInput,
} from '../deploy-gate-layer'
export { deployGateLayer, viteDeployRunner, wranglerDeployRunner } from '../deploy-gate-layer'

export type {
  GateDecision as HeldOutGateDecision,
  GateEvidence,
  HeldOutGateConfig,
  HeldOutGateRejectionCode,
  SplitCoverage,
} from '../held-out-gate'
export { HeldOutGate } from '../held-out-gate'

export type {
  BlendWeights,
  FieldDestination,
  HiddenCriteriaGrader,
  HiddenGradeResult,
  HiddenLeak,
  JudgeScoreInput,
  NoLeakOptions,
  RoutedField,
} from '../hidden-criteria-grading'
export {
  assertNoHiddenLeak,
  blendHeldout,
  defaultBlendWeights,
  gradeOnHidden,
  hiddenGrade,
  routeFields,
  withHeldoutBlend,
} from '../hidden-criteria-grading'

export type { BackendIntegrityReport } from '../integrity/backend-integrity'
export {
  assertRealBackend,
  BackendIntegrityError,
  summarizeBackendIntegrity,
} from '../integrity/backend-integrity'

// The model-substitution guard. A harness that owns its own conversation loop
// needs the same check the packaged drivers make: hold the transport to the
// model id it was asked for, so a turn written by a substitute model is not
// scored as the requested model's behaviour.
export type {
  AssertCrossFamilyServedOptions,
  AssertServedModelOptions,
  ServedModelCheck,
  ServedModelPolicy,
  ServedModelVerdict,
} from '../integrity/served-model'
export {
  assertCrossFamilyServed,
  assertServedModel,
  assertServedModels,
  checkServedModel,
  ModelSubstitutionError,
  ServedCrossFamilyError,
  servedModelAcceptable,
} from '../integrity/served-model'

export type {
  AssertSingleBackendOptions,
  BackendDescriptor,
  SingleBackendDivergence,
  SingleBackendReport,
} from '../integrity/single-backend'
export { assertSingleBackend } from '../integrity/single-backend'

export type { IntentMatchInput, IntentMatchOptions, IntentMatchResult } from '../intent-match-judge'
export { runIntentMatchJudge } from '../intent-match-judge'

export type {
  CalibrationResult,
  CandidateScore,
  ContinuousAgreement,
  ContinuousAgreementOptions,
  ContinuousCalibrationResult,
  GoldenItem,
  VerbosityBiasResult,
} from '../judge-calibration'
export {
  calibrateJudge,
  calibrateJudgeContinuous,
  continuousAgreement,
  verbosityBias,
} from '../judge-calibration'
export type { EnsembleAggregate, JudgeVerdict } from '../judge-ensemble'
export { aggregateJudgeVerdicts } from '../judge-ensemble'
export type { AssertCrossFamilyOptions, JudgeFamily } from '../judge-families'
export { assertCrossFamily, CrossFamilyError, judgeFamily } from '../judge-families'
export type { EnsembleJudgeOptions } from '../judge-panel'
export { ensembleJudge } from '../judge-panel'
export type { JudgeRetryOutcome, JudgeRetryPolicy } from '../judge-retry'
export { withJudgeRetry } from '../judge-retry'
export type {
  KeywordConceptSpec,
  KeywordCoverageFinding,
  KeywordCoverageOptions,
  KeywordCoverageResult,
} from '../keyword-coverage-judge'
export { runKeywordCoverageJudge, runKeywordCoverageJudgeUrl } from '../keyword-coverage-judge'
export type { LlmJudgeOptions } from '../llm-judge'
export { llmJudge } from '../llm-judge'
export type {
  CalibrationExample,
  CalibrationMerge,
  JudgeAgreement,
  JudgeCalibrationSet,
  JudgeConfusion,
  JudgeExampleAgreement,
  JudgeGateDecision,
  JudgeGateInput,
  JudgeGatePolicy,
  JudgeGateStatus,
  JudgeRun,
  JudgeRunMeta,
  OwnerVerdict,
} from '../meta-eval/judge-gate'
export {
  addCalibrationVerdicts,
  assertJudgeMayGate,
  DEFAULT_JUDGE_GATE_POLICY,
  JudgeGateRefusedError,
  judgeGateDecision,
  measureJudgeAgreement,
  registerCalibrationSet,
  snapshotFromJudgeAgreement,
} from '../meta-eval/judge-gate'

export type {
  Layer,
  LayerResult,
  LayerStatus,
  Severity,
  VerificationReport,
  VerifyOptions,
} from '../multi-layer-verifier'
export { gradeSemanticStatus, MultiLayerVerifier } from '../multi-layer-verifier'

export type { Oracle, OracleObservation, OracleReport, OracleResult } from '../oracle'
export {
  evaluateOracles,
  jsonShape,
  notBlocked,
  regexMatches,
  textInSnapshot,
  urlContains,
} from '../oracle'

export type {
  PairedDecisionMethod,
  PairedDecisionShape,
  PairedDecisionStatistic,
  PairedMcNemarEvidence,
  PairedPromotionDecision,
  PairedPromotionDecisionOptions,
} from '../paired-promotion-decision'
export { decidePairedPromotion } from '../paired-promotion-decision'
export type {
  PairedPromotionAlternative,
  PairedPromotionAlternativeCell,
  PairedPromotionCallRates,
  PairedPromotionPowerCall,
  PairedPromotionPowerOptions,
  PairedPromotionPowerResult,
  PairedValueLaw,
  RequiredPairsForPairedPromotionOptions,
  RequiredPairsForPairedPromotionResult,
} from '../paired-promotion-power'
export { pairedPromotionPower, requiredPairsForPairedPromotion } from '../paired-promotion-power'

export type {
  ArtifactEventLike,
  ProposalEventLike,
  RuntimeEventLike,
  ToolCallEventLike,
} from '../produced-state'
export { extractProducedState } from '../produced-state'

export type { BootstrapOptions, BootstrapResult, Verdict } from '../promotion-gate'
export { bootstrapCi } from '../promotion-gate'

export type { RedTeamCase, RedTeamCategory, RedTeamFinding, RedTeamReport } from '../red-team'
export {
  DEFAULT_RED_TEAM_CORPUS,
  redTeamDataset,
  redTeamReport,
  scoreRedTeamOutput,
} from '../red-team'

export type {
  ReleaseConfidenceInput,
  ReleaseConfidenceIssue,
  ReleaseConfidenceMetrics,
  ReleaseConfidenceScorecard,
  ReleaseTraceEvidence,
} from '../release-confidence'
export { evaluateReleaseConfidence } from '../release-confidence'

export type {
  ConceptFinding,
  ConceptSpec,
  SemanticConceptJudgeInput,
  SemanticConceptJudgeOptions,
  SemanticConceptJudgeResult,
} from '../semantic-concept-judge'
export { runSemanticConceptJudge, SEMANTIC_CONCEPT_JUDGE_VERSION } from '../semantic-concept-judge'

export type { TreatmentGate, TreatmentGateInput, TreatmentGateOptions } from '../treatment-gate'
export { gateTreatmentApplied } from '../treatment-gate'

export type { VerdictCacheStore } from '../verdict-cache'
export { canonicalJson, contentHash, fileVerdictCache } from '../verdict-cache'
