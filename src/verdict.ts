/**
 * Validator-output verdict — substrate primitive for "did this output pass,
 * and how well?"
 *
 * Used by:
 *   - `@tangle-network/agent-eval/matrix` — verdict per cell in the cartesian.
 *   - `@tangle-network/agent-runtime` — Validator<Output, Verdict = DefaultVerdict>.
 *     Runtime keeps `Validator` because it's coupled to runtime-shaped
 *     `ValidationCtx` (iteration, signal, traceEmitter); the verdict TYPE
 *     itself is a substrate concept and lives here.
 *
 * Repo layering: agent-eval is the substrate (no upward deps). Both
 * agent-runtime and agent-knowledge consume this type FROM agent-eval —
 * never the other way around. See CLAUDE.md "Repo layering" for the rule.
 */

import type { CheckerIdentity, VerificationStrategySource } from './verification-strategy'

/**
 * What certified a verdict — the epistemics a bare `valid` + `score` pair
 * cannot carry. A kernel-checked proof and an LLM judge can produce the
 * same `{ valid: true, score: 1 }`; this record is what tells them apart.
 *
 * Every field is required on purpose. A certification without a checker
 * identity or an evidence digest is exactly the unverifiable claim this
 * record exists to kill.
 */
export interface VerdictCertification {
  /**
   * Which verification-strategy member produced the certificate. Each
   * member's failure mode is documented on the family type and in
   * `VERIFICATION_STRATEGIES` (src/verification-strategy.ts).
   */
  strategy: VerificationStrategySource
  /**
   * Exact checker identity, e.g. `{ name: 'lean4', version: '4.33.0',
   * pins: { mathlib: 'db584cd6d46c' } }` for a kernel, or a judge model
   * id + snapshot for a judge.
   */
  checker: CheckerIdentity
  /**
   * Every step the certificate rests on that the checker did NOT verify,
   * e.g. 'diagonal embedding argued in prose' or 'agreement arms share
   * training-corpus blind spots'. An empty array is the producer's
   * explicit, auditable claim that there are none — it is not a default.
   */
  assumptions: string[]
  /** Digest (e.g. sha256) of the evidence artifact the checker consumed or produced. */
  evidenceDigest: string
}

/**
 * Minimal verdict shape — `valid` + `score` are required; `scores` +
 * `notes` are optional surface. Validators that need richer shapes
 * parameterise `Validator<Output, MyVerdict>` with their own type.
 *
 * Need structured extras? Extend DefaultVerdict with typed fields — never
 * serialize extras into `notes`.
 */
export interface DefaultVerdict {
  /** Whether the output meets the validator's pass criteria. */
  valid: boolean
  /** Aggregate score in [0, 1]. Drivers use this for winner selection. */
  score: number
  /** Per-dimension scores. Free-form; weighted into `score` by the validator. */
  scores?: Record<string, number>
  /** Human-readable rationale; surfaces in trace + final-result `winner.verdict`. */
  notes?: string
  /**
   * What certified this verdict, when anything did. Absent = uncertified:
   * scored, but no strategy vouches for it. A consumer that cares reads
   * `certification.strategy` to tell a kernel-checked verdict from a
   * judge-scored one; a consumer that does not read it sees the exact
   * verdict it always saw.
   */
  certification?: VerdictCertification
}
