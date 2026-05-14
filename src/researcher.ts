/**
 * Researcher interface — stable hook for an external autonomous-research
 * agent to drive the meta-loop.
 *
 * Implementations live downstream (typically in a private repo that
 * runs the actual LLM). This package ships only the contract + a
 * `NoopResearcher` so consumers can wire the surface without being
 * forced to implement every method up front.
 *
 * The four methods mirror the four stages of the paper "Two Loops,
 * Three Roles":
 *
 *   inspectFailures   — given the observed runs, what failure modes
 *                       are present? (data → diagnosis)
 *   proposeChange     — given diagnosed failure modes, what
 *                       structural changes should we try?
 *                       (diagnosis → plan delta)
 *   applyChange       — fold the proposed deltas into a concrete
 *                       experiment plan against an existing baseline.
 *                       (plan delta → executable plan)
 *   evaluateChange    — run the plan, return runs + the gate verdict.
 *                       (executable plan → verdict)
 *
 * Composition is the discipline: a Researcher implementation MUST
 * keep these four steps separate and inspectable. Conflating
 * "diagnose + propose + run" into a single LLM call defeats the
 * point of the framework — you can't audit which step lied.
 *
 * THIS INTERFACE IS STABLE. Breaking changes require a new module
 * (e.g. `Researcher2`) so existing implementations keep working.
 */

import type { GateDecision } from './held-out-gate'
import type { RunRecord, RunSplitTag } from './run-record'

/** A diagnosed failure mode with the run-IDs that exhibit it. */
export interface FailureMode {
  /** Short machine-readable code. Must be stable across runs of the
   *  same researcher to enable longitudinal tracking. */
  code: string
  /** Human-readable description for the paper / dashboard. */
  description: string
  evidence: {
    /** Run IDs (from `RunRecord.runId`) where this failure mode was
     *  observed. */
    runIds: string[]
    /** Number of run samples that informed the diagnosis. */
    samples: number
  }
}

/** A single steering change the researcher wants to try. */
export interface SteeringChange {
  kind: 'reviewer_prompt' | 'skill_add' | 'skill_remove' | 'threshold' | 'budget'
  /** Implementation-specific payload. Researcher implementations
   *  define the schema — keep this `unknown` here to avoid coupling
   *  the public interface to any one researcher's internal model. */
  payload: unknown
  /** Why the researcher proposed this change. Goes into the audit
   *  trail next to the failure-mode evidence. */
  rationale: string
  /** Optional self-reported expected delta on the headline metric. */
  expectedDelta?: number
}

/** A single experiment plan, mapped onto the search/holdout splits. */
export interface ExperimentPlan {
  baselineCandidateId: string
  proposedCandidateId: string
  changes: SteeringChange[]
  /** USD ceiling for the entire experiment. The runner must stop
   *  before exceeding this and report a partial result. */
  evaluationBudgetUsd: number
  /** Item IDs (your dataset keys) for the search vs holdout splits. */
  splits: { search: string[]; holdout: string[] }
}

/** Result of running a plan: every run, plus the gate verdict. */
export interface ExperimentResult {
  plan: ExperimentPlan
  runs: RunRecord[]
  gateDecision: GateDecision
}

/**
 * The researcher loop. Stable, four-step, inspectable.
 *
 *   ┌──────────┐  inspectFailures  ┌──────────┐  proposeChange ┌──────────┐
 *   │   runs   │ ─────────────────▶│ failures │ ──────────────▶│ changes  │
 *   └──────────┘                   └──────────┘                └────┬─────┘
 *                                                                   │
 *                                                                   ▼
 *                              ┌────────────────┐  applyChange ┌────────┐
 *                              │ ExperimentPlan │ ◀────────────│  base  │
 *                              └────────┬───────┘              └────────┘
 *                                       │
 *                       evaluateChange  ▼
 *                              ┌────────────────┐
 *                              │ ExperimentResult│
 *                              └────────────────┘
 */
export interface Researcher {
  inspectFailures(runs: RunRecord[]): Promise<FailureMode[]>
  proposeChange(failures: FailureMode[]): Promise<SteeringChange[]>
  applyChange(changes: SteeringChange[], baseline: ExperimentPlan): Promise<ExperimentPlan>
  evaluateChange(plan: ExperimentPlan): Promise<ExperimentResult>
}

export interface CallbackResearcherOptions {
  inspectFailures: Researcher['inspectFailures']
  proposeChange: Researcher['proposeChange']
  applyChange: Researcher['applyChange']
  evaluateChange: Researcher['evaluateChange']
}

/**
 * Minimal concrete researcher for tests, scripts, and small integrations.
 * Larger autonomous researchers can still implement `Researcher` directly.
 */
export class CallbackResearcher implements Researcher {
  constructor(private readonly callbacks: CallbackResearcherOptions) {}

  inspectFailures(runs: RunRecord[]): Promise<FailureMode[]> {
    return this.callbacks.inspectFailures(runs)
  }

  proposeChange(failures: FailureMode[]): Promise<SteeringChange[]> {
    return this.callbacks.proposeChange(failures)
  }

  applyChange(changes: SteeringChange[], baseline: ExperimentPlan): Promise<ExperimentPlan> {
    return this.callbacks.applyChange(changes, baseline)
  }

  evaluateChange(plan: ExperimentPlan): Promise<ExperimentResult> {
    return this.callbacks.evaluateChange(plan)
  }
}

/**
 * No-op researcher — fails loud on every method. Use as a placeholder
 * in code paths that wire the interface but don't have an implementation
 * yet. Importantly, this does NOT silently succeed: a no-op researcher
 * that returned empty arrays would muffle the loop's signal that
 * nobody implemented the brain.
 */
export class NoopResearcher implements Researcher {
  private readonly hint: string

  constructor(hint = 'NoopResearcher: no implementation wired') {
    this.hint = hint
  }

  async inspectFailures(_runs: RunRecord[]): Promise<FailureMode[]> {
    throw new Error(`${this.hint} (inspectFailures not implemented)`)
  }

  async proposeChange(_failures: FailureMode[]): Promise<SteeringChange[]> {
    throw new Error(`${this.hint} (proposeChange not implemented)`)
  }

  async applyChange(
    _changes: SteeringChange[],
    _baseline: ExperimentPlan,
  ): Promise<ExperimentPlan> {
    throw new Error(`${this.hint} (applyChange not implemented)`)
  }

  async evaluateChange(_plan: ExperimentPlan): Promise<ExperimentResult> {
    throw new Error(`${this.hint} (evaluateChange not implemented)`)
  }
}

/** Re-export the split alias so callers don't have to import twice. */
export type { RunSplitTag }
