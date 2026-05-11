/**
 * `@tangle-network/agent-eval/persona` — the canonical end-to-end eval entry.
 *
 * One primitive, three contracts:
 *
 *   `runPersonaEval`     — owns the pipeline (raws + traces + records +
 *                          scoring + RL-bridge analysis + manifest)
 *   `PersonaSpec`        — the eval input shape
 *   `PersonaRunner`      — how to call the system under test
 *   `PersonaScorer`      — how to convert outputs to a per-persona outcome
 *
 * Capture integrity is wired by CONSTRUCTION (see SKILL.md §Capture
 * integrity). Every persona run automatically has raws + traces +
 * records on disk unless the caller passes `captureIntegrity` opt-outs.
 *
 * Adapters for legacy persona formats (YAML / TS modules) live alongside
 * so consumers don't rewrite their persona files to adopt the primitive.
 */

export {
  runPersonaEval,
} from './run-persona-eval'
export type {
  RunPersonaEvalOptions,
  RunPersonaEvalCaptureIntegrity,
  RunPersonaEvalComparator,
  RunPersonaEvalManifestRunDefaults,
  PersonaEvalArtifact,
  PersonaEvalManifest,
  PersonaRunResult,
  AnalyzeRLBridgeReport,
} from './run-persona-eval'

export {
  loadYamlPersonas,
  loadTsPersonas,
} from './adapters'
export type {
  LoadYamlPersonasOptions,
  LoadTsPersonasOptions,
} from './adapters'

export type {
  PersonaSpec,
  PersonaTurn,
  PersonaTurnExpectation,
  PersonaRunState,
  PersonaTurnHistory,
  PersonaRunner,
  PersonaRunnerContext,
  PersonaRunnerEvent,
  PersonaScorer,
  PersonaScorerInput,
  PersonaOutcome,
} from './types'
