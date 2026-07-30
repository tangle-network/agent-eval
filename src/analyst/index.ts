// `@tangle-network/agent-eval/analyst` — the full analyst surface.
//
// The root barrel re-exports only the consumer-facing happy path (registries,
// kind specs, FindingsStore, the Analyst/AnalystFinding types). The internal
// machinery — chat-client transports, the finding-signature/subject parsers,
// tolerant JSON coercion, tool groups, prose-recovery, the judge/verifier
// adapters — lives here so it has a home without crowding the root surface.

export type {
  JudgeAdapterOpts,
  RunCriticAdapterOpts,
  SemanticConceptJudgeAdapterOpts,
  VerifierAdapterOpts,
} from './adapters'
export {
  createJudgeAdapter,
  createRunCriticAdapter,
  createSemanticConceptJudgeAdapter,
  createVerifierAdapter,
  liftSeverity,
} from './adapters'
export { type CreateAnalystAiConfig, createAnalystAi } from './ax-service'
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
  ANALYST_BENCHMARK_HELP,
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
  ANALYST_BENCHMARK_IMPLEMENTATION_DIGEST_ALGORITHM,
  ANALYST_BENCHMARK_IMPLEMENTATION_FILES,
  ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
  analystBenchmarkDependencyLockDigest,
  analystBenchmarkImplementationDigest,
} from './benchmark-implementation'
export type {
  CodeTraceCalibrationRunnerSummary,
  CodeTraceCalibrationSummary,
} from './benchmark-public-calibration'
export {
  renderCodeTraceCalibrationMarkdown,
  summarizeCodeTraceCalibration,
} from './benchmark-public-calibration'
export type {
  PreparedPublicAnalystBenchmark,
  PublicAnalystBenchmarkDataset,
  PublicAnalystBenchmarkModelConfig,
  PublicBenchmarkDistributions,
  PublicBenchmarkSelectionReport,
  PublicBenchmarkValueDistribution,
} from './benchmark-real-model'
export {
  adaptPublicBenchmarkFindings,
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  createPublicBenchmarkModelRunner,
  emptyPublicBenchmarkRunner,
  loadPublicBenchmarkRows,
  preparePublicAnalystBenchmark,
  publicBenchmarkDistributions,
  publicBenchmarkProtocolSha256,
  publicBenchmarkSelectionReport,
  selectPublicBenchmarkRows,
} from './benchmark-real-model'
export { renderAnalystBenchmarkMarkdown } from './benchmark-report'
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
export type {
  ChatCallOpts,
  ChatClient,
  ChatRequest,
  ChatResponse,
  ChatTransport,
  CliBridgeTransportOpts,
  CreateChatClientOpts,
  CustomTransportOpts,
  DirectProviderTransportOpts,
  MockTransportOpts,
  RouterTransportOpts,
  SandboxSdkTransportOpts,
} from './chat-client'
export { createChatClient } from './chat-client'
export {
  buildDefaultAnalystRegistry,
  type DefaultAnalystRegistryOptions,
} from './default-registry'
export type { DefineTraceAnalystOptions, TraceAnalystAnalyze } from './define'
export { defineTraceAnalyst } from './define'
export type {
  RawAnalystEvidence,
  RawAnalystFinding,
} from './finding-signature'
export {
  ANALYST_SEVERITIES,
  evidenceRefsFromRawFinding,
  parseRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  RawAnalystEvidenceSchema,
  RawAnalystFindingSchema,
} from './finding-signature'
export type { FindingSubject, FindingSubjectKind } from './finding-subject'
export {
  FINDING_SUBJECT_GRAMMAR_PROMPT,
  FINDING_SUBJECT_KINDS,
  FINDING_SUBJECT_SYNTAX,
  FindingSubjectStringSchema,
  findingSubjectGrammarPromptFor,
  KIND_EXPECTED_SUBJECTS,
  parseFindingSubject,
  renderFindingSubject,
} from './finding-subject'
export type { DiffPolicy, FindingsDiff, PersistedFinding } from './findings-store'
export { defaultIsMaterial, diffFindings, FindingsStore } from './findings-store'
export type {
  CreateTraceAnalystKindOpts,
  TraceAnalystKindSpec,
} from './kind-factory'
export { createTraceAnalystKind, renderPriorFindings, renderUpstreamFindings } from './kind-factory'
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
  SkillUsageAnalyst,
} from './kinds/skill-usage'
export { coerceJson, coerceToFindingRows, stripCodeFences } from './parse-tolerant'
export { assertProposalFindings, isProposalFinding } from './proposal-findings'
export type {
  AnalystHooks,
  AnalystRegistryOptions,
  BudgetPolicy,
  RegistryRunOpts,
} from './registry'
export { AnalystRegistry } from './registry'
export {
  type StructureFindingsOptions,
  type StructureFindingsResult,
  structureFindings,
} from './structure-findings'
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
  ProposalFinding,
  ProposalFindingOrigin,
} from './types'
export { computeFindingId, makeFinding, makeProposalFinding } from './types'
