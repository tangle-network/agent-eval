// `@tangle-network/agent-eval/analyst` — the full analyst surface.
//
// The root barrel re-exports only the consumer-facing happy path (registries,
// kind specs, FindingsStore, the Analyst/AnalystFinding types). The internal
// machinery — chat-client transports, the finding-signature/subject parsers,
// tolerant JSON coercion, tool groups, prose-recovery, the judge/verifier
// adapters — lives here so it has a home without crowding the root surface.

export type { SemanticConceptJudgeAdapterOpts } from './adapters'
export { createSemanticConceptJudgeAdapter } from './adapters'
export type { BehavioralAnalystOptions } from './behavioral-analyst'
export { behavioralAnalyst, deriveEfficiencyFindings } from './behavioral-analyst'
export type {
  AnalystBenchmarkCase,
  AnalystBenchmarkDatasetRef,
  AnalystBenchmarkDescriptor,
  AnalystBenchmarkError,
  AnalystBenchmarkLabelState,
  AnalystBenchmarkObservation,
  AnalystBenchmarkOutput,
  AnalystBenchmarkProvenance,
  AnalystBenchmarkResult,
  AnalystBenchmarkRunner,
  AnalystBenchmarkSummary,
  AnalystEvidenceExpectation,
  AnalystEvidenceResolution,
  AnalystEvidenceResolutionError,
  AnalystEvidenceResolver,
  AnalystFindingScore,
  AnalystIssueExpectation,
  AnalystLatencyDistribution,
  RunAnalystBenchmarkOptions,
} from './benchmark'
export {
  registryBenchmarkRunner,
  runAnalystBenchmark,
  scoreAnalystFindings,
  traceStoreEvidenceResolver,
} from './benchmark'
export type {
  AgentRxCalibrationRunnerSummary,
  AgentRxCalibrationSummary,
} from './benchmark-agentrx-calibration'
export {
  renderAgentRxCalibrationMarkdown,
  summarizeAgentRxCalibration,
} from './benchmark-agentrx-calibration'
export type {
  AnalystBenchmarkArtifact,
  AnalystBenchmarkCommandConfig,
  AnalystBenchmarkCommandDependencies,
  AnalystBenchmarkLocalRunReceipt,
  AnalystBenchmarkProgressRow,
  AnalystBenchmarkRunIdentity,
  AnalystBenchmarkRunManifest,
  VerificationAvailabilitySummary,
} from './benchmark-command'
export {
  AGENT_RX_UPSTREAM_REVISION,
  ANALYST_BENCHMARK_COST_LEDGER_FILE,
  ANALYST_BENCHMARK_LOCAL_RECEIPT_FILE,
  ANALYST_BENCHMARK_MANIFEST_FILE,
  ANALYST_BENCHMARK_OBSERVATIONS_FILE,
  readAnalystBenchmarkArtifact,
  runAnalystBenchmarkCommand,
} from './benchmark-command'
export type {
  AnalystComparisonMetric,
  AnalystMetricComparison,
  AnalystRunnerComparison,
} from './benchmark-comparison'
export { compareAnalystRunners } from './benchmark-comparison'
export type {
  AgentRxBenchmarkCaseOptions,
  AgentRxFailure,
  AgentRxPrediction,
  AgentRxPredictionReport,
  AgentRxRow,
  CodeTraceBenchCaseOptions,
  CodeTraceBenchLabelOptions,
  CodeTraceBenchLabelSet,
  CodeTraceBenchRow,
  CodeTracerLabelGroup,
  CodeTracerPredictionAdapterOptions,
  CodeTracerPredictions,
  CodeTracerStepLabel,
  CodeTraceStageAnnotation,
  StepLabelAdapterOptions,
  UpstreamPredictionAdapterOptions,
} from './benchmark-datasets'
export {
  agentRxBenchmarkCase,
  agentRxPredictionsToFindings,
  codeTraceBenchCase,
  codeTracerPredictionsToFindings,
  normalizeAgentRxCategory,
  normalizeBenchmarkLabel,
  roundAgentRxStep,
} from './benchmark-datasets'
export {
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_DIGEST_ALGORITHM,
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES,
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
  ANALYST_BENCHMARK_EVIDENCE_DEPENDENCY_LOCK_SHA256,
  ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256,
  ANALYST_BENCHMARK_IMPLEMENTATION_DIGEST_ALGORITHM,
  ANALYST_BENCHMARK_IMPLEMENTATION_FILES,
  ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
  analystBenchmarkDependencyLockDigest,
  analystBenchmarkImplementationDigest,
} from './benchmark-implementation'
export {
  analystInstructionsOverrideFromText,
  effectiveAnalystProtocolSha256,
  readAnalystInstructionsOverride,
} from './benchmark-instructions-override'
export type {
  CodeTraceCalibrationRunnerSummary,
  CodeTraceCalibrationSummary,
} from './benchmark-public-calibration'
export {
  renderCodeTraceCalibrationMarkdown,
  summarizeCodeTraceCalibration,
} from './benchmark-public-calibration'
export {
  type PublicBenchmarkModelPrediction,
  type PublicDirectDefinitionArgs,
  publicDirectAnalystDefinition,
} from './benchmark-public-model'
export {
  type PublicRlmDefinitionArgs,
  publicRlmAnalystDefinition,
  rlmEngineLimits,
} from './benchmark-public-rlm'
export type {
  AnalystInstructionsOverride,
  PreparedPublicAnalystBenchmark,
  PublicAnalystBenchmarkDataset,
  PublicAnalystBenchmarkModelConfig,
  PublicAnalystBenchmarkModelOwner,
  PublicAnalystBenchmarkModelSettings,
  PublicBenchmarkDistributions,
  PublicBenchmarkSelectionReport,
  PublicBenchmarkValueDistribution,
} from './benchmark-real-model'
export {
  adaptPublicBenchmarkFindings,
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  type CodeTraceBlockDiagnostics,
  type CodeTraceFailureBlock,
  createPrimeBenchmarkRunner,
  createPublicBenchmarkDirectRunner,
  createPublicBenchmarkRlmRunner,
  emptyPublicBenchmarkRunner,
  expandCodeTraceFailureBlocks,
  loadPublicBenchmarkRows,
  MAX_INCORRECT_BLOCK_STEPS,
  MAX_INCORRECT_BLOCKS,
  nodeHttpPrimeBridgeTransport,
  type PrimeBenchmarkRunnerOptions,
  type PrimeBridgeTransport,
  type PrimeBridgeTransportRequest,
  type PrimeBridgeTransportResult,
  preparePublicAnalystBenchmark,
  primeAnalystProtocolSha256,
  publicBenchmarkDistributions,
  publicBenchmarkProtocolSha256,
  publicBenchmarkRlmInstructions,
  publicBenchmarkSelectionReport,
  publicBenchmarkSystemPrompt,
  selectPublicBenchmarkRows,
} from './benchmark-real-model'
export { renderAnalystBenchmarkMarkdown } from './benchmark-report'
export {
  type PrimeCodeTraceDefinitionArgs,
  primeCodeTraceAnalystDefinition,
} from './benchmark-runner-prime'
export { summarizeAnalystBenchmarkRunner } from './benchmark-summary'
export type {
  LoadedVerificationArtifacts,
  VerificationArtifactFile,
  VerificationArtifactManifest,
  VerificationArtifactRole,
} from './benchmark-verification-artifacts'
export {
  appendVerificationArtifactsToOtlp,
  DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
  loadCodeTraceVerificationArtifacts,
} from './benchmark-verification-artifacts'
export type {
  VerificationOutcome,
  VerificationOutcomeSource,
  VerificationOutcomeStatus,
  VerificationResultFile,
} from './benchmark-verification-outcome'
export { parseVerificationOutcome } from './benchmark-verification-outcome'
export { type AnalystTransportBinding, bindAnalyst } from './bind'
export type {
  ChatCallOpts,
  ChatClient,
  ChatRequest,
  ChatResponse,
  ChatTransport,
  CreateChatClientOpts,
  CustomTransportOpts,
  MockTransportOpts,
  SandboxSdkTransportOpts,
} from './chat-client'
export { createChatClient } from './chat-client'
export type { ChatTraceEngineOptions } from './chat-trace-engine'
export { createChatTraceEngine } from './chat-trace-engine'
export {
  buildDefaultAnalystRegistry,
  type DefaultAnalystRegistryOptions,
} from './default-registry'
export type {
  DefineCustomAnalystOptions,
  DefineExactCustomAnalystOptions,
} from './define'
export { defineCustomAnalyst, defineTraceAnalyst } from './define'
export type {
  AnalystBudgetDeclaration,
  AnalystDefinition,
  AnalystDefinitionAsymmetry,
  AnalystDefinitionAsymmetryReport,
  AnalystEvidenceBinding,
  AnalystProfileFragment,
  AnalystRepairDeclaration,
  AnalystRowExpansion,
  ChunkedEvidenceBinding,
  EvidenceProjection,
  ExpandRowsArgs,
  InlineEvidenceBinding,
  ReplVariableConsensusPort,
  ReplVariableEvidenceBinding,
} from './definition'
export {
  AnalystExpressivenessError,
  analystDefinitionAsymmetries,
  analystDefinitionProtocolSha256,
} from './definition'
export type { DspyRlmTraceEngineOptions } from './dspy-rlm-engine'
export { createDspyRlmTraceEngine } from './dspy-rlm-engine'
export type {
  TraceAnalysisEngine,
  TraceAnalysisEngineRequest,
  TraceAnalysisEngineResult,
  TraceAnalystLimits,
} from './engine'
export { DEFAULT_TRACE_ANALYST_OUTPUT_TOKENS, resolveTraceAnalystLimits } from './engine'
export type {
  ExactAnalystBudgetSnapshot,
  ExactAnalystExecutionPlanSnapshot,
  ExactAnalystRunCompletion,
  ExactAnalystRunEvent,
  ExactAnalystRunPolicySnapshot,
  ExactAnalystRunResult,
  ExactAnalystRunSummary,
  ExactAnalystSnapshot,
  ExactCapableAnalyst,
  ExactExecutionComponentIdentity,
  ExactExecutionComponentSnapshot,
} from './exact-types'
export type {
  RawAnalystEvidence,
  RawAnalystFinding,
} from './finding-signature'
export {
  evidenceRefsFromRawFinding,
  parseRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  RawAnalystFindingSchema,
} from './finding-signature'
export type { FindingSubject, FindingSubjectKind } from './finding-subject'
export {
  FINDING_SUBJECT_KINDS,
  FINDING_SUBJECT_SYNTAX,
  findingSubjectGrammarPromptFor,
  KIND_EXPECTED_SUBJECTS,
  parseFindingSubject,
  renderFindingSubject,
} from './finding-subject'
export type { DiffPolicy, FindingsDiff, PersistedFinding } from './findings-store'
export { defaultIsMaterial, diffFindings, FindingsStore } from './findings-store'
export type {
  CreateTraceAnalystOptions,
  TraceAnalystDefinition,
} from './kind-factory'
export {
  createTraceAnalyst,
  renderPriorFindings,
  runTraceAnalyst,
} from './kind-factory'
export {
  DEFAULT_TRACE_ANALYST_KINDS,
  FAILURE_MODE_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
  KNOWLEDGE_GAP_KIND_SPEC,
  KNOWLEDGE_POISONING_KIND_SPEC,
} from './kinds'
export {
  CONTROL_INTEGRITY_ANALYST,
  ControlIntegrityAnalyst,
  emitControlIntegrityFindings,
} from './kinds/control-integrity'
export type {
  SkillUsageRecord,
  SkillUsageReport,
  SkillUsageScanConfig,
} from './kinds/skill-usage'
export {
  buildSkillUsageReport,
  emitSkillUsageFindings,
  SKILL_USAGE_ANALYST,
} from './kinds/skill-usage'
export { coerceJson, stripCodeFences } from './parse-tolerant'
export {
  analystUsageReceiptFromPrimeUsage,
  buildPrimePrompt,
  buildPrimeRepairPrompt,
  emptyPrimeRawUsage,
  extractPrimeJsonObject,
  mergePrimeRawUsage,
  normalizePrimeUsage,
  type PrimeExchangeOptions,
  type PrimeExchangeOutcome,
  type PrimeFailure,
  type PrimeProjectionDelivery,
  type PrimeProjectionOutcome,
  type PrimeProjectionSource,
  type PrimePromptSpec,
  type PrimeProtocolIdentity,
  type PrimeRawUsage,
  type PrimeRejectedRow,
  type PrimeRepairPromptSpec,
  type PrimeRepairState,
  type PrimeReplyContract,
  type PrimeRowDecoded,
  type PrimeTurnRecord,
  primeProtocolSha256,
  primeReplyDefect,
  projectPrimeTrajectory,
  runPrimeExchange,
} from './prime-protocol'
export { assertProposalFindings, isProposalFinding } from './proposal-findings'
export type {
  AnalystHooks,
  AnalystRegistryOptions,
  BudgetPolicy,
  ExactAnalystBudgetPolicy,
  ExactRegistryRunOpts,
  RegistryRunOpts,
} from './registry'
export {
  AnalystRegistry,
  ExactAnalystRunExecutionError,
} from './registry'
export type {
  DecodedReply,
  ReplyContract,
  ReplyEnvelope,
  ReplyRowDecoded,
  ReplyRowRejection,
} from './reply-contract'
export { decodeReplyRows } from './reply-contract'
export type { TraceToolGroupName } from './tool-groups'
export { buildTraceToolsForGroup } from './tool-groups'
export type {
  Analyst,
  AnalystContext,
  AnalystCost,
  AnalystFinding,
  AnalystInputKind,
  AnalystRequirements,
  AnalystRunEvent,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystRunSummary,
  AnalystSeverity,
  AnalystUsageReceipt,
  EvidenceRef,
  ExecutionProbe,
  ExecutionProbeOutcome,
  ExecutionProbeRequest,
  ProposalFinding,
  ProposalFindingOrigin,
} from './types'
export { computeFindingId, makeFinding, makeProposalFinding } from './types'
