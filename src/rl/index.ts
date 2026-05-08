/**
 * RL primitives — the bridge from evaluation infrastructure to RL training.
 *
 * Every primitive in this module either:
 *   - converts an existing agent-eval artifact into the shape an RL
 *     pipeline needs (run-record-adapters, preferences, verifiable-reward,
 *     process-reward), or
 *   - implements the canonical RL eval methodology that the rest of the
 *     package didn't have (off-policy, contamination, tournament,
 *     adversarial, compute-curves).
 *
 * Together they close the auto-research loop: campaign → standardised
 * RunRecord → preferences / verifiable rewards → policy update via the
 * consumer's choice of RL trainer (TRL, prime-rl, in-house) → next
 * campaign.
 *
 * **STATUS — 0.23 release:** Foundational primitives (run-record-adapters,
 * verifiable-reward, preferences, off-policy IPS/SNIPS/DR, tournament,
 * contamination, compute-curves) are stable: math is sourced, tested,
 * and have at least one runnable example. Speculative primitives
 * (rl-campaign, auto-research, predictive-validity-researcher,
 * exporters, active-curriculum, reward-hacking, adaptation-eval,
 * process-reward) are **experimental** — interfaces are reasonable but
 * may evolve as real production consumers exercise them. Mark calls to
 * experimental primitives so they're easy to find at the next major.
 *
 * See `examples/auto-research-with-agent-builder/` for the canonical
 * end-to-end composition pattern, and
 * `examples/fine-tune-with-prime-rl/` for the data → training bridge.
 */

export * from './run-record-adapters'
export * from './verifiable-reward'
export * from './preferences'
export * from './off-policy'
export * from './process-reward'
export * from './contamination'
export * from './tournament'
export * from './adversarial'
export * from './compute-curves'
export * from './active-curriculum'
export * from './reward-hacking'
export * from './adaptation-eval'
export * from './exporters'
export * from './rl-campaign'
export * from './predictive-validity-researcher'
export * from './auto-research'
