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
  TraceAnalystAdapterOpts,
  VerifierAdapterOpts,
} from './adapters'
export {
  createJudgeAdapter,
  createRunCriticAdapter,
  createSemanticConceptJudgeAdapter,
  createTraceAnalystAdapter,
  createVerifierAdapter,
  liftSeverity,
} from './adapters'
export { type CreateAnalystAiConfig, createAnalystAi } from './ax-service'
export { behavioralAnalyst, deriveEfficiencyFindings } from './behavioral-analyst'
export type {
  ChatCallOpts,
  ChatClient,
  ChatRequest,
  ChatResponse,
  ChatTransport,
  CliBridgeTransportOpts,
  CreateChatClientOpts,
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
export type { RawAnalystFinding } from './finding-signature'
export {
  ANALYST_SEVERITIES,
  parseRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  RawAnalystFindingSchema,
} from './finding-signature'
export type { FindingSubject, FindingSubjectKind } from './finding-subject'
export {
  FINDING_SUBJECT_GRAMMAR_PROMPT,
  FINDING_SUBJECT_KINDS,
  FindingSubjectStringSchema,
  KIND_EXPECTED_SUBJECTS,
  parseFindingSubject,
  renderFindingSubject,
} from './finding-subject'
export type { DiffPolicy, FindingsDiff, PersistedFinding } from './findings-store'
export { defaultIsMaterial, diffFindings, FindingsStore } from './findings-store'
export type {
  CreateTraceAnalystKindOpts,
  TraceAnalystGolden,
  TraceAnalystKindSpec,
} from './kind-factory'
export { createTraceAnalystKind, renderPriorFindings } from './kind-factory'
export {
  DEFAULT_TRACE_ANALYST_KINDS,
  FAILURE_MODE_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
  KNOWLEDGE_GAP_KIND_SPEC,
  KNOWLEDGE_POISONING_KIND_SPEC,
} from './kinds'
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
export type {
  AnalystHooks,
  AnalystRegistryOptions,
  BudgetPolicy,
  RegistryRunOpts,
} from './registry'
export { AnalystRegistry } from './registry'
export { assertNoJudgeVerdict, isJudgeVerdict, isTraceObservable } from './steer-firewall'
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
  EvidenceRef,
} from './types'
export { computeFindingId, makeFinding } from './types'
