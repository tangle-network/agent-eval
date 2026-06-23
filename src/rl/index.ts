/**
 * RL/data bridge.
 *
 * This subpath groups everything that turns eval output into training signal:
 * stable adapters/rewards, dataset packaging, trainer-format exporters,
 * process rewards, and closed-loop campaign research. Keeping it off the root
 * import path makes the default API smaller without hiding useful capability.
 */

/** Advanced budget allocation across (variant, scenario) cells. */
export * from './active-curriculum'
/** Advanced adaptation eval — does the policy actually learn from feedback? */
export * from './adaptation-eval'
/** Adversarial mutation contract consumed by the fuzz harness. */
export * from './adversarial'
/** @stable Compute curves: best-of-N, self-consistency, Pareto frontier across budgets. */
export * from './compute-curves'
/** @stable Held-out perturbation probes for benchmark contamination (paired Wilcoxon). */
export * from './contamination'
/** @stable Durable corpus: every eval run appends graded trajectories by default; harvest → buildRlDataset (datasets for free). */
export * from './corpus'
/** @stable Publishable/sellable dataset bundle: format exporters + provenance + a Datasheet-for-Datasets card. */
export * from './dataset'
/** Trainer-format exporters (HuggingFace datasets, JSONL, parquet). */
export * from './exporters'
/** @stable Off-policy value estimation: IPS, SNIPS, doubly-robust. */
export * from './off-policy'
/** Researcher that re-weights rubrics by deployment outcome correlation. */
export * from './predictive-validity-researcher'
/** @stable (chosen, rejected) preference triples for DPO / KTO / PPO. */
export * from './preferences'
/** Step-level rewards and process-reward training pairs. */
export * from './process-reward'
/** Reward-hacking signatures: reward divergence, distribution shift, judge drift. */
export * from './reward-hacking'
/** Closed-loop campaign runner: eval → preferences → mutate → re-eval. */
export * from './rl-campaign'
/** @stable Canonical `RunRecord` adapters: trials → records, verification reports → records. */
export * from './run-record-adapters'
/** Simulator fidelity between simulated and production RunRecords. */
export * from './sim-fidelity'
/** @stable Bradley-Terry MLE + online Elo for pairwise tournament ratings. */
export * from './tournament'
/** @stable Verifiable reward extraction (compile / test / schema) with judge-noise filtering. */
export * from './verifiable-reward'

// ── Deployment-outcome store (predictive-validity calibration) ──────
// Promoted to public so external consumers don't have to inline the
// `InMemoryOutcomeStore` + `DeploymentOutcome` shapes that
// `predictive-validity-researcher` already consumes. Closes the gap
// physim's `validate-rubrics.ts` was working around by re-implementing.

/** @stable In-memory + filesystem stores for deployment outcomes;
 *  consumed by `predictive-validity-researcher` to calibrate the gate
 *  against observed downstream metrics, not just held-out judge scores. */
export {
  type DeploymentOutcome,
  FileSystemOutcomeStore,
  type FileSystemOutcomeStoreOptions,
  InMemoryOutcomeStore,
  type OutcomeStore,
} from '../meta-eval/outcome-store'
