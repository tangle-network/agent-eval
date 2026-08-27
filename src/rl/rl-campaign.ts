/**
 * `runRLCampaign` — top-level orchestrator that runs the matrix and
 * produces every RL-ready artifact in one call.
 *
 * Wires:
 *   1. `runEvalCampaign` for the matrix run (capture, integrity, hooks)
 *   2. `extractVerifiableReward` over each run, separating deterministic
 *      from probabilistic reward sources for the trainer
 *   3. `extractPreferences` to produce DPO/PPO/KTO triples
 *   4. `evaluateInterimReleaseConfidence` over paired deltas (anytime-valid)
 *   5. `rubricPredictiveValidity` against an outcome store, when provided
 *   6. `detectRewardHacking` as a standing hygiene check
 *   7. Trainer-format export rows ready for prime-rl / TRL / verl
 *
 * The output `RLCampaignResult` is a single, audit-ready artifact: every
 * stage's output is in there. The consumer's downstream fits in a single
 * line: pass `result.preferences` to their DPO trainer, `result.grpoRows`
 * to GRPO, `result.runs` plus `result.rewardSignals` to a custom RL loop.
 */

import {
  type EvalCampaignOptions,
  type EvalCampaignResult,
  runEvalCampaign,
} from '../eval-campaign'
import type { OutcomeStore } from '../meta-eval/outcome-store'
import {
  type RubricPredictiveValidityReport,
  rubricPredictiveValidity,
} from '../meta-eval/rubric-predictive-validity'
import type { RunRecord } from '../run-record'
import { evaluateInterimReleaseConfidence, type InterimReleaseConfidence } from '../sequential'
import {
  type DpoExportRow,
  type DpoLookups,
  type GrpoExportRow,
  type GrpoLookups,
  type SftExportRow,
  type SftLookups,
  toDpoRows,
  toGrpoRows,
  toSftRows,
} from './exporters'
import {
  type ExtractPreferencesOptions,
  extractPreferences,
  type PreferenceExtractionReport,
} from './preferences'
import { detectRewardHacking, type RewardHackingReport } from './reward-hacking'
import {
  extractVerifiableRewardsFromRecords,
  type VerifiableReward,
  type VerifiableRewardExtractionOptions,
} from './verifiable-reward'

export interface RunRLCampaignOptions<V> extends EvalCampaignOptions<V> {
  /** Preference-extraction options. Default uses paired-by-scenario-and-seed with min-margin 0.05. */
  preferences?: ExtractPreferencesOptions
  /** Verifiable-reward extraction options. */
  verifiableReward?: VerifiableRewardExtractionOptions
  /** Outcome store + metric names — when supplied, runs `rubricPredictiveValidity` post-campaign. */
  outcomeStore?: OutcomeStore
  outcomeMetrics?: string[]
  /** Anytime-valid sequential evaluation options. */
  sequential?: { alpha?: number; bound?: number; rope?: { low: number; high: number } }
  /** Trainer-format export lookups. When provided, the orchestrator builds the corresponding rows. */
  trainerExport?: {
    dpo?: DpoLookups
    grpo?: GrpoLookups
    sft?: SftLookups
  }
}

export interface RLCampaignResult<V> {
  campaign: EvalCampaignResult
  /** Per-run verifiable reward (deterministic when available, probabilistic fallback otherwise). */
  rewardSignals: Array<{ runId: string; reward: VerifiableReward | null }>
  /** Preference extraction report. */
  preferences: PreferenceExtractionReport
  /** Anytime-valid interim verdict over the paired deltas (vs comparator). */
  interimConfidence: InterimReleaseConfidence | null
  /** Standing reward-hacking hygiene check. */
  rewardHacking: RewardHackingReport
  /** Predictive validity, when an outcome store was supplied. */
  predictiveValidity: RubricPredictiveValidityReport | null
  /** Trainer-export rows, populated only for the formats the caller requested via `trainerExport`. */
  trainerRows: {
    dpo?: DpoExportRow[]
    grpo?: GrpoExportRow[]
    sft?: SftExportRow[]
  }
  /**
   * One-line top-level summary the consumer can log.
   */
  summary: string
  /**
   * Convenience type-tag — consumers can branch on `result.kind`.
   */
  kind: 'agent-eval-rl-campaign'
  unusedVariant?: V
}

