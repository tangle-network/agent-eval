/**
 * @experimental
 *
 * `@tangle-network/agent-eval/campaign` — Pass A substrate primitive.
 *
 * See `docs/design/pass-a-substrate-0.40.md` for the design.
 */

export { runCampaign, type RunCampaignOptions } from './run-campaign'
export type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
  CampaignTraceWriter,
  DispatchContext,
  DispatchFn,
  Gate,
  GateContext,
  GateDecision,
  GateResult,
  GenerationRecord,
  JudgeAggregate,
  JudgeConfig,
  JudgeDimension,
  JudgeScore,
  LabeledScenarioRecord,
  LabeledScenarioSampleArgs,
  LabeledScenarioSource,
  LabeledScenarioStore,
  LabeledScenarioWrite,
  MutableSurface,
  Mutator,
  OptimizerConfig,
  RedactionStatus,
  Scenario,
  ScenarioAggregate,
  SessionScript,
  TraceSpan,
} from './types'
export {
  FsLabeledScenarioStore,
  LabeledScenarioStoreError,
  type FsLabeledScenarioStoreOptions,
} from './labeled-store/fs-adapter'

// ── Gates ────────────────────────────────────────────────────────────
export { composeGate } from './gates/compose'
export { defaultProductionGate, type DefaultProductionGateOptions } from './gates/default-production-gate'
export { heldOutGate, type HeldOutGateOptions } from './gates/heldout-gate'

// ── Auto-PR ──────────────────────────────────────────────────────────
export {
  openAutoPr,
  type OpenAutoPrOptions,
  type OpenAutoPrResult,
} from './auto-pr'

// ── Presets (the documented public surface) ──────────────────────────
export { runEval, type RunEvalOptions } from './presets/run-eval'
export {
  runOptimization,
  surfaceHash,
  type RunOptimizationOptions,
  type RunOptimizationResult,
} from './presets/run-optimization'
export {
  runProductionLoop,
  type RunProductionLoopOptions,
  type RunProductionLoopResult,
} from './presets/run-production-loop'
