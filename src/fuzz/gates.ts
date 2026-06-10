/**
 * Validity gates — what separates a fuzzer from a slop generator.
 *
 * A notable candidate is admitted only when it is fair and reproducible. None of
 * these are on by default: the live wiring opts in, so reported findings carry
 * their proof.
 */

import type { Cell, Evaluation, Evaluator, ValidityGates } from './types'

/** Combine gate sets; a candidate must pass every gate in every set. */
export function composeGates<S>(...sets: Array<ValidityGates<S> | undefined>): ValidityGates<S> {
  const present = sets.filter((s): s is ValidityGates<S> => s != null)
  return {
    isValid: async (scenario, ev, cell) => {
      for (const g of present) {
        if (g.isValid && !(await g.isValid(scenario, ev, cell))) return false
      }
      return true
    },
    isUncontaminated: async (scenario, ev, cell) => {
      for (const g of present) {
        if (g.isUncontaminated && !(await g.isUncontaminated(scenario, ev, cell))) return false
      }
      return true
    },
  }
}

/**
 * Reproducibility gate. Re-run the target on a meaning-preserving rephrase of the
 * flagged scenario; keep the finding only when the rephrase ALSO scores below the
 * threshold. A finding that flips under a cosmetic rewrite was keyed to surface
 * form, not the task — a false signal we must not report. Costs one extra
 * evaluation per candidate (candidates are rare, so cheap).
 */
export function perturbationStabilityGate<S>(opts: {
  evaluate: Evaluator<S>
  /** Produce a semantic-preserving rephrase. Return null to skip (treated as pass). */
  perturb: (scenario: S) => S | null
  /** Score strictly below this still counts as failing. Default 0.5. */
  failureThreshold?: number
}): ValidityGates<S> {
  const threshold = opts.failureThreshold ?? 0.5
  return {
    isUncontaminated: async (scenario: S, _ev: Evaluation, cell: Cell) => {
      const rephrased = opts.perturb(scenario)
      if (rephrased == null) return true
      const re = await opts.evaluate(rephrased, cell)
      return re.score < threshold
    },
  }
}

/**
 * Severity-floor gate. Reject borderline candidates whose score sits in a band
 * just under the threshold — judge noise, not a real defect.
 */
export function severityFloorGate<S>(opts: {
  failureThreshold?: number
  margin?: number
}): ValidityGates<S> {
  const threshold = opts.failureThreshold ?? 0.5
  const margin = opts.margin ?? 0.1
  return {
    isValid: (_scenario, ev: Evaluation) => ev.score <= threshold - margin,
  }
}
