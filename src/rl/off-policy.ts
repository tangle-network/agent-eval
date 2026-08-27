/**
 * Off-policy evaluation primitives.
 *
 * Standard inverse-probability-weighted (IPS), self-normalized
 * importance-weighted (SNIPS), and doubly-robust (DR) estimators for the
 * value of a *target* policy given trajectories collected under a
 * *behavior* policy. This is the canonical RL eval task: "we have last
 * week's runs, we changed the policy — how would the new one do without
 * re-running?"
 *
 * The math here is textbook (Dudík, Langford, Li 2011 for DR; Swaminathan
 * & Joachims 2015 for SNIPS) but the *application* to LLM-agent
 * evaluation needs care:
 *
 *   - The "policy" is the (prompt, tool config, model snapshot) triple.
 *     Two policies have the same probability over an action *iff* their
 *     LLM call would emit the same token with the same probability —
 *     which is generally unknowable without the model log-probs.
 *   - For LLM agents, propensity scores must be supplied by the caller
 *     (logged in the trace, recovered from token log-probs, or estimated
 *     via a learned propensity model). We do NOT estimate propensity here.
 *   - Doubly-robust requires two outputs from a Q-function: its prediction
 *     for the logged action and its expectation under the target policy.
 *     Consumers compute these with a tabular estimate, regression fit, or
 *     learned reward model before constructing the trajectories.
 *
 * Bias / variance tradeoffs:
 *   - IPS: unbiased; high variance for small overlap, infinite variance
 *     when target has support outside behavior.
 *   - SNIPS: lower variance, slight bias; usually preferred in practice.
 *   - DR: doubly-robust — unbiased if either propensity OR Q-function is
 *     correct. Lowest practical variance when Q is decent. Use this.
 *
 * Caveat the panel will land: on the LLM-agent setting, propensity scores
 * recovered from token log-probs are noisy, the action space is enormous,
 * and overlap is often poor. These estimators are useful but not magic;
 * complement with `replayCampaign` (exact replay where the request hashes
 * match) for high-confidence answers and OPE for the gap.
 */

import { ValidationError } from '../errors'

export interface OffPolicyTrajectory {
  /** Stable id, for traceability through the dataset. */
  runId: string
  /** Reward observed under the behavior policy (the realized outcome). */
  reward: number
  /**
   * Behavior-policy probability of the action that was taken. For LLM
   * agents this is typically `exp(sum(token_log_probs))` over the chosen
   * trajectory. Must be in (0, 1].
   */
  behaviorProb: number
  /**
   * Target-policy probability of the same action. For replay-style
   * counterfactual evaluation this is what the *new* policy would have
   * assigned to the *old* trajectory. Must be in [0, 1].
   */
  targetProb: number
  /**
   * Model-based reward prediction for the action selected by the behavior
   * policy: `Q_hat(context, loggedAction)`. Supply this together with
   * `vHatTarget` for contextual-bandit doubly-robust estimation.
   */
  qHatChosen?: number | null
  /**
   * Expected model-based reward under the target policy:
   * `sum_action targetPolicy(action | context) * Q_hat(context, action)`.
   * Supply this together with `qHatChosen`. For an honest evaluation, both
   * values must come from a model cross-fitted or trained outside this row.
   */
  vHatTarget?: number | null
  /**
   * @deprecated Use `qHatChosen` and `vHatTarget` together. When the new pair
   * is absent, this scalar is used as both terms to preserve existing results.
   * When the new pair is present, this field is ignored.
   */
  qHat?: number | null
}

export interface OffPolicyContributionCounts {
  /** Contributions using the contextual-bandit doubly-robust formula. */
  dr: number
  /** Contributions using exact IPS because no reward-model estimate was supplied. */
  ipsFallback: number
  /** Contributions using the deprecated single-scalar formula. */
  legacyScalar: number
}

export interface OffPolicyEstimate {
  /** Estimated value of the target policy. */
  value: number
  /** Standard error of the estimate. */
  standardError: number
  /** Effective sample size (Kong 1992). Lower = more reliance on a few high-weight samples. */
  effectiveSampleSize: number
  /** Number of trajectories used. */
  n: number
  /**
   * Diagnostic: maximum importance weight observed. Large values (>>10x
   * mean) are a red flag — variance is dominated by a few outliers.
   */
  maxImportanceWeight: number
  /** Populated by `doublyRobust` to expose which formula each row used. */
  contributionCounts?: OffPolicyContributionCounts
}

