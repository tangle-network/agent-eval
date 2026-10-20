/**
 * @packageDocumentation
 *
 * Common entry points and their public types.
 * Scenario, JudgeScore, and GateDecision match the /contract campaign types.
 * Specialist APIs live under /experiment, /meta-eval, /analyst, /traces,
 * /reporting, /rl, and the other package exports.
 */

// Type-only groups do not participate in runtime module initialization.
// Keep value re-exports below in their original dependency order.

export { evaluateActionPolicy } from './action-policy'
export { proposeSynthesisTargets } from './active-learning'
export {
  agentProfileHash,
  agentProfileId,
  CODING_HARNESSES,
  expandProfileAxes,
  HARNESS_NATIVE_MODEL,
  harnessAxisOf,
} from './agent-profile'
export {
  AGENT_PROFILE_KINDS,
  agentProfileCellKey,
  buildAgentProfileCell,
  groupRunsByAgentProfileCell,
  toAgentProfileJson,
  verifyAgentProfileCell,
} from './agent-profile-cell'
export { createChatClient } from './analyst/chat-client'
export { createChatTraceEngine } from './analyst/chat-trace-engine'
export { buildDefaultAnalystRegistry } from './analyst/default-registry'
export { createDspyRlmTraceEngine } from './analyst/dspy-rlm-engine'
export { DEFAULT_TRACE_ANALYST_OUTPUT_TOKENS } from './analyst/engine'
export { diffFindings, FindingsStore } from './analyst/findings-store'
export { createTraceAnalyst } from './analyst/kind-factory'
export { DEFAULT_TRACE_ANALYST_KINDS, FAILURE_MODE_KIND_SPEC } from './analyst/kinds'
export {
  admitPolicyEdit,
  applyPolicyEditToSurface,
  computePolicyEditId,
  makePolicyEdit,
  makePolicyEditCandidateRecord,
  POLICY_EDIT_CANDIDATE_RECORD_SCHEMA,
  PolicyEditValidationError,
  policyEditsFromFindings,
  validatePolicyEdit,
  validatePolicyEditCandidateRecord,
} from './analyst/policy-edit'
export { AnalystRegistry } from './analyst/registry'
export { assertNoJudgeVerdict } from './analyst/steer-firewall'
export { computeFindingId, makeFinding, makeProposalFinding } from './analyst/types'
export { analyzeAntiSlop, createAntiSlopJudge } from './anti-slop'
export { ATTESTATION_ALGORITHM, attest, verifyAttestation } from './attestation'
export { iqr, welchsTTest } from './baseline'
export { DEFAULT_BOUNDED_PROCESS_TIMEOUT_MS, runBoundedProcess } from './bounded-process'
export { BudgetBreachError, BudgetGuard } from './budget-guard'
export { runCampaign } from './campaign/run-campaign'
export { quotaExhaustedUntil, transientDispatchFailure } from './campaign/transient-failure'
export { runCanaries } from './canary'
export { assertCapabilityHeadroom, capabilityHeadroom } from './capability-headroom'
export { ProductClient } from './client'
export { LOCAL_COMMAND_RUNNER_DEFAULT_CAP_MS, localCommandRunner } from './command-runner'
export {
  completionVerdict,
  createLlmCorrectnessChecker,
  verifyCompletion,
} from './completion-verifier'
export { checkCanaries } from './contamination-guard'
export { analyzeRuns } from './contract/analyze-runs'
export { defineAgentEval } from './contract/define-agent-eval'
export { selfImprove } from './contract/self-improve'
export { objectiveEval, runAgentControlLoop, subjectiveEval } from './control-runtime'
export {
  CostAccountingIncompleteError,
  CostCallConflictError,
  CostCeilingReachedError,
  CostLedger,
  CostLedgerPersistenceError,
  CostReceiptCaptureError,
  CostReservationExceededError,
  costForTokenPricing,
  costForUsage,
  modelPriceKey,
} from './cost-ledger'
export { CostTracker } from './cost-tracker'
export { runCounterfactual } from './counterfactual'
export { deployGateLayer, viteDeployRunner, wranglerDeployRunner } from './deploy-gate-layer'
export { errorStreakDetector, observeAll, repeatedActionDetector } from './detectors'
export { discoverPersonas } from './discover-personas'
export { ERROR_COUNT_PATTERNS, extractErrorCount } from './error-count-extractor'
export { AgentEvalError, ConfigError, JudgeError, NotFoundError, ValidationError } from './errors'
export { runEvalCampaign } from './eval-campaign'
export { jsonlRunRecordBackend } from './eval-trace-store'
export {
  classifyFailure,
  classifyFailureReason,
  DEFAULT_FAILURE_REASON_RULES,
  FAILURE_BLAME,
  FAILURE_CLASSES,
  failureBlame,
  INFRA_FAILURE_BLAMES,
} from './failure-taxonomy'
export {
  analystFindingDigest,
  analystRunDigest,
  analystRunToFeedbackTrajectory,
  analystRunToReviewRequests,
  assignFeedbackSplit,
  controlRunToFeedbackTrajectory,
  createFeedbackTrajectory,
  FileSystemFeedbackTrajectoryStore,
  feedbackTrajectoriesToDatasetScenarios,
  feedbackTrajectoriesToOptimizerRows,
  feedbackTrajectoryToOptimizerRow,
  InMemoryFeedbackTrajectoryStore,
  renderPreferenceMemoryMarkdown,
  summarizePreferenceMemory,
  withAssignedFeedbackSplit,
} from './feedback-trajectory'
export { HeldOutGate } from './held-out-gate'
export {
  assertNoHiddenLeak,
  blendHeldout,
  defaultBlendWeights,
  gradeOnHidden,
  hiddenGrade,
  routeFields,
  withHeldoutBlend,
} from './hidden-criteria-grading'
export { improvementVerdict } from './improvement-verdict'
export {
  assertRealBackend,
  BackendIntegrityError,
  summarizeBackendIntegrity,
} from './integrity/backend-integrity'
export { preflightModels } from './integrity/preflight'
export {
  assertCrossFamilyServed,
  assertServedModel,
  assertServedModels,
  checkServedModel,
  ModelSubstitutionError,
  ServedCrossFamilyError,
  servedModelAcceptable,
} from './integrity/served-model'
export { assertSingleBackend } from './integrity/single-backend'
export { runIntentMatchJudge } from './intent-match-judge'
export {
  calibrateJudge,
  calibrateJudgeContinuous,
  continuousAgreement,
  verbosityBias,
} from './judge-calibration'
export { aggregateJudgeVerdicts } from './judge-ensemble'
export { assertCrossFamily, CrossFamilyError, judgeFamily } from './judge-families'
export { ensembleJudge } from './judge-panel'
export { withJudgeRetry } from './judge-retry'
export { runKeywordCoverageJudge, runKeywordCoverageJudgeUrl } from './keyword-coverage-judge'
export {
  acquisitionPlansForKnowledgeGaps,
  blockingKnowledgeEval,
  knowledgeReadinessTracePayload,
  scoreKnowledgeReadiness,
  userQuestionsForKnowledgeGaps,
} from './knowledge/readiness'
export { leaderboard } from './leaderboard'
export {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  isTransientLlmError,
  LlmCallError,
  LlmResponseError,
  maximumChargeForLlmRequest,
  stripFencedJson,
} from './llm-client'
export { llmJudge } from './llm-judge'
export {
  addCalibrationVerdicts,
  assertJudgeMayGate,
  DEFAULT_JUDGE_GATE_POLICY,
  JudgeGateRefusedError,
  judgeGateDecision,
  measureJudgeAgreement,
  registerCalibrationSet,
  snapshotFromJudgeAgreement,
} from './meta-eval/judge-gate'
export {
  estimateCost,
  estimateTokens,
  isModelPriced,
  MODEL_PRICING,
  resolveModelPricing,
} from './metrics'
export { resolveSeat, seatPresets } from './model-seats'
export { gradeSemanticStatus, MultiLayerVerifier } from './multi-layer-verifier'
export {
  evaluateOracles,
  jsonShape,
  notBlocked,
  regexMatches,
  textInSnapshot,
  urlContains,
} from './oracle'
export { comparePairedArms, pairArms, pairRunRecords } from './paired-arms'
export { minimumPairsForPairedDeltaTest, pairedDeltaTest } from './paired-delta-test'
export { decidePairedPromotion } from './paired-promotion-decision'
export { pairedPromotionPower, requiredPairsForPairedPromotion } from './paired-promotion-power'
export { dominates, paretoFrontier } from './pareto'
export { partitionHeldOut, partitionTrainSelectionTest } from './partition-held-out'
export { budgetBreachView } from './pipelines/budget-breach'
export { failureClusterView } from './pipelines/failure-cluster'
export { judgeAgreementView } from './pipelines/judge-agreement'
export { toolWasteView } from './pipelines/tool-waste'
export { hashJson, manifestContentDigest } from './pre-registration'
export { extractProducedState } from './produced-state'
export {
  assertProductBenchmarkRun,
  exportProductBenchmark,
  exportProductBenchmarkRuns,
  productBenchmarkRepoIdentity,
  readProductBenchmarkManifest,
} from './product-benchmark/index'
export * as profile from './profile/index'
export { bootstrapCi } from './promotion-gate'
export { hashContent, PromptRegistry } from './prompt-registry'
export {
  createLlmReviewer,
  inMemoryReviewStore,
  jsonlReviewStore,
  runProposeReview,
} from './propose-review'
export { runProposeReviewAsControlLoop } from './propose-review-control'
export type * from './public-api/analysis'
export type * from './public-api/evaluation'
export type * from './public-api/execution'
export type * from './public-api/integration'
export type * from './public-api/run-data'
export type * from './public-api/verification'
export {
  DEFAULT_RED_TEAM_CORPUS,
  redTeamDataset,
  redTeamReport,
  scoreRedTeamOutput,
} from './red-team'
export { buildReflectionPrompt, parseReflectionResponse } from './reflective-mutation'
export { evaluateReleaseConfidence } from './release-confidence'
export { mintRolloutRows } from './rollout/index'
export {
  isRunRecord,
  modelHasSnapshot,
  parseRunRecordSafe,
  RunRecordValidationError,
  runTaskScore,
  searchCellRunId,
  UNKNOWN_MODEL,
  validateRunRecord,
} from './run-record'
export { aggregateRunScore, clamp01 } from './run-score'
export { projectRuntimeTrajectoryEvidence } from './runtime-trajectory'
export {
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  recordRuns,
  recordRunsToScorecard,
} from './scorecard'
export { runSemanticConceptJudge, SEMANTIC_CONCEPT_JUDGE_VERSION } from './semantic-concept-judge'
export { evaluateInterimReleaseConfidence, pairedEvalueSequence } from './sequential'
export { analyzeSeries } from './series-convergence'
export {
  BOOTSTRAP_GATE_MIN_N,
  benjaminiHochberg,
  bonferroni,
  cliffsDelta,
  cohensD,
  confidenceInterval,
  corpusInterRaterAgreement,
  corpusInterRaterAgreementFromJudgeScores,
  DECISION_PAIRED_DELTA_STATISTIC,
  eProcess,
  holm,
  interpretCliffs,
  interRaterReliability,
  isBinaryOutcomeVector,
  mannWhitneyU,
  mcnemar,
  mcnemarPower,
  mcnemarRequiredN,
  mulberry32,
  pairedBinaryScale,
  pairedBootstrap,
  pairedCohensDz,
  pairedDeltaTieFraction,
  pairedMde,
  pairedRiskDifference,
  pairedRiskDifferenceExact,
  pairedRiskDifferenceScore,
  pairedSignTest,
  pairedTTest,
  partialCredit,
  passAtK,
  pearsonR,
  ranks,
  requiredPairedSampleSize,
  requiredSampleSize,
  spearmanR,
  summarizeNumberSeries,
  weightedComposite,
  weightedMean,
  wilcoxonSignedRank,
  wilson,
} from './statistics'
export {
  chiSquared,
  chiSquaredPValue,
  fisherExactTwoSided,
  linearRegressionSlope,
  normalTwoSidedPValue,
  studentTTwoSidedPValue,
  twoByTwoPValue,
} from './statistics/inference'
export { sampleMedian, summarizeSample } from './statistics/samples'
export { PairwiseSteeringOptimizer } from './steering-optimizer'
export { gainHistogram, paretoChart, summaryTable } from './summary-report'
export { computeToolUseMetrics } from './tool-use-metrics'
export { OUTPUT_VALUE } from './trace/attribute-vocabulary'
export { captureFetchToRawSink } from './trace/capture-fetch'
export { TraceEmitter } from './trace/emitter'
export { extractUsage, extractUsageFromSse } from './trace/extract-usage'
export { assertRunCaptured, RunIntegrityError } from './trace/integrity'
export { exportRunAsOtlp } from './trace/otel'
export { argHash, judgeSpans, runsForScenario } from './trace/query'
export {
  FileSystemRawProviderSink,
  InMemoryRawProviderSink,
  NoopRawProviderSink,
} from './trace/raw-provider-sink'
export {
  assessShareSafety,
  REDACTION_VERSION,
  redact,
  redactForShare,
  redactText,
  shareAllowed,
} from './trace/redact'
export { isJudgeSpan, isLlmSpan, isToolSpan } from './trace/schema'
export { FileSystemTraceStore, InMemoryTraceStore } from './trace/store'
export { analyzeTraces } from './trace-analyst/analyst'
export {
  buildTraceInsightContext,
  buildTraceInsightPrompt,
  describeTraceInsightScope,
  domainEvidencePattern,
  inferDomainKeywords,
  scoreTraceInsightReadiness,
  tokenizeDomainWords,
} from './trace-analyst/insights'
export { createBoundedTraceAnalysisStore } from './trace-analyst/store'
export {
  OtlpFileTraceStore,
  otlpTextToTraceAnalysisStore,
  spanRecordsToTraceAnalysisStore,
} from './trace-analyst/store-otlp'
export { toolSpansToTraceAnalysisStore } from './trace-analyst/store-tool-spans'
export {
  DEFAULT_TRACE_ANALYST_BUDGETS,
  TRACE_ANALYST_TRUNCATION_MARKER_PREFIX,
} from './trace-analyst/types'
export {
  checkTraceContracts,
  compileTraceContractSpec,
  evaluateTraceContract,
  explainTraceContract,
  lintTraceContractSpec,
  traceContract,
} from './trace-contracts'
export { buildTrajectory } from './trajectory'
export { gateTreatmentApplied } from './treatment-gate'
export { certificationEvidenceDigest, equivalenceVerdict } from './verdict'
export { canonicalJson, contentHash, fileVerdictCache } from './verdict-cache'
export {
  buildEquivalenceRecord,
  defineEquivalenceCheck,
  EquivalenceProtocolError,
  runEquivalenceCheck,
  VERIFICATION_STRATEGIES,
  VERIFICATION_STRATEGY_SOURCES,
} from './verification-strategy'
