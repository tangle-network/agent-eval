/**
 * Coverage-guided agentic fuzzing — types.
 *
 * The eval set stops being a hand-authored fixture and becomes a living,
 * adversarially-grown population. `fuzzAgent` tiles a behavior hypercube into
 * cells, steers a search budget toward the cells whose robustness is least
 * certain, mutates scenarios to find where the agent fails, and keeps only
 * failures that are fair, reproducible, and uncontaminated. The output is a
 * `CapsuleData` artifact: a coverage map + minimized verified failures.
 *
 * The integrity invariant: a candidate failure is marketed ONLY when it passes
 * the validity gates. A "hard" scenario that is unfair, brittle, or contaminated
 * manufactures false confidence and is worse than no eval — it never enters the
 * capsule.
 */

import type { ExperimentTracker } from '../experiment-tracker'
import type { AdversarialMutation, AdversarialScenario } from '../rl/adversarial'

/** One descriptor axis of the behavior hypercube (e.g. matterType, difficulty, personaRigor). */
export interface CubeAxis {
  name: string
  values: string[]
}

/** The behavior space to tile. Cells are the cartesian product of the axes. */
export interface HypercubeSpec {
  axes: CubeAxis[]
}

/** One tile of the hypercube: a coordinate in descriptor space. */
export interface FuzzCell {
  /** Stable id, e.g. `matterType=nda|difficulty=hard|personaRigor=relentless`. */
  id: string
  coords: Record<string, string>
}

/** Outcome of running the agent under test against one scenario. `score` in [0,1]; lower = worse. */
export interface FuzzRunOutcome {
  score: number
  passed: boolean
  /** Surfaced output — drives failure exemplars + minimization. */
  output?: string
  /** RunRecord id when the target persisted a trace (lets a TraceStore-backed clusterer find it). */
  runId?: string
  /** Structured failure label (drives clustering), e.g. `hallucination`, `refusal`, `wrong_answer`. */
  failureClass?: string
}

/** How to run the agent under test. The live wiring dispatches to the real loop; tests inject a fake. */
export interface FuzzTarget<S> {
  run: (scenario: S, cell: FuzzCell) => Promise<FuzzRunOutcome>
}

/**
 * The skill-backed generator: a seed corpus + mutation operators per cell. In the
 * live wiring `seedsFor`/`mutationsFor` dispatch to an agent running the generator
 * skill (which GEPA can later optimize); in tests they are pure functions.
 */
export interface ScenarioGenerator<S> {
  /** Seed scenarios for a cell — the starting corpus the fuzzer mutates. */
  seedsFor: (cell: FuzzCell) => S[] | Promise<S[]>
  /** Mutation operators for a cell (semantic-preserving perturbations or skill-authored variants). */
  mutationsFor: (cell: FuzzCell) => AdversarialMutation<S>[]
}

/**
 * Validity gates — the moat. A candidate failure counts ONLY when it is a fair,
 * answerable task (`isValid`) AND robust to a semantic-preserving rephrase
 * (`isUncontaminated`). Both default to pass-through so the loop is testable
 * without an LLM; the live wiring supplies real gates (see `perturbationStabilityGate`).
 */
export interface ValidityGates<S> {
  /** Confirm the scenario is a legitimate, answerable task — not a trick. Default: valid. */
  isValid?: (scenario: S, outcome: FuzzRunOutcome, cell: FuzzCell) => boolean | Promise<boolean>
  /** Confirm the failure survives a meaning-preserving rephrase (not a brittle artifact). Default: pass. */
  isUncontaminated?: (
    scenario: S,
    outcome: FuzzRunOutcome,
    cell: FuzzCell,
  ) => boolean | Promise<boolean>
}

export interface FuzzAgentOptions<S> {
  /** Name of the agent under test — labels the capsule. */
  target: string
  /** The behavior hypercube to tile. */
  cube: HypercubeSpec
  /** Scenario generator (skill-backed). */
  generator: ScenarioGenerator<S>
  /** Adapter that runs the agent under test. */
  runner: FuzzTarget<S>
  /** Stable id for a scenario (dedup + lineage). */
  scenarioId: (scenario: S) => string
  /** Human-legible prompt text for a scenario — drives failure exemplars in the capsule. */
  scenarioText?: (scenario: S) => string
  /** Validity gates. Default pass-through; the live wiring supplies real ones. */
  gates?: ValidityGates<S>
  /** Score strictly below this counts as a candidate failure. Default 0.5. */
  failureThreshold?: number
  /** Total target runs across all cells (the fuzzing budget). */
  budget: number
  /** Adversarial-search rounds per cell allocation. Default 2. */
  roundsPerCell?: number
  /** Minimum runs every cell receives before variance steering (coverage floor). Default 2. */
  floorPerCell?: number
  /** Shrink a failing scenario to its minimal trigger (corpus minimization). Default: identity. */
  minimize?: (scenario: S, runner: FuzzTarget<S>, cell: FuzzCell) => Promise<S> | S
  /** Optional experiment lineage — records the run as a tracked experiment. */
  tracker?: ExperimentTracker
  /** Deterministic seed. Default 1. */
  seed?: number
}

/** A verified, minimized failure — the only thing the capsule markets. */
export interface VerifiedFailure<S> {
  id: string
  cell: FuzzCell
  /** The scenario as found. */
  scenario: S
  /** The minimized trigger (== `scenario` when no minimizer is supplied). */
  minimized: S
  /** Legible text of the minimized trigger, when `scenarioText` is supplied. */
  text?: string
  /** The failing score in [0,1]. */
  score: number
  /** `1 - score`, clamped to [0,1] — how badly it failed. */
  severity: number
  failureClass?: string
}

/** Per-cell coverage for the heat-map. */
export interface CoverageCell {
  cell: FuzzCell
  runs: number
  meanScore: number
  failureRate: number
  /** Robustness in [0,1] (== meanScore): 0 red → 1 green. `null` when the cell was never run. */
  robustness: number | null
}

/** The marketing/insight artifact every fuzz run produces. */
export interface CapsuleData<S> {
  target: string
  /** ISO timestamp — stamped by the caller (kept out of the pure loop for determinism). */
  generatedAt?: string
  /** The coverage heat-map, one entry per cell. */
  coverage: CoverageCell[]
  /** Minimized, verified failures, sorted by descending severity. */
  failures: VerifiedFailure<S>[]
  /** QD archive — the most-discriminative (hardest) scenario kept per covered cell. */
  archive: Array<{ cell: FuzzCell; scenario: AdversarialScenario<S> }>
  /** Post-harden lift, filled by a second fuzz pass after an improvement (optional). */
  lift?: { before: number; after: number; verdict: string }
  stats: {
    totalRuns: number
    cellsTotal: number
    cellsCovered: number
    candidateFailures: number
    verifiedFailures: number
    /** Mean robustness across covered cells, in [0,1]. */
    meanRobustness: number
  }
  experimentId?: string
}

export interface FuzzAgentResult<S> {
  capsule: CapsuleData<S>
}

export type { AdversarialMutation, AdversarialScenario }
