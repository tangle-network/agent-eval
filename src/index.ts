// biome-ignore-all assist/source/organizeImports: Preserve public runtime module initialization order.

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

export type * from './public-api/analysis'
export type * from './public-api/evaluation'
export type * from './public-api/execution'
export type * from './public-api/integration'
export type * from './public-api/run-data'
export type * from './public-api/verification'

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
export { analyzeRuns } from './contract/analyze-runs'
export { defineAgentEval } from './contract/define-agent-eval'
export { selfImprove } from './contract/self-improve'
export * as profile from './profile/index'
export { certificationEvidenceDigest, equivalenceVerdict } from './verdict'
export {
  defineEquivalenceCheck,
  EquivalenceProtocolError,
  runEquivalenceCheck,
  VERIFICATION_STRATEGIES,
  VERIFICATION_STRATEGY_SOURCES,
} from './verification-strategy'
export { BudgetBreachError, BudgetGuard } from './budget-guard'
export {
  CostAccountingIncompleteError,
  CostCeilingReachedError,
  CostLedger,
  costForTokenPricing,
  costForUsage,
} from './cost-ledger'

export {
  analystRunDigest,
  analystRunToFeedbackTrajectory,
  analystRunToReviewRequests,
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
export {
  isRunRecord,
  modelHasSnapshot,
  parseRunRecordSafe,
  RunRecordValidationError,
  runTaskScore,
  UNKNOWN_MODEL,
  validateRunRecord,
} from './run-record'
export { aggregateRunScore, clamp01 } from './run-score'
export {
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  recordRuns,
  recordRunsToScorecard,
} from './scorecard'
export { OUTPUT_VALUE } from './trace/attribute-vocabulary'
export { captureFetchToRawSink } from './trace/capture-fetch'
export { TraceEmitter } from './trace/emitter'
export { extractUsage, extractUsageFromSse } from './trace/extract-usage'
export { assertRunCaptured, RunIntegrityError } from './trace/integrity'
export { exportRunAsOtlp } from './trace/otel'
export { argHash, judgeSpans, runsForScenario } from './trace/query'
export { FileSystemRawProviderSink, NoopRawProviderSink } from './trace/raw-provider-sink'
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
export {
  checkTraceContracts,
  compileTraceContractSpec,
  evaluateTraceContract,
  explainTraceContract,
  lintTraceContractSpec,
  traceContract,
} from './trace-contracts'
export { buildTrajectory } from './trajectory'
export { proposeSynthesisTargets } from './active-learning'
export { DEFAULT_BOUNDED_PROCESS_TIMEOUT_MS, runBoundedProcess } from './bounded-process'
export { runCampaign } from './campaign/run-campaign'
export { transientDispatchFailure } from './campaign/transient-failure'
export { ProductClient } from './client'
export { localCommandRunner } from './command-runner'
export { runAgentControlLoop } from './control-runtime'
export { objectiveEval, subjectiveEval } from './control-runtime/policy'
export { discoverPersonas } from './discover-personas'
export { runEvalCampaign } from './eval-campaign'

export { hashJson, manifestContentDigest } from './pre-registration'
export {
  createLlmReviewer,
  inMemoryReviewStore,
  jsonlReviewStore,
  runProposeReview,
} from './propose-review'

export { buildReflectionPrompt, parseReflectionResponse } from './reflective-mutation'
export { mintRolloutRows } from './rollout/index'
export { evaluateInterimReleaseConfidence, pairedEvalueSequence } from './sequential'
export { createChatTraceEngine } from './analyst/chat-trace-engine'
export { buildDefaultAnalystRegistry } from './analyst/default-registry'
export { createDspyRlmTraceEngine } from './analyst/dspy-rlm-engine'

export { diffFindings, FindingsStore } from './analyst/findings-store'
export { createTraceAnalyst } from './analyst/kind-factory'
export { DEFAULT_TRACE_ANALYST_KINDS, FAILURE_MODE_KIND_SPEC } from './analyst/kinds'
export { makePolicyEditCandidateRecord } from './analyst/policy-edit'
export { AnalystRegistry } from './analyst/registry'

export { computeFindingId, makeFinding, makeProposalFinding } from './analyst/types'
export { iqr, welchsTTest } from './baseline'
export { assertCapabilityHeadroom, capabilityHeadroom } from './capability-headroom'
export { CostTracker } from './cost-tracker'
export { errorStreakDetector, observeAll, repeatedActionDetector } from './detectors'
export { ERROR_COUNT_PATTERNS, extractErrorCount } from './error-count-extractor'
export {
  classifyFailure,
  classifyFailureReason,
  FAILURE_CLASSES,
  failureBlame,
} from './failure-taxonomy'
export {
  acquisitionPlansForKnowledgeGaps,
  blockingKnowledgeEval,
  knowledgeReadinessTracePayload,
  scoreKnowledgeReadiness,
  userQuestionsForKnowledgeGaps,
} from './knowledge/readiness'
export { leaderboard } from './leaderboard'
export {
  estimateCost,
  estimateTokens,
  isModelPriced,
  MODEL_PRICING,
  resolveModelPricing,
} from './metrics'
export { comparePairedArms, pairArms, pairRunRecords } from './paired-arms'
export { minimumPairsForPairedDeltaTest, pairedDeltaTest } from './paired-delta-test'
export { dominates, paretoFrontier } from './pareto'
export { partitionHeldOut } from './partition-held-out'
export { budgetBreachView } from './pipelines/budget-breach'
export { failureClusterView } from './pipelines/failure-cluster'
export { judgeAgreementView } from './pipelines/judge-agreement'
export { toolWasteView } from './pipelines/tool-waste'
export {
  assertProductBenchmarkRun,
  exportProductBenchmark,
  exportProductBenchmarkRuns,
  productBenchmarkRepoIdentity,
  readProductBenchmarkManifest,
} from './product-benchmark/index'
export { projectRuntimeTrajectoryEvidence } from './runtime-trajectory'
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
  eProcess,
  holm,
  interpretCliffs,
  interRaterReliability,
  mannWhitneyU,
  mcnemar,
  mcnemarPower,
  mcnemarRequiredN,
  meanConfidenceInterval,
  meanEffect,
  rateEffect,
  rocAuc,
  fitLogistic,
  mulberry32,
  pairedBootstrap,
  pairedCohensDz,
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
  studentTCritical,
  summarizeNumberSeries,
  weightedComposite,
  weightedMean,
  wilcoxonSignedRank,
  wilson,
} from './statistics'
export { gainHistogram, summaryTable } from './summary-report'
export { computeToolUseMetrics } from './tool-use-metrics'
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
export { OtlpFileTraceStore } from './trace-analyst/store-otlp'
export { toolSpansToTraceAnalysisStore } from './trace-analyst/store-tool-spans'
export { DEFAULT_TRACE_ANALYST_BUDGETS } from './trace-analyst/types'
export { evaluateActionPolicy } from './action-policy'
export { ATTESTATION_ALGORITHM, attest, verifyAttestation } from './attestation'
export { runCanaries } from './canary'
export {
  completionVerdict,
  createLlmCorrectnessChecker,
  verifyCompletion,
} from './completion-verifier'
export { checkCanaries } from './contamination-guard'
export { deployGateLayer, viteDeployRunner, wranglerDeployRunner } from './deploy-gate-layer'
export { HeldOutGate } from './held-out-gate'
export { assertNoHiddenLeak, blendHeldout } from './hidden-criteria-grading'
export {
  assertRealBackend,
  BackendIntegrityError,
  summarizeBackendIntegrity,
} from './integrity/backend-integrity'
export {
  assertCrossFamilyServed,
  assertServedModel,
  assertServedModels,
  checkServedModel,
  describeServedModelCheck,
  ModelSubstitutionError,
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
export { gradeSemanticStatus, MultiLayerVerifier } from './multi-layer-verifier'
export { evaluateOracles, jsonShape } from './oracle'
export { decidePairedPromotion } from './paired-promotion-decision'
export { pairedPromotionPower, requiredPairsForPairedPromotion } from './paired-promotion-power'
export { extractProducedState } from './produced-state'
export { bootstrapCi } from './promotion-gate'
export {
  DEFAULT_RED_TEAM_CORPUS,
  redTeamDataset,
  redTeamReport,
  scoreRedTeamOutput,
} from './red-team'
export { evaluateReleaseConfidence } from './release-confidence'
export { runSemanticConceptJudge, SEMANTIC_CONCEPT_JUDGE_VERSION } from './semantic-concept-judge'
export { gateTreatmentApplied } from './treatment-gate'
export { canonicalJson, contentHash, fileVerdictCache } from './verdict-cache'
export { createChatClient } from './analyst/chat-client'
export { analyzeAntiSlop, createAntiSlopJudge } from './anti-slop'
export { AgentEvalError, ConfigError, JudgeError, NotFoundError, ValidationError } from './errors'
export { jsonlRunRecordBackend } from './eval-trace-store'
export { assignFeedbackSplit } from './feedback-trajectory'
export { preflightModels } from './integrity/preflight'
export {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  isTransientLlmError,
  LlmCallError,
  LlmResponseError,
  maximumChargeForLlmRequest,
  stripFencedJson,
} from './llm-client'
export { resolveSeat, seatPresets } from './model-seats'
export { hashContent, PromptRegistry } from './prompt-registry'
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
export * from './statistics/two-sample'
export {
  percentileNearestRank,
  summarizeDistribution,
  type SampleDistribution,
} from './statistics/distribution-summary'
export { PairwiseSteeringOptimizer } from './steering-optimizer'

export { InMemoryRawProviderSink } from './trace/raw-provider-sink'
export { createBoundedTraceAnalysisStore } from './trace-analyst/store'
export {
  otlpTextToTraceAnalysisStore,
  spanRecordsToTraceAnalysisStore,
} from './trace-analyst/store-otlp'

export * from './sandbox-assertions'
