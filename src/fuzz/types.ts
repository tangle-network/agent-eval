/**
 * Behavior-space exploration — types.
 *
 * One engine searches a space of inputs against a target, scores each run with a
 * multi-objective verdict, keeps a quality-diversity archive, and admits only
 * findings that pass the validity gates. Adversarial fuzzing is the headline
 * preset (`fuzzAgent`); swapping the `Objective` re-points the same engine at
 * novelty search, curriculum growth, or user-simulation.
 *
 * Two kinds of coordinates, deliberately distinct:
 *  - INPUT axes (`space.axes`) are the stratification plan — enumerable up front,
 *    so allocation and the coverage denominator (planned vs covered) are honest.
 *  - MEASURED descriptors (`descriptor(scenario, ev)`) are read off the rollout —
 *    they bin the archive by what the agent DID, and never inflate the coverage
 *    denominator (a behavior you haven't seen yet is not a planned cell).
 *
 * An `Evaluation` IS a `DefaultVerdict` — same spine as judges and verifiers,
 * never a parallel score shape.
 */

import type { CostChannel, CostLedger } from '../cost-ledger'
import type { AdversarialMutation } from '../rl/adversarial'
import type { DefaultVerdict } from '../verdict'

// ── behavior space ───────────────────────────────────────────────────────────

/** One input axis of the stratification plan (e.g. matterType, difficulty, personaRigor). */
export interface SpaceAxis {
  name: string
  values: string[]
}

/** The input space to stratify. Cells are the cartesian product of the axes. */
export interface BehaviorSpace {
  axes: SpaceAxis[]
}

/** One input cell: a coordinate in the stratification plan. */
export interface Cell {
  /** Stable id, e.g. `matterType=nda|difficulty=hard`. */
  id: string
  coords: Record<string, string>
}

// ── evaluation (the canonical verdict, extended) ─────────────────────────────

/**
 * The outcome of running the target against one scenario: a `DefaultVerdict`
 * (`valid`, headline `score` in [0,1], per-dimension `scores`, `notes`) plus the
 * fields exploration needs. Keep `scores` populated — the coverage map surfaces
 * WHICH dimension is weak only when evaluations carry it.
 */
export interface Evaluation extends DefaultVerdict {
  /** Measured behavior coordinates (e.g. `{ outcome: 'refused' }`). Bins the archive. */
  descriptor?: Record<string, string>
  /** Surfaced output — drives exemplars + minimization. */
  output?: string
  /** RunRecord id when the target persisted a trace. */
  runId?: string
  /** Structured labels, e.g. failure classes (`hallucination`, `refusal`). */
  labels?: string[]
}

/** Run the target against one scenario in a cell. */
export type Evaluator<S> = (scenario: S, cell: Cell) => Promise<Evaluation>

// ── pluggable policies (each has ≥2 real implementations or it isn't here) ────

/** Context a proposer sees — prior elites + findings let a skill-backed proposer steer. */
export interface ProposeContext<S> {
  cell: Cell
  seeds: S[]
  /** Current archive elites whose input cell matches. */
  elites: S[]
  /** Verified findings so far (read-only) — probe new gaps, not re-found ones. */
  findings: ReadonlyArray<Finding<S>>
  /** How many candidates to propose. */
  count: number
  rng: () => number
}

/**
 * Produces candidate scenarios for a cell. A plain function — `mutationProposer`
 * builds one from mutation operators; an agent running a generator skill IS one
 * (`(ctx) => dispatchToSkill(ctx)`), no wrapper needed.
 */
export type Proposer<S> = (ctx: ProposeContext<S>) => Promise<S[]> | S[]

/**
 * What "interesting" means. `interest` in [0,1]; a candidate is notable (gate-
 * checked, reported) when `interest >= threshold`. `adversarialObjective` (low
 * score is interesting) and `noveltyObjective` (far from the archive) ship.
 */
export interface Objective {
  kind: string
  interest(ev: Evaluation, ctx: ObjectiveContext): number
  /** Default 0.5. */
  threshold?: number
}

