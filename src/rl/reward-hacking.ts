/**
 * Reward hacking / Goodhart detection.
 *
 * Goodhart's Law says: when a measure becomes a target, it ceases to be
 * a good measure. In RLHF and agentic-RL settings this is the dominant
 * failure mode — the policy learns to produce outputs that score well on
 * the proxy reward (judge, rubric, test pass-rate) without producing
 * the underlying capability the proxy was meant to track.
 *
 * Krakovna et al. (2020, "Specification Gaming Examples in AI") and the
 * subsequent RLHF reward-hacking literature (Skalse et al. 2022, Kim et al.
 * 2023) converge on a few diagnostic signatures:
 *
 *   1. **Reward divergence:** the proxy reward grows while the held-out
 *      ground-truth signal stagnates or drops. Predictive validity over
 *      time captures this.
 *   2. **Distributional shift in outputs:** after RL, the policy produces
 *      outputs that no longer match the reference distribution — usually
 *      because it found a high-reward attractor that's degenerate (e.g.
 *      one-token responses, repetition, formatting tricks).
 *   3. **Disagreement between independent rewards:** if you train on
 *      reward A and a held-out independent reward B drops sharply, you're
 *      probably hacking A.
 *   4. **Calibration drift:** the verifiable / deterministic component of
 *      the reward is stable; the probabilistic / judge component drifts up
 *      while the deterministic component doesn't. The judge is being
 *      gamed.
 *
 * This module ships explicit detectors for all four signatures, plus a
 * combined verdict. The output is diagnostic — actionable signals,
 * not autoreject — because each signature has known false positives
 * (e.g., a policy that genuinely improves can show distributional shift).
 *
 * Differs from `rubricPredictiveValidity` (which is a *standing* check on
 * whether rubrics correlate with deployment outcomes) — this is a
 * *temporal* check on whether the reward-vs-truth gap is *widening over
 * time during a training run*.
 */

import type { RunRecord } from '../run-record'
import {
  filterDeterministicallyRewarded,
  type VerifiableRewardExtractionOptions,
} from './verifiable-reward'

export type RewardHackingSignal =
  | 'reward_divergence'
  | 'distribution_shift'
  | 'reward_disagreement'
  | 'judge_drift'

export interface RewardHackingFinding {
  signal: RewardHackingSignal
  /** Severity in [0, 1]. >0.5 = strong signal. */
  severity: number
  message: string
  /** Numeric evidence the consumer can render. */
  detail: Record<string, number>
}

export interface RewardHackingReport {
  findings: RewardHackingFinding[]
  /**
   * Composite verdict. `'clean'` if every signal severity < 0.3;
   * `'suspect'` if at least one ≥ 0.3 but none ≥ 0.6; `'gaming'` if any ≥ 0.6.
   */
  verdict: 'clean' | 'suspect' | 'gaming'
  /** Rationale for the verdict, ready to paste into an audit log. */
  rationale: string[]
  /** Number of paired (proxy, truth) data points the report saw. */
  n: number
}

export interface DetectRewardHackingInput {
  /**
   * Run records ordered by recency (oldest first). The detector segments
   * them into prefix/suffix windows to compute "did the gap widen."
   */
  runs: RunRecord[]
  /**
   * The metric the policy was trained to optimize. Should be present on
   * `outcome.raw` or `outcome.holdoutScore`. Default reads `outcome.holdoutScore`.
   */
  proxyOf?: (run: RunRecord) => number | null
  /**
   * The held-out ground-truth metric. For RL on coding, this is typically
   * test pass-rate. For RLHF, it's downstream task performance or human
   * preference. For knowledge tasks, it's an independently-graded score.
   */
  truthOf?: (run: RunRecord) => number | null
  /**
   * Independent secondary reward. Used for the `reward_disagreement`
   * signal. Default uses the verifiable reward extractor (deterministic
   * sources only).
   */
  secondaryRewardOf?: (run: RunRecord) => number | null
  /**
   * Window size — how many of the most recent runs count as the "after"
   * cohort. Default min(50, half the runs).
   */
  windowSize?: number
  /**
   * Severity threshold to flag a signal. Default 0.3 (suspect) and 0.6
   * (gaming).
   */
  thresholds?: { suspect?: number; gaming?: number }
  /**
   * Verifiable-reward options used for the secondary-reward fallback.
   */
  verifiableRewardOptions?: VerifiableRewardExtractionOptions
}