export interface OffPolicyOptions {
  /**
   * Cap importance weights at this value (Ionides 2008 truncated IS) to
   * trade unbiasedness for variance reduction. Default `Infinity` (no cap).
   * Set e.g. `10` for stable estimates when the policies are close.
   */
  weightCap?: number
  /** Reward clipping range. Default `[0, 1]`. */
  rewardClip?: { low: number; high: number }
}

/**
 * Inverse Probability Weighting (Horvitz-Thompson). Unbiased estimator
 * of E[reward under target policy]. Variance scales with the spread of
 * target/behavior ratios.
 */
export function inverseProbabilityWeighting(
  trajectories: OffPolicyTrajectory[],
  opts: OffPolicyOptions = {},
): OffPolicyEstimate {
  const cap = opts.weightCap ?? Infinity
  const clip = opts.rewardClip ?? { low: 0, high: 1 }

  if (trajectories.length === 0) {
    return zeroEstimate()
  }

  const weights: number[] = []
  const weightedRewards: number[] = []
  let maxW = 0
  for (const t of trajectories) {
    if (t.behaviorProb <= 0) {
      throw new ValidationError(
        `inverseProbabilityWeighting: behaviorProb must be > 0 (runId=${t.runId})`,
      )
    }
    const w = Math.min(cap, t.targetProb / t.behaviorProb)
    const r = clamp(t.reward, clip.low, clip.high)
    weights.push(w)
    weightedRewards.push(w * r)
    if (w > maxW) maxW = w
  }
  const n = weights.length
  const value = weightedRewards.reduce((s, x) => s + x, 0) / n
  const variance = weightedRewards.reduce((s, x) => s + (x - value) ** 2, 0) / Math.max(1, n - 1)
  const sumW = weights.reduce((s, w) => s + w, 0)
  const sumW2 = weights.reduce((s, w) => s + w * w, 0)
  const effN = sumW === 0 ? 0 : (sumW * sumW) / sumW2

  return {
    value,
    standardError: Math.sqrt(variance / n),
    effectiveSampleSize: effN,
    n,
    maxImportanceWeight: maxW,
  }
}

/**
 * Self-Normalized Importance Sampling. Lower variance than vanilla IPS at
 * the cost of small bias (vanishing as N grows). The right default for
 * LLM-agent evaluation where overlap is often poor.
 */
export function selfNormalizedImportanceWeighting(
  trajectories: OffPolicyTrajectory[],
  opts: OffPolicyOptions = {},
): OffPolicyEstimate {
  const cap = opts.weightCap ?? Infinity
  const clip = opts.rewardClip ?? { low: 0, high: 1 }
  if (trajectories.length === 0) return zeroEstimate()

  const weights: number[] = []
  const rewards: number[] = []
  let maxW = 0
  for (const t of trajectories) {
    if (t.behaviorProb <= 0) {
      throw new ValidationError(
        `selfNormalizedImportanceWeighting: behaviorProb must be > 0 (runId=${t.runId})`,
      )
    }
    const w = Math.min(cap, t.targetProb / t.behaviorProb)
    weights.push(w)
    rewards.push(clamp(t.reward, clip.low, clip.high))
    if (w > maxW) maxW = w
  }
  const sumW = weights.reduce((s, w) => s + w, 0)
  const sumWR = weights.reduce((s, w, i) => s + w * rewards[i]!, 0)
  const value = sumW === 0 ? 0 : sumWR / sumW
  const sumW2 = weights.reduce((s, w) => s + w * w, 0)
  const effN = sumW === 0 ? 0 : (sumW * sumW) / sumW2
  // Influence-function-based SE for SNIPS (Owen 2013, Ch. 9).
  const phi = weights.map((w, i) => w * (rewards[i]! - value))
  const variance = phi.reduce((s, x) => s + x * x, 0) / Math.max(1, sumW * sumW)
  return {
    value,
    standardError: Math.sqrt(variance),
    effectiveSampleSize: effN,
    n: trajectories.length,
    maxImportanceWeight: maxW,
  }
}

