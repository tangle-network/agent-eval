/**
 * @experimental
 *
 * `@tangle-network/agent-eval/campaign` — measurement + improvement loop.
 *
 * `runCampaign` is the measurement primitive (a surface scored over scenarios);
 * `runImprovementLoop` is the driver-agnostic improvement loop on top of it.
 * See `docs/design/loop-taxonomy.md` for the role vocabulary (driver / worker
 * / measurement) and the dataset flywheel.
 */

// ── Auto-PR ──────────────────────────────────────────────────────────
export {
  type OpenAutoPrOptions,
  type OpenAutoPrResult,
  openAutoPr,
} from './auto-pr'
// ── Improvement drivers ──────────────────────────────────────────────
export { type EvolutionaryDriverOptions, evolutionaryDriver } from './drivers/evolutionary'
export {
  countSentenceEdits,
  extractH2Sections,
  type GepaDriverConstraints,
  type GepaDriverOptions,
  gepaDriver,
} from './drivers/gepa'
// ── Gates ────────────────────────────────────────────────────────────
export { composeGate } from './gates/compose'
export {
  type DefaultProductionGateOptions,
  defaultProductionGate,
} from './gates/default-production-gate'
export { type HeldOutGateOptions, heldOutGate } from './gates/heldout-gate'
export {
  FsLabeledScenarioStore,
  type FsLabeledScenarioStoreOptions,
  LabeledScenarioStoreError,
} from './labeled-store/fs-adapter'
// ── Presets (the documented public surface) ──────────────────────────
export { type RunEvalOptions, runEval } from './presets/run-eval'
export {
  type RunImprovementLoopOptions,
  type RunImprovementLoopResult,
  runImprovementLoop,
} from './presets/run-improvement-loop'
export {
  type RunOptimizationOptions,
  type RunOptimizationResult,
  runOptimization,
  surfaceHash,
} from './presets/run-optimization'
export { type RunCampaignOptions, runCampaign } from './run-campaign'
export { type CampaignStorage, fsCampaignStorage, inMemoryCampaignStorage } from './storage'
export type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
  CampaignTraceWriter,
  CodeSurface,
  DispatchContext,
  DispatchFn,
  Gate,
  GateContext,
  GateDecision,
  GateResult,
  GenerationCandidate,
  GenerationRecord,
  ImprovementDriver,
  JudgeAggregate,
  JudgeConfig,
  JudgeDimension,
  JudgeScore,
  LabeledScenarioRecord,
  LabeledScenarioSampleArgs,
  LabeledScenarioSource,
  LabeledScenarioStore,
  LabeledScenarioWrite,
  LabelTrust,
  MutableSurface,
  Mutator,
  OptimizerConfig,
  ProposeContext,
  RedactionStatus,
  Scenario,
  ScenarioAggregate,
  SessionScript,
  TraceSpan,
} from './types'
export { labelTrustRank } from './types'
// ── Worktree adapter (VCS-pluggable; code-tier surfaces) ─────────────
export {
  type GitWorktreeAdapterOptions,
  gitWorktreeAdapter,
  resolveWorktreePath,
  type Worktree,
  type WorktreeAdapter,
  WorktreeAdapterError,
} from './worktree'
