// ── contract ──────────────────────────────────────────────────────────
// Defining an eval: scenarios, judges, profiles, verdicts, and the
// defineAgentEval / selfImprove / analyzeRuns front doors.

export type { AgentProfile, HarnessType, ProfileAxisSpec } from '../agent-profile'
export {
  agentProfileHash,
  agentProfileId,
  CODING_HARNESSES,
  expandProfileAxes,
  HARNESS_NATIVE_MODEL,
  harnessAxisOf,
} from '../agent-profile'

export type {
  AgentProfileCell,
  AgentProfileCellInput,
  AgentProfileDimensionValue,
  AgentProfileJson,
  AgentProfileSourceInput,
} from '../agent-profile-cell'
export {
  AGENT_PROFILE_KINDS,
  agentProfileCellKey,
  buildAgentProfileCell,
  groupRunsByAgentProfileCell,
  toAgentProfileJson,
  verifyAgentProfileCell,
} from '../agent-profile-cell'
export type { GateDecision, JudgeScore, Scenario } from '../campaign/types'
export type { AnalyzeRunsOptions } from '../contract/analyze-runs'
export { analyzeRuns } from '../contract/analyze-runs'
export type {
  AgentEvalAgent,
  AgentEvalEvaluateOptions,
  AgentEvalImproveOptions,
  DefineAgentEvalOptions,
  DefinedAgentEval,
} from '../contract/define-agent-eval'
export { defineAgentEval } from '../contract/define-agent-eval'
export type { InsightReport } from '../contract/insight-report'
export type {
  SelfImproveBudget,
  SelfImproveMethodOptions,
  SelfImproveMethodProvenance,
  SelfImproveMethodResult,
  SelfImproveOptions,
  SelfImproveProgressEvent,
  SelfImproveProposerOptions,
  SelfImproveProposerResult,
  SelfImproveResult,
} from '../contract/self-improve'
export { selfImprove } from '../contract/self-improve'
export type { DatasetManifest, DatasetScenario, DatasetSplit } from '../dataset'
export * as profile from '../profile/index'
export type {
  ArtifactCheck,
  ArtifactResult,
  CheckResult,
  CollectedArtifacts,
  CompletionCriterion,
  DriverState,
  JudgeFn,
  JudgeInput,
  JudgeRubric,
  JudgeScore as DimensionJudgeScore,
  PersonaConfig,
  ProductClientConfig,
  RouteMap,
  RubricDimension,
  Scenario as ProductScenario,
  ScenarioFile,
  ScenarioResult,
  Turn,
  TurnResult,
} from '../types'
// One verdict vocabulary (docs/verdicts.md): every verification path lands
// in DefaultVerdict; `certification` names who certified — the strategy
// member, the exact checker, the unverified assumptions, and the evidence
// digest.
export type { DefaultVerdict, VerdictCertification } from '../verdict'
export { certificationEvidenceDigest, equivalenceVerdict } from '../verdict'
export type {
  CheckerIdentity,
  CheckerOutcome,
  EquivalenceArm,
  EquivalenceCheckDefinition,
  EquivalenceChecker,
  EquivalenceCheckerInput,
  EquivalenceCheckerResult,
  EquivalenceCheckSpec,
  EquivalenceObligation,
  EquivalenceObligationStatus,
  EquivalenceRecord,
  StrategyChecker,
  VerificationStrategyProfile,
  VerificationStrategySource,
} from '../verification-strategy'
export {
  buildEquivalenceRecord,
  defineEquivalenceCheck,
  EquivalenceProtocolError,
  runEquivalenceCheck,
  VERIFICATION_STRATEGIES,
  VERIFICATION_STRATEGY_SOURCES,
} from '../verification-strategy'