export async function runRLCampaign<V>(
  opts: RunRLCampaignOptions<V>,
): Promise<RLCampaignResult<V>> {
  // ── 1. Run the matrix ──────────────────────────────────────────────
  const campaign = await runEvalCampaign(opts)

  // ── 2. Extract reward signals (deterministic-first) ────────────────
  const rewardSignals = extractVerifiableRewardsFromRecords(
    campaign.runs,
    opts.verifiableReward ?? {},
  )

  // ── 3. Extract preference triples ──────────────────────────────────
  const preferences = extractPreferences(campaign.runs, {
    strategy: opts.preferences?.strategy ?? 'paired-by-scenario-and-seed',
    minMargin: opts.preferences?.minMargin ?? 0.05,
    splitTag: opts.preferences?.splitTag ?? opts.splitTag ?? 'holdout',
    rewardOf: opts.preferences?.rewardOf,
  })

  // ── 4. Sequential / anytime-valid interim verdict ──────────────────
  let interimConfidence: InterimReleaseConfidence | null = null
  if (opts.report?.comparator) {
    const comparator = opts.report.comparator
    const deltaSeries = collectPairedDeltaSeries(campaign.runs, comparator)
    if (deltaSeries.some((s) => s.deltas.length > 0)) {
      interimConfidence = evaluateInterimReleaseConfidence({
        deltaSeries,
        alpha: opts.sequential?.alpha,
        bound: opts.sequential?.bound,
        rope: opts.sequential?.rope ?? opts.report?.rope,
      })
    }
  }

  // ── 5. Standing reward-hacking hygiene ─────────────────────────────
  const rewardHacking = detectRewardHacking({
    runs: campaign.runs,
    verifiableRewardOptions: opts.verifiableReward,
  })

  // ── 6. Predictive validity (when outcomes are supplied) ────────────
  let predictiveValidity: RubricPredictiveValidityReport | null = null
  if (opts.outcomeStore && opts.outcomeMetrics && opts.outcomeMetrics.length > 0) {
    predictiveValidity = await rubricPredictiveValidity({
      runs: campaign.runs,
      outcomes: opts.outcomeStore,
      outcomeMetrics: opts.outcomeMetrics,
    })
  }

  // ── 7. Trainer-format export ───────────────────────────────────────
  const trainerRows: RLCampaignResult<V>['trainerRows'] = {}
  if (opts.trainerExport?.dpo) {
    trainerRows.dpo = await toDpoRows(preferences.pairs, opts.trainerExport.dpo)
  }
  if (opts.trainerExport?.grpo) {
    trainerRows.grpo = await toGrpoRows(campaign.runs, opts.trainerExport.grpo)
  }
  if (opts.trainerExport?.sft) {
    trainerRows.sft = await toSftRows(campaign.runs, opts.trainerExport.sft)
  }

  const summary = buildSummary({
    campaign,
    preferences,
    interimConfidence,
    rewardHacking,
    predictiveValidity,
  })

  return {
    campaign,
    rewardSignals,
    preferences,
    interimConfidence,
    rewardHacking,
    predictiveValidity,
    trainerRows,
    summary,
    kind: 'agent-eval-rl-campaign',
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function collectPairedDeltaSeries(
  runs: RunRecord[],
  comparator: string,
): Array<{ candidateId: string; deltas: number[] }> {
  // Pair on (scenarioId, seed). For each candidate that isn't the comparator,
  // compute candidate.score - comparator.score on matching cells.
  const baseline = new Map<string, number>()
  for (const r of runs) {
    if (r.candidateId !== comparator) continue
    const sid = r.scenarioId ?? r.experimentId
    const score = r.outcome.holdoutScore ?? r.outcome.searchScore
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    baseline.set(`${sid}::${r.seed}`, score)
  }
  const byCandidate = new Map<string, number[]>()
  for (const r of runs) {
    if (r.candidateId === comparator) continue
    const sid = r.scenarioId ?? r.experimentId
    const score = r.outcome.holdoutScore ?? r.outcome.searchScore
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    const baseScore = baseline.get(`${sid}::${r.seed}`)
    if (typeof baseScore !== 'number') continue
    const arr = byCandidate.get(r.candidateId) ?? []
    arr.push(score - baseScore)
    byCandidate.set(r.candidateId, arr)
  }
  return [...byCandidate.entries()].map(([candidateId, deltas]) => ({ candidateId, deltas }))
}

function buildSummary(args: {
  campaign: EvalCampaignResult
  preferences: PreferenceExtractionReport
  interimConfidence: InterimReleaseConfidence | null
  rewardHacking: RewardHackingReport
  predictiveValidity: RubricPredictiveValidityReport | null
}): string {
  const c = args.campaign
  const lines = [
    `${c.campaignId}: ${c.runs.length} successful runs / ${c.failedRuns.length} failed (fingerprint ${c.campaignFingerprint.slice(0, 12)}…)`,
    `preferences: ${args.preferences.pairs.length} (${args.preferences.strategy}, ${args.preferences.pairsBelowMargin} below margin)`,
  ]
  if (args.interimConfidence) {
    lines.push(
      `sequential verdict: ${args.interimConfidence.recommendation.decision}` +
        (args.interimConfidence.recommendation.candidateId
          ? ` ${args.interimConfidence.recommendation.candidateId}`
          : ''),
    )
  }
  lines.push(
    `reward-hacking: ${args.rewardHacking.verdict} (${args.rewardHacking.findings.length} signals checked)`,
  )
  if (args.predictiveValidity) {
    const top = args.predictiveValidity.ranked[0]
    lines.push(
      `top-rubric: ${top?.rubric ?? 'none'} ρ=${(top?.spearman ?? 0).toFixed(2)} (${top?.verdict ?? 'no data'})`,
    )
  }
  return lines.join(' | ')
}

// Re-export `runEvalCampaign` so consumers can pick the lower-level
// primitive without flipping import paths.
export { runEvalCampaign } from '../eval-campaign'
