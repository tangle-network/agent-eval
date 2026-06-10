/**
 * `@tangle-network/agent-eval/fuzz` — behavior-space exploration.
 *
 * Search a target's behavior space for verified findings: tile the input plan,
 * steer budget toward the least-certain cells, mutate (or skill-generate)
 * scenarios, bin a quality-diversity archive by measured behavior, and admit
 * only findings that pass the validity gates. Every run emits a `CapsuleData`
 * artifact — coverage heat-map + minimized verified findings.
 *
 * Entry points: `fuzzAgent` (adversarial batch preset), `BehaviorExplorer` +
 * `makeExploreTools` (the agent-driven session). Evaluations ARE
 * `DefaultVerdict`s — the same spine as judges and verifiers.
 */

export type { BuildCapsuleInput, RenderCapsuleOptions } from './capsule'
export { buildCapsule, renderCapsuleHtml } from './capsule'
export type { EvalRecord } from './cube'
export { buildCoverage, cellId, enumerateCells } from './cube'
export { BehaviorExplorer } from './explorer'
export type { FuzzAgentOptions } from './fuzz-agent'
export { fuzzAgent } from './fuzz-agent'
export { composeGates, perturbationStabilityGate, severityFloorGate } from './gates'
export { adversarialObjective, mutationProposer, noveltyObjective } from './policies'
export type { ExploreToolDef } from './tools'
export { makeExploreTools } from './tools'
export type {
  ArchiveEntry,
  BehaviorSpace,
  CapsuleData,
  Cell,
  CoverageCell,
  Evaluation,
  Evaluator,
  ExploreEvent,
  ExploreOptions,
  Finding,
  Objective,
  ObjectiveContext,
  ProposeContext,
  Proposer,
  RunCost,
  SpaceAxis,
  ValidityGates,
} from './types'
