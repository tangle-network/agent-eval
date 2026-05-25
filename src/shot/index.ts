/**
 * @experimental
 *
 * `@tangle-network/agent-eval/campaign` — Pass A substrate primitive.
 *
 * See `docs/design/pass-a-substrate-0.40.md` for the design.
 */

// ── Auto-PR ──────────────────────────────────────────────────────────
export {
  type OpenAutoPrOptions,
  type OpenAutoPrResult,
  openAutoPr,
} from './auto-pr'
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
export { type RunShotOptions, runShot } from './run-shot'
export type {
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
  ShotAggregates,
  ShotArtifactWriter,
  ShotCellResult,
  ShotCostMeter,
  ShotResult,
  ShotTraceWriter,
  TraceSpan,
} from './types'