export interface ObjectiveContext {
  archiveScores: number[]
  archiveDescriptors: Array<Record<string, string> | undefined>
}

/**
 * Validity gates — the moat. A notable candidate is admitted ONLY when it is a
 * fair, answerable task (`isValid`) AND reproduces under a meaning-preserving
 * rephrase (`isUncontaminated`). Pass-through by default (testable without an
 * LLM); live wiring supplies real gates.
 */
export interface ValidityGates<S> {
  isValid?: (scenario: S, ev: Evaluation, cell: Cell) => boolean | Promise<boolean>
  isUncontaminated?: (scenario: S, ev: Evaluation, cell: Cell) => boolean | Promise<boolean>
}

// ── findings + coverage + capsule ─────────────────────────────────────────────

/** A gate-verified, minimized finding — the unit the capsule reports. */
export interface Finding<S> {
  id: string
  cell: Cell
  scenario: S
  /** The minimized trigger (== `scenario` when no minimizer is supplied). */
  minimized: S
  /** Legible text of the minimized trigger, when `scenarioText` is supplied. */
  text?: string
  /** The full multi-objective verdict. */
  evaluation: Evaluation
  /** The objective's interest score that flagged it. */
  interest: number
  /** Which objective flagged it. */
  objective: string
}

/** An archive elite — the most interesting scenario seen for one bin. */
export interface ArchiveEntry<S> {
  /** Input cell + measured descriptor coords combined, e.g. `difficulty=hard|outcome=refused`. */
  binId: string
  cell: Cell
  scenario: S
  evaluation: Evaluation
  interest: number
}

/** Per-INPUT-cell coverage — the planned-vs-covered map. */
export interface CoverageCell {
  cell: Cell
  runs: number
  /** Mean headline score in [0,1]; `null` when the cell was never run (honestly uncovered). */
  robustness: number | null
  /** Fraction of runs the objective flagged as notable. */
  findingRate: number
  /** Mean per-dimension scores — surfaces WHICH dimension is weak. */
  dimensions: Record<string, number>
}

/** The artifact every exploration produces. */
export interface CapsuleData<S> {
  target: string
  objective: string
  /** Stamped by the caller — the engine stays clock-free and deterministic. */
  generatedAt?: string
  coverage: CoverageCell[]
  /** Verified findings, sorted by descending interest. */
  findings: Finding<S>[]
  /** QD archive elites (binned by input × measured coords). */
  archive: ArchiveEntry<S>[]
  /** Post-harden lift, filled by a second pass after an improvement. */
  lift?: { before: number; after: number; verdict: string }
  stats: {
    totalRuns: number
    /** Input-cell denominator — the stratification plan. */
    cellsTotal: number
    cellsCovered: number
    /** Distinct measured-descriptor bins observed (never part of the denominator). */
    behaviorBinsObserved: number
    candidateFindings: number
    verifiedFindings: number
    meanRobustness: number
    /** Known dollars spent on this exploration's runs. Present only when cost
     *  tracking was wired (`costOf`) — absent means "not tracked", never $0. */
    costUsd?: number
    /** Runs whose cost was unknown (`costOf` returned null) — counted apart,
     *  never folded into `costUsd` as a fabricated $0. */
    costUnknownRuns?: number
    /** Evaluations that threw (transport/backend failures). They consumed no
     *  run budget and scored nothing — an infra axis, never folded into
     *  robustness or reported as findings. */
    evalErrors: number
    /** Present when the run stopped before its budget because consecutive
     *  eval errors tripped the circuit breaker (a dead backend must not burn
     *  the remaining budget). The capsule-so-far is complete and honest. */
    stoppedEarly?: { reason: 'eval-errors'; detail: string }
  }
}

// ── cost governance ───────────────────────────────────────────────────────────

