/**
 * Process reward extraction — step-level credit assignment from trace spans.
 *
 * RL on long-horizon agents needs *step-level* rewards, not run-level
 * ones. The classic credit-assignment problem (Sutton & Barto) requires
 * knowing which sub-decisions in a trajectory contributed to the
 * outcome. Modern systems (DeepSeek-R1, OpenAI o-series, Lightman et al.
 * "Let's Verify Step by Step" 2023) train *process reward models* (PRMs)
 * that score every step, then do RL with the PRM as the reward signal.
 *
 * This module extracts `StepReward[]` from trace spans — one per
 * meaningful step — and ships:
 *
 *   1. `extractStepRewards(store, runId, opts)` — span → step-reward
 *      conversion using configurable per-span scorers (LLM judge over the
 *      span output, deterministic checkers, or a learned PRM).
 *   2. `runwiseStepRewardSummary(stepRewards)` — aggregate the per-step
 *      signal into a credit-assignment-aware run-level score.
 *   3. `prmTrainingPairs(stepRewards, options)` — produce the
 *      `(prefix, suffix_chosen, suffix_rejected)` triples that PRM
 *      training pipelines consume.
 *
 * What we ship: the *extraction* and *aggregation* infrastructure plus
 * the data shape PRM training expects. We do NOT ship the actual PRM
 * training (gradient descent over a transformer is out of scope for a
 * TS package). The interface is the contract; downstream consumers wire
 * their preferred trainer.
 *
 * Caveat the panel will land: this is descriptive credit assignment
 * (which steps correlate with outcome), not causal credit assignment
 * (which steps caused outcome). For causal claims you need
 * counterfactual rollouts or a learned dynamics model. Future work; the
 * descriptive version is what production PRM training actually uses.
 */

import type { Span } from '../trace/schema'
import type { TraceStore } from '../trace/store'

export interface StepReward {
  /** Trace span this reward attaches to. */
  spanId: string
  runId: string
  /** Index in the trajectory (0-based, in started-at order). */
  stepIndex: number
  /** Span kind (typically 'tool', 'llm', 'judge'). */
  kind: Span['kind']
  /** Span name — for the consumer's downstream filtering. */
  name: string
  /** Step-level reward in [0, 1]. */
  reward: number
  /**
   * Determinism class. Mirrors the verifiable-reward distinction:
   * deterministic = test/compile/schema check; probabilistic = LLM judge.
   */
  determinism: 'deterministic' | 'probabilistic'
  /** Optional rationale / evidence — the trainer typically discards. */
  rationale?: string
  /** Optional weight — how much this step contributes to credit assignment. */
  weight?: number
}

export interface StepScorer {
  /** Span kinds this scorer applies to. */
  appliesTo: Span['kind'][]
  /** Returns null to skip the span; returns a `StepReward` shape (without index/runId/spanId, which are filled in). */
  score(span: Span): Promise<Omit<StepReward, 'spanId' | 'runId' | 'stepIndex'>> | null | undefined
}

export interface ExtractStepRewardsOptions {
  /**
   * Ordered list of scorers. Each span runs through scorers in order;
   * the first non-null result wins. If no scorer applies, the span is
   * skipped (not all spans are training-worthy).
   */
  scorers: StepScorer[]
  /** Optional filter — return null to drop the span entirely before scoring. */
  preFilter?: (span: Span) => boolean
}

export async function extractStepRewards(
  store: TraceStore,
  runId: string,
  opts: ExtractStepRewardsOptions,
): Promise<StepReward[]> {
  const spans = await store.spans({ runId })
  const ordered = [...spans].sort((a, b) => a.startedAt - b.startedAt)
  const out: StepReward[] = []
  let idx = 0
  for (const span of ordered) {
    if (opts.preFilter && !opts.preFilter(span)) continue
    let scored: Awaited<ReturnType<StepScorer['score']>> = null
    for (const s of opts.scorers) {
      if (!s.appliesTo.includes(span.kind)) continue
      const r = await s.score(span)
      if (r) {
        scored = r
        break
      }
    }
    if (!scored) continue
    out.push({
      spanId: span.spanId,
      runId,
      stepIndex: idx++,
      kind: span.kind,
      name: span.name,
      reward: scored.reward,
      determinism: scored.determinism,
      rationale: scored.rationale,
      weight: scored.weight,
    })
  }
  return out
}

export interface RunwiseStepSummary {
  runId: string
  totalSteps: number
  meanReward: number
  /** Sum-of-rewards (weighted by `weight ?? 1`). Use as the run-level proxy. */
  sumWeightedReward: number
  /** Fraction of steps where reward < 0.5 — proxy for "where the policy was wrong." */
  failureFraction: number
  /** Maximum drop in reward between consecutive steps — diagnoses a step where things went sideways. */
  worstStepDelta: number
  worstStepIndex: number | null
}