/**
 * Doubly-robust off-policy estimator (Dudík, Langford, Li 2011).
 *
 *     V_DR = (1/N) * sum_i [ v_hat_target_i
 *              + (target_prob_i / behavior_prob_i) * (r_i - q_hat_chosen_i) ]
 *
 * Unbiased if EITHER:
 *   - the importance ratios are correct (IPS-style validity), OR
 *   - the Q-hat function is correct (model-based validity).
 *
 * In practice both are imperfect, but the residual bias is the *product*
 * of both errors — much smaller than either alone. This is why DR is the
 * default in production OPE pipelines.
 *
 * `qHatChosen` and `vHatTarget` must be supplied together. Rows with neither
 * use the exact IPS contribution. Deprecated `qHat` rows preserve the scalar
 * formula, and a complete new pair takes precedence when both forms exist.
 * `contributionCounts` makes the mix explicit in the result.
 * Callers must cross-fit the Q-function or train it on independent rows;
 * fitting and evaluating Q on the same outcomes leaks the answer.
 */
export function doublyRobust(
  trajectories: OffPolicyTrajectory[],
  opts: OffPolicyOptions = {},
): OffPolicyEstimate {
  const cap = opts.weightCap ?? Infinity
  const clip = opts.rewardClip ?? { low: 0, high: 1 }
  if (trajectories.length === 0) {
    return {
      ...zeroEstimate(),
      contributionCounts: { dr: 0, ipsFallback: 0, legacyScalar: 0 },
    }
  }

  const contributions: number[] = []
  const contributionCounts: OffPolicyContributionCounts = {
    dr: 0,
    ipsFallback: 0,
    legacyScalar: 0,
  }
  let maxW = 0
  let sumW = 0
  let sumW2 = 0
  for (const t of trajectories) {
    if (t.behaviorProb <= 0) {
      throw new ValidationError(`doublyRobust: behaviorProb must be > 0 (runId=${t.runId})`)
    }
    const w = Math.min(cap, t.targetProb / t.behaviorProb)
    const r = clamp(t.reward, clip.low, clip.high)
    const rawQHatChosen = t.qHatChosen
    const rawVHatTarget = t.vHatTarget
    const hasQHatChosen = rawQHatChosen !== null && rawQHatChosen !== undefined
    const hasVHatTarget = rawVHatTarget !== null && rawVHatTarget !== undefined
    if (hasQHatChosen !== hasVHatTarget) {
      throw new ValidationError(
        `doublyRobust: qHatChosen and vHatTarget must be supplied together (runId=${t.runId})`,
      )
    }

    if (hasQHatChosen && hasVHatTarget) {
      if (!Number.isFinite(rawQHatChosen) || !Number.isFinite(rawVHatTarget)) {
        throw new ValidationError(
          `doublyRobust: qHatChosen and vHatTarget must be finite (runId=${t.runId})`,
        )
      }
      const qHatChosen = clamp(rawQHatChosen, clip.low, clip.high)
      const vHatTarget = clamp(rawVHatTarget, clip.low, clip.high)
      contributions.push(vHatTarget + w * (r - qHatChosen))
      contributionCounts.dr += 1
    } else if (typeof t.qHat === 'number' && Number.isFinite(t.qHat)) {
      const qHat = clamp(t.qHat, clip.low, clip.high)
      contributions.push(qHat + w * (r - qHat))
      contributionCounts.legacyScalar += 1
    } else {
      contributions.push(w * r)
      contributionCounts.ipsFallback += 1
    }
    if (w > maxW) maxW = w
    sumW += w
    sumW2 += w * w
  }
  const n = contributions.length
  const value = contributions.reduce((s, x) => s + x, 0) / n
  const variance = contributions.reduce((s, x) => s + (x - value) ** 2, 0) / Math.max(1, n - 1)
  const effN = sumW === 0 ? 0 : (sumW * sumW) / sumW2
  return {
    value,
    standardError: Math.sqrt(variance / n),
    effectiveSampleSize: effN,
    n,
    maxImportanceWeight: maxW,
    contributionCounts,
  }
}

/**
 * Convenience: run all three estimators and return them side-by-side.
 * The recommended diagnostic — agreement across estimators is a much
 * stronger signal than any single one.
 */
export function offPolicyEstimateAll(
  trajectories: OffPolicyTrajectory[],
  opts: OffPolicyOptions = {},
): { ips: OffPolicyEstimate; snips: OffPolicyEstimate; dr: OffPolicyEstimate } {
  return {
    ips: inverseProbabilityWeighting(trajectories, opts),
    snips: selfNormalizedImportanceWeighting(trajectories, opts),
    dr: doublyRobust(trajectories, opts),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function zeroEstimate(): OffPolicyEstimate {
  return { value: 0, standardError: 0, effectiveSampleSize: 0, n: 0, maxImportanceWeight: 0 }
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo
  return Math.max(lo, Math.min(hi, x))
}
