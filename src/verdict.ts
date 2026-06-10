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
}