export function runwiseStepRewardSummary(stepRewards: StepReward[]): RunwiseStepSummary {
  if (stepRewards.length === 0) {
    return {
      runId: '',
      totalSteps: 0,
      meanReward: 0,
      sumWeightedReward: 0,
      failureFraction: 0,
      worstStepDelta: 0,
      worstStepIndex: null,
    }
  }
  const runId = stepRewards[0]!.runId
  let sumW = 0
  let sumWR = 0
  let failures = 0
  let worstDelta = 0
  let worstIdx: number | null = null
  let prev = stepRewards[0]!.reward
  for (let i = 0; i < stepRewards.length; i++) {
    const s = stepRewards[i]!
    const w = s.weight ?? 1
    sumW += w
    sumWR += w * s.reward
    if (s.reward < 0.5) failures++
    if (i > 0) {
      const delta = s.reward - prev
      if (delta < worstDelta) {
        worstDelta = delta
        worstIdx = i
      }
      prev = s.reward
    } else {
      prev = s.reward
    }
  }
  return {
    runId,
    totalSteps: stepRewards.length,
    meanReward: sumW === 0 ? 0 : sumWR / sumW,
    sumWeightedReward: sumWR,
    failureFraction: failures / stepRewards.length,
    worstStepDelta: worstDelta,
    worstStepIndex: worstIdx,
  }
}

export interface PrmTrainingTriple {
  /** Prefix run-id (or composite key) — the trajectory up to step k-1. */
  prefixRunId: string
  prefixStepIndex: number
  /** The step that came next on a high-reward trajectory. */
  chosenSpanId: string
  chosenReward: number
  /** A step from a divergent low-reward trajectory at the same prefix length. */
  rejectedSpanId: string
  rejectedReward: number
  /** The prefix run came from this run; the rejected step came from `rejectedRunId`. */
  rejectedRunId: string
  marginScore: number
}

/**
 * Build PRM training triples. The shape: pair runs that share an early
 * prefix (same scenario, same first N steps) and diverge later — at the
 * point of divergence, the high-reward run's next step is `chosen`, the
 * low-reward run's next step is `rejected`. This is the canonical PRM
 * training data shape from Lightman et al. and DeepSeek-R1 process
 * supervision.
 *
 * Implementation note: we don't have a way to detect "same prefix" in
 * the general agent setting (token-level prefixes require hashing model
 * outputs). The current heuristic groups by `(scenarioId, prefixSpanName
 * sequence)` — runs are paired when their first K span names match. For
 * production use this should be replaced with a proper trajectory-prefix
 * hash; the heuristic is good enough for early-stage scaffolding.
 */
export function prmTrainingPairs(
  stepRewardsByRun: Map<string, StepReward[]>,
  opts: { minMargin?: number; minPrefixLength?: number } = {},
): PrmTrainingTriple[] {
  const minMargin = opts.minMargin ?? 0.2
  const minPrefix = opts.minPrefixLength ?? 1
  const runs = [...stepRewardsByRun.entries()].map(([runId, steps]) => ({ runId, steps }))
  const triples: PrmTrainingTriple[] = []

  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i]!
      const b = runs[j]!
      const minLen = Math.min(a.steps.length, b.steps.length)
      if (minLen < minPrefix + 1) continue

      // Find the first index where the trajectories diverge: either by
      // step structure (kind/name mismatch) OR by reward gap ≥ minMargin.
      // Names that match but rewards that differ ARE divergence — that's
      // the canonical PRM training case (same step structure, different
      // outcomes via state/context).
      let divergenceIdx = -1
      for (let k = 0; k < minLen; k++) {
        const sa = a.steps[k]!
        const sb = b.steps[k]!
        const structuralDivergence = sa.kind !== sb.kind || sa.name !== sb.name
        const rewardGap = Math.abs(sa.reward - sb.reward)
        if (structuralDivergence || rewardGap >= minMargin) {
          divergenceIdx = k
          break
        }
      }
      if (divergenceIdx < 0) continue
      if (divergenceIdx < minPrefix) continue

      const aNext = a.steps[divergenceIdx]!
      const bNext = b.steps[divergenceIdx]!
      const margin = Math.abs(aNext.reward - bNext.reward)
      if (margin < minMargin) continue

      const chosen = aNext.reward > bNext.reward ? aNext : bNext
      const rejected = aNext.reward > bNext.reward ? bNext : aNext
      const chosenRun = aNext.reward > bNext.reward ? a.runId : b.runId
      const rejectedRun = aNext.reward > bNext.reward ? b.runId : a.runId
      triples.push({
        prefixRunId: chosenRun,
        prefixStepIndex: divergenceIdx - 1,
        chosenSpanId: chosen.spanId,
        chosenReward: chosen.reward,
        rejectedSpanId: rejected.spanId,
        rejectedReward: rejected.reward,
        rejectedRunId: rejectedRun,
        marginScore: chosen.reward - rejected.reward,
      })
    }
  }
  return triples
}
