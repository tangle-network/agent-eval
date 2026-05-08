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
 * consumer's choice of RL trainer (TRL, OpenAI fine-tuning, in-house
 * GRPO/PPO) → next campaign.
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