/**
 * Known cost of one evaluated run. `model` attributes the spend in the ledger's
 * per-model rollup; absent, the entry is labeled `unattributed` (the dollars are
 * real either way — recorded as `actualCostUsd`, never an estimate).
 */
export interface RunCost {
  usd: number
  model?: string
}

// ── engine options + events ───────────────────────────────────────────────────

export type ExploreEvent<S> =
  | { type: 'cell-allocated'; cell: Cell; count: number }
  | { type: 'evaluated'; cell: Cell; scenario: S; evaluation: Evaluation }
  | { type: 'finding'; finding: Finding<S> }
  | { type: 'eval-error'; cell: Cell; scenarioId: string; message: string }
  | { type: 'round'; runsUsed: number; budget: number }

export interface ExploreOptions<S> {
  /** Name of the target under exploration — labels the capsule. */
  target: string
  /** The input stratification plan. */
  space: BehaviorSpace
  /** Candidate generator. */
  proposer: Proposer<S>
  /** Runs the target → multi-objective `Evaluation`. */
  evaluate: Evaluator<S>
  /** Seed corpus per cell. */
  seedsFor: (cell: Cell) => S[] | Promise<S[]>
  /** Stable id for a scenario (dedup + lineage). */
  scenarioId: (scenario: S) => string
  /** Human-legible text — drives capsule exemplars. */
  scenarioText?: (scenario: S) => string
  /** Measured behavior coords appended to the archive bin. Default: input cell only. */
  descriptor?: (scenario: S, ev: Evaluation) => Record<string, string>
  /** What "interesting" means. Default: `adversarialObjective(0.5)`. */
  objective?: Objective
  /** Validity gates. Default pass-through. */
  gates?: ValidityGates<S>
  /** Budget steering across input cells. `variance` chases uncertainty; `uniform` is the unsteered ablation baseline. Default `variance`. */
  allocation?: 'variance' | 'uniform'
  /** Total target evaluations. */
  budget: number
  /** Minimum evaluations per input cell before steering. Default 2. */
  floorPerCell?: number
  /** Shrink a notable scenario to its minimal trigger. Default: identity. */
  minimize?: (scenario: S, evaluate: Evaluator<S>, cell: Cell) => Promise<S> | S
  /** Max concurrent `evaluate` calls. Default 1. */
  concurrency?: number
  /** Stop the run after this many CONSECUTIVE eval errors (a dead backend must
   *  not burn the remaining budget). Successes reset the streak. Default 5. */
  maxConsecutiveEvalErrors?: number
  /** Cooperative cancellation. */
  signal?: AbortSignal
  /** Progress stream. */
  onProgress?: (event: ExploreEvent<S>) => void
  /** Deterministic seed. Default 1. */
  seed?: number
  /**
   * Cost of one evaluated run — consumer-supplied; the explorer cannot know
   * token usage. Return null when the cost is unknown: the run is COUNTED in
   * `stats.costUnknownRuns`, never folded into the total as $0. Required by
   * every other cost option (`costBudgetUsd` / `ledger` / `onCost`).
   */
  costOf?: (scenario: S, cell: Cell, ev: Evaluation) => RunCost | null
  /**
   * Hard dollar ceiling on accumulated KNOWN cost (same semantics as the
   * control-runtime `budget.maxCostUsd`: nonnegative finite, the session stops
   * once spent ≥ ceiling; no new evaluation starts after that). Unknown-cost
   * runs do not consume budget — they are reported separately, so the ceiling
   * is honest about what it can see.
   */
  costBudgetUsd?: number
  /**
   * Sink for per-run cost entries — each known `costOf` result is recorded
   * with channel 'agent' and `actualCostUsd` (token axes are zero: the
   * explorer only sees dollars). Pass the program's shared `CostLedger` so
   * `costReport` stamps fuzz spend alongside judge/analyst spend.
   */
  ledger?: CostLedger
  /** Observer fired for every known-cost run recorded. */
  onCost?: (entry: { usd: number; channel: CostChannel }) => void
}

export type { AdversarialMutation, DefaultVerdict }
