/**
 * `@tangle-network/agent-eval/fuzz` — coverage-guided agentic fuzzing.
 *
 * Turn the eval set from a hand-authored fixture into a living population: tile a
 * behavior hypercube, steer an adversarial search toward the least-certain cells,
 * and keep only the failures that survive the validity gates. Every run emits a
 * `CapsuleData` artifact — a coverage heat-map + minimized verified failures —
 * that doubles as the internal hardening map and an external proof object.
 *
 * The agent that drives this on demand supplies the `generator` (a skill GEPA can
 * optimize) and the `runner` (the agent under test, dispatched to agent-runtime).
 */

export type { BuildCapsuleInput, RenderCapsuleOptions } from './capsule'
export { buildCapsule, renderCapsuleHtml } from './capsule'
export { buildCoverage, cellId, enumerateCells } from './cube'
export { fuzzAgent } from './fuzz-agent'
export { composeGates, perturbationStabilityGate, severityFloorGate } from './gates'
export type {
  CapsuleData,
  CoverageCell,
  CubeAxis,
  FuzzAgentOptions,
  FuzzAgentResult,
  FuzzCell,
  FuzzRunOutcome,
  FuzzTarget,
  HypercubeSpec,
  ScenarioGenerator,
  ValidityGates,
  VerifiedFailure,
} from './types'
