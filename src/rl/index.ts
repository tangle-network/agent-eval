/**
 * RL primitives — the bridge from evaluation infrastructure to RL training,
 * mutation, and self-improvement loops.
 *
 * Every primitive in this module either:
 *   - converts an existing agent-eval artifact into the shape an RL
 *     pipeline needs (run-record-adapters, preferences, verifiable-reward,
 *     process-reward), or
 *   - implements the canonical RL eval methodology that the rest of the
 *     package didn't have (off-policy, contamination, tournament,
 *     adversarial, compute-curves), or
 *   - closes the self-improvement loop end-to-end (rl-campaign,
 *     auto-research, predictive-validity-researcher, active-curriculum,
 *     reward-hacking, adaptation-eval, exporters).
 *
 * Together they close the auto-research loop: campaign → standardised
 * RunRecord → preferences / verifiable rewards → policy update via the
 * consumer's choice of RL trainer (TRL, prime-rl, in-house) → next
 * campaign.
 *
 * ## Stability
 *
 * Each re-export below is tagged `@stable` or `@experimental`:
 *
 *   - `@stable` — math sourced, tested, at least one runnable example
 *     showing the canonical composition pattern. Interface frozen at
 *     0.x within this major.
 *   - `@experimental` — interface is reasonable but may evolve as real
 *     production consumers exercise it. Pin the patch version if you
 *     depend on the exact shape.
 *
 * See `examples/auto-research-with-agent-builder/` for the canonical
 * end-to-end composition pattern, and
 * `examples/fine-tune-with-prime-rl/` for the data → training bridge.
 */

// ── @stable ─────────────────────────────────────────────────────────
// Foundational adapters and reward extractors. Math sourced, tested,
// composed in shipping examples.

/** @stable Compute curves: best-of-N, self-consistency, Pareto frontier across budgets. */
export * from './compute-curves'
/** @stable Held-out perturbation probes for benchmark contamination (paired Wilcoxon). */
export * from './contamination'
/** @stable Off-policy value estimation: IPS, SNIPS, doubly-robust. */
export * from './off-policy'
/** @stable (chosen, rejected) preference triples for DPO / KTO / PPO. */
export * from './preferences'
/** @stable Canonical `RunRecord` adapters: trials → records, verification reports → records. */
export * from './run-record-adapters'
/** @stable Bradley-Terry MLE + online Elo for pairwise tournament ratings. */
export * from './tournament'
/** @stable Verifiable reward extraction (compile / test / schema) with judge-noise filtering. */
export * from './verifiable-reward'

// ── @experimental ───────────────────────────────────────────────────
// Interfaces are reasonable but may evolve. Pin the patch version.

/** @experimental Variance-based + Thompson-sampling budget allocation across (variant, scenario) cells. */
export * from './active-curriculum'
/** @experimental Adaptation eval — does the policy actually learn from feedback? */
export * from './adaptation-eval'
/** @experimental Active scenario search for inputs the policy fails on. */
export * from './adversarial'
/** @experimental Unified entry point bridging optimization output to RL signal + mutation proposals. */
/** @experimental Training-data exporters (HuggingFace datasets, JSONL, parquet). */
export * from './exporters'
/** @experimental Researcher that re-weights rubrics by deployment outcome correlation. */
export * from './predictive-validity-researcher'
/** @experimental Step-level rewards and process-reward training pairs (prefix, chosen, rejected). */
export * from './process-reward'
/** @experimental Reward-hacking signatures: reward divergence, distribution shift, judge drift. */
export * from './reward-hacking'
/** @experimental Closed-loop campaign runner: eval → preferences → mutate → re-eval. */
export * from './rl-campaign'