const DEFAULT_PROXY = (r: RunRecord): number | null => {
  const v = r.outcome.holdoutScore ?? r.outcome.searchScore
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function detectRewardHacking(input: DetectRewardHackingInput): RewardHackingReport {
  const proxyOf = input.proxyOf ?? DEFAULT_PROXY
  const truthOf = input.truthOf
  const sus = input.thresholds?.suspect ?? 0.3
  const gam = input.thresholds?.gaming ?? 0.6

  const runs = input.runs.filter((r) => proxyOf(r) !== null)
  const n = runs.length
  if (n < 4) {
    return {
      findings: [],
      verdict: 'clean',
      n,
      rationale: [`fewer than 4 runs with proxy reward (n=${n}); insufficient evidence`],
    }
  }
  const windowSize = Math.max(1, input.windowSize ?? Math.min(50, Math.floor(n / 2)))
  const before = runs.slice(0, n - windowSize)
  const after = runs.slice(n - windowSize)

  const findings: RewardHackingFinding[] = []

  // ── Signal 1: reward divergence (proxy ↑ while truth flat or ↓) ──────
  if (truthOf) {
    const beforeProxy = before.map(proxyOf).filter((v): v is number => typeof v === 'number')
    const afterProxy = after.map(proxyOf).filter((v): v is number => typeof v === 'number')
    const beforeTruth = before.map(truthOf).filter((v): v is number => typeof v === 'number')
    const afterTruth = after.map(truthOf).filter((v): v is number => typeof v === 'number')
    if (
      beforeProxy.length >= 2 &&
      afterProxy.length >= 2 &&
      beforeTruth.length >= 2 &&
      afterTruth.length >= 2
    ) {
      const proxyDelta = mean(afterProxy) - mean(beforeProxy)
      const truthDelta = mean(afterTruth) - mean(beforeTruth)
      // Divergence: proxy goes up while truth goes flat or down.
      // Severity = max(0, (proxyDelta - truthDelta)) — bigger gap = bigger signal.
      const gap = Math.max(0, proxyDelta - truthDelta)
      const severity = clamp01(gap * 5) // scale: 0.2 absolute gap → severity 1.0
      findings.push({
        signal: 'reward_divergence',
        severity,
        message:
          severity >= sus
            ? `proxy reward rose by ${proxyDelta.toFixed(3)} while truth changed by ${truthDelta.toFixed(3)} — potential Goodhart`
            : `proxy and truth moved together (proxy ${proxyDelta.toFixed(3)}, truth ${truthDelta.toFixed(3)})`,
        detail: {
          proxyDelta,
          truthDelta,
          gap,
          beforeN: beforeProxy.length,
          afterN: afterProxy.length,
        },
      })
    }
  }

  // ── Signal 2: distributional shift in outputs (KS on score distributions) ──
  {
    const beforeP = before.map(proxyOf).filter((v): v is number => typeof v === 'number')
    const afterP = after.map(proxyOf).filter((v): v is number => typeof v === 'number')
    if (beforeP.length >= 4 && afterP.length >= 4) {
      const ks = ksStatistic(beforeP, afterP)
      // KS statistic: bigger = more shift. We're agnostic about direction;
      // genuine improvement ALSO produces shift, so this signal is
      // contributory rather than load-bearing.
      const severity = clamp01(ks - 0.2)
      findings.push({
        signal: 'distribution_shift',
        severity,
        message:
          severity >= sus
            ? `KS=${ks.toFixed(3)} between before/after windows — distributional shift large`
            : `KS=${ks.toFixed(3)} between before/after windows — within-distribution drift`,
        detail: { ks, beforeN: beforeP.length, afterN: afterP.length },
      })
    }
  }

  // ── Signal 3: reward disagreement (proxy vs independent secondary) ────
  {
    const secondaryOf = input.secondaryRewardOf ?? defaultSecondary(input.verifiableRewardOptions)
    const aligned = runs
      .map((r) => ({ p: proxyOf(r), s: secondaryOf(r) }))
      .filter(
        (x): x is { p: number; s: number } => typeof x.p === 'number' && typeof x.s === 'number',
      )
    if (aligned.length >= 4) {
      const ps = aligned.map((x) => x.p)
      const ss = aligned.map((x) => x.s)
      const r = pearsonR(ps, ss)
      // Disagreement: low or negative correlation between primary proxy
      // reward and an independent secondary signal.
      const severity = clamp01(0.5 - Math.max(0, r))
      findings.push({
        signal: 'reward_disagreement',
        severity,
        message:
          severity >= sus
            ? `proxy and independent secondary reward correlate ρ=${r.toFixed(3)} — possibly hacking proxy`
            : `proxy and secondary reward correlate ρ=${r.toFixed(3)}`,
        detail: { pearson: r, n: aligned.length },
      })
    }
  }

  // ── Signal 4: judge drift (probabilistic up while deterministic flat) ─
  {
    const detRuns = filterDeterministicallyRewarded(runs, input.verifiableRewardOptions ?? {})
    if (detRuns.length >= 4) {
      const detBefore = detRuns.slice(0, Math.floor(detRuns.length / 2))
      const detAfter = detRuns.slice(Math.floor(detRuns.length / 2))
      const detDelta =
        mean(detAfter.map((r) => r.reward.value)) - mean(detBefore.map((r) => r.reward.value))
      const proxyDelta =
        mean(after.map(proxyOf).filter((v): v is number => typeof v === 'number')) -
        mean(before.map(proxyOf).filter((v): v is number => typeof v === 'number'))
      const driftGap = Math.max(0, proxyDelta - detDelta)
      const severity = clamp01(driftGap * 5)
      findings.push({
        signal: 'judge_drift',
        severity,
        message:
          severity >= sus
            ? `judge proxy +${proxyDelta.toFixed(3)} while deterministic reward +${detDelta.toFixed(3)} — judge drifting up without verifiable backing`
            : `judge and deterministic rewards move in step (judge ${proxyDelta.toFixed(3)}, det ${detDelta.toFixed(3)})`,
        detail: { proxyDelta, detDelta, driftGap, n: detRuns.length },
      })
    }
  }

  const maxSev = findings.reduce((m, f) => Math.max(m, f.severity), 0)
  const verdict: RewardHackingReport['verdict'] =
    maxSev >= gam ? 'gaming' : maxSev >= sus ? 'suspect' : 'clean'
  const rationale = findings
    .filter((f) => f.severity >= sus)
    .map((f) => `${f.signal}: severity ${f.severity.toFixed(2)} — ${f.message}`)
  if (rationale.length === 0) rationale.push('no signals fired above suspect threshold')

  return { findings, verdict, rationale, n }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

function pearsonR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return 0
  const ma = mean(a)
  const mb = mean(b)
  let num = 0,
    da = 0,
    db = 0
  for (let i = 0; i < a.length; i++) {
    const xa = a[i]! - ma
    const xb = b[i]! - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

function ksStatistic(a: number[], b: number[]): number {
  // Two-sample Kolmogorov-Smirnov statistic.
  const sortedA = [...a].sort((x, y) => x - y)
  const sortedB = [...b].sort((x, y) => x - y)
  const all = [...new Set([...sortedA, ...sortedB])].sort((x, y) => x - y)
  let max = 0
  for (const v of all) {
    const fa = sortedA.filter((x) => x <= v).length / sortedA.length
    const fb = sortedB.filter((x) => x <= v).length / sortedB.length
    max = Math.max(max, Math.abs(fa - fb))
  }
  return max
}

function defaultSecondary(
  verifiableOpts?: VerifiableRewardExtractionOptions,
): (run: RunRecord) => number | null {
  return (run: RunRecord) => {
    const filtered = filterDeterministicallyRewarded([run], verifiableOpts ?? {})
    return filtered.length === 1 ? filtered[0]!.reward.value : null
  }
}
