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
