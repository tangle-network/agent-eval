/**
 * Validity gates — what separates a fuzzer from a slop generator.
 *
 * A candidate failure only enters the capsule if it is fair and reproducible.
 * These helpers compose the substrate's integrity primitives into the
 * `ValidityGates` shape `fuzzAgent` consumes. None of them are on by default:
 * the live wiring opts in, so the marketed failures carry their proof.
 */

import type { FuzzRunOutcome, FuzzTarget, ValidityGates } from './types'

/** Combine multiple gate sets; a candidate must pass every gate in every set. */
export function composeGates<S>(...sets: Array<ValidityGates<S> | undefined>): ValidityGates<S> {
  const present = sets.filter((s): s is ValidityGates<S> => s != null)
  return {
    isValid: async (scenario, outcome, cell) => {
      for (const g of present) {
        if (g.isValid && !(await g.isValid(scenario, outcome, cell))) return false
      }
      return true
    },
    isUncontaminated: async (scenario, outcome, cell) => {
      for (const g of present) {
        if (g.isUncontaminated && !(await g.isUncontaminated(scenario, outcome, cell))) return false
      }
      return true
    },
  }
}

/**
 * Reproducibility / contamination gate. Re-run the agent on a meaning-preserving
 * rephrase of the failing scenario; keep the failure only when the rephrase ALSO
 * fails. A failure that flips to passing under a cosmetic rewrite was keyed to
 * surface form (prompt wording, ordering) rather than the task — brittle, and a
 * false signal we must not market.
 *
 * Costs one extra target run per candidate failure (failures are rare, so cheap).
 */
export function perturbationStabilityGate<S>(opts: {
  runner: FuzzTarget<S>
  /** Produce a semantic-preserving rephrase. Returns null to skip the check (treated as pass). */
  perturb: (scenario: S) => S | null
  /** Score strictly below this still counts as a failure. Default 0.5. */
  failureThreshold?: number
}): ValidityGates<S> {
  const threshold = opts.failureThreshold ?? 0.5
  return {
    isUncontaminated: async (scenario, _outcome, cell) => {
      const rephrased = opts.perturb(scenario)
      if (rephrased == null) return true
      const re = await opts.runner.run(rephrased, cell)
      // Uncontaminated == the rephrase reproduces the failure.
      return re.score < threshold
    },
  }
}

/**
 * Severity-floor gate. Reject borderline "failures" whose score sits in a band
 * just under the threshold — judge noise, not a real defect. Default band: a
 * failure must score at least `margin` below the threshold to count.
 */
export function severityFloorGate<S>(opts: {
  failureThreshold?: number
  margin?: number
}): ValidityGates<S> {
  const threshold = opts.failureThreshold ?? 0.5
  const margin = opts.margin ?? 0.1
  return {
    isValid: (_scenario, outcome: FuzzRunOutcome) => outcome.score <= threshold - margin,
  }
}
