/**
 * `runRLCampaign` — top-level orchestrator that runs the matrix and
 * produces every RL-ready artifact in one call.
 *
 * Wires:
 *   1. `runEvalCampaign` for the matrix run (capture, integrity, hooks)
 *   2. `extractVerifiableRewardsFromRecords` over the runs, separating deterministic
 *      from probabilistic reward sources for the trainer
 *   3. `extractPreferences` to produce DPO/PPO/KTO triples
 *   4. `evaluateInterimReleaseConfidence` over paired deltas (anytime-valid)
 *   5. `rubricPredictiveValidity` against an outcome store, when provided
 *   6. `detectRewardHacking` as a standing hygiene check
 *   7. Trainer-format export rows ready for prime-rl / TRL / verl
 *
 * The output `RLCampaignResult` is a single, audit-ready artifact: every
 * stage's output is in there. The consumer's downstream fits in a single
 * line: pass `result.preferences.pairs` to a DPO trainer,
 * `result.trainerRows.grpo` to GRPO, or `result.campaign.runs` plus
 * `result.rewardSignals` to a custom RL loop.
 */

import {
  type EvalCampaignOptions,
  type EvalCampaignResult,
  type FailedRun,
  runEvalCampaign,
} from '../eval-campaign'
import type { OutcomeStore } from '../meta-eval/outcome-store'
import {
  type RubricPredictiveValidityReport,
  rubricPredictiveValidity,
} from '../meta-eval/rubric-predictive-validity'
import { mintRolloutRows } from '../rollout/mint'
import { type RunRecord, runTaskScore } from '../run-record'
import { evaluateInterimReleaseConfidence, type InterimReleaseConfidence } from '../sequential'
import { InMemoryTraceStore } from '../trace/store'
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
  sequential?: {
    alpha?: number
    bound?: number
    rope?: { low: number; high: number }
    /**
     * Smallest acceptable `answered / dealt` fraction of paired cells, required
     * of EVERY candidate before the interim verdict is computed at all. Default
     * 1: every cell the comparison was dealt must carry a score on both arms.
     *
     * The default is 1 because `recommendation.decision` can be `promote_now`,
     * and a recommendation computed over "the cells that happened to pair" is
     * computed over a set the candidate selected by failing. Below this,
     * `interimConfidence` is null and `deltaCoverage` says by how much — never a
     * silent 0. Must be in [0, 1]; anything else throws rather than clamping.
     */
    minDeltaCoverage?: number
  }
  /** Trainer-format export lookups. When provided, the orchestrator builds the corresponding rows. */
  trainerExport?: {
    dpo?: DpoLookups
    grpo?: GrpoLookups
    sft?: SftLookups
  }
}

/**
 * How much of one candidate's DEALT paired work produced a usable delta.
 *
 * `answered + unscoredCandidate + unscoredComparator + unmatched === dealt` — a
 * complete, mutually exclusive partition of the (scenarioId, seed) cells the
 * comparison was dealt, so no cell can leave the delta series without appearing
 * in exactly one bucket.
 */
export interface PairedDeltaCoverage {
  candidateId: string
  /** Cells the comparison was dealt: a run on either arm. */
  dealt: number
  /** Dealt cells scored on BOTH arms — the deltas the verdict is read from. */
  answered: number
  /** Dealt cells this candidate ran and produced no usable score for. */
  unscoredCandidate: number
  /** Dealt cells the comparator ran and produced no usable score for. */
  unscoredComparator: number
  /** Dealt cells only one of the two arms produced a run for. */
  unmatched: number
  /** `answered / dealt`, or 0 when nothing was dealt. */
  coverage: number
}

export interface RLCampaignResult {
  campaign: EvalCampaignResult
  /** Per-run verifiable reward (deterministic when available, probabilistic fallback otherwise). */
  rewardSignals: Array<{ runId: string; reward: VerifiableReward | null }>
  /** Preference extraction report. */
  preferences: PreferenceExtractionReport
  /** Anytime-valid interim verdict over the paired deltas (vs comparator).
   *  Null when no comparator was configured, when nothing paired, or when a
   *  candidate fell below `sequential.minDeltaCoverage` — read `deltaCoverage`
   *  to tell those apart. */
  interimConfidence: InterimReleaseConfidence | null
  /** Answered / dealt paired cells per candidate — the denominator behind
   *  `interimConfidence`, reported on EVERY path including the ones where the
   *  verdict was refused. Empty when no comparator was configured. */
  deltaCoverage: PairedDeltaCoverage[]
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
}

export async function runRLCampaign<V>(opts: RunRLCampaignOptions<V>): Promise<RLCampaignResult> {
  const splitTag = opts.splitTag ?? 'search'

  // ── 1. Run the matrix ──────────────────────────────────────────────
  const campaign = await runEvalCampaign({ ...opts, splitTag })

  // ── 2. Extract reward signals (deterministic-first) ────────────────
  const rewardSignals = extractVerifiableRewardsFromRecords(
    campaign.runs,
    opts.verifiableReward ?? {},
  )

  // ── 3. Mint the scored runs once, then derive all training artifacts ──
  const scoredRuns = campaign.runs.filter((run) => runTaskScore(run) !== undefined)
  const { rows: rolloutLines } = await mintRolloutRows(scoredRuns, new InMemoryTraceStore())
  const preferences = extractPreferences(rolloutLines, {
    ...opts.preferences,
    strategy: opts.preferences?.strategy ?? 'paired-by-scenario-and-seed',
    minMargin: opts.preferences?.minMargin ?? 0.05,
    split: opts.preferences?.split ?? splitTag,
  })

  // ── 4. Sequential / anytime-valid interim verdict ──────────────────
  let interimConfidence: InterimReleaseConfidence | null = null
  let deltaCoverage: PairedDeltaCoverage[] = []
  const minDeltaCoverage = opts.sequential?.minDeltaCoverage ?? 1
  if (!(Number.isFinite(minDeltaCoverage) && minDeltaCoverage >= 0 && minDeltaCoverage <= 1)) {
    throw new Error(
      `runRLCampaign: sequential.minDeltaCoverage must be a finite fraction in [0, 1], got ${minDeltaCoverage}`,
    )
  }
  if (opts.report?.comparator) {
    const comparator = opts.report.comparator
    const series = collectPairedDeltaSeries(campaign.runs, campaign.failedRuns, comparator)
    deltaCoverage = series.map((s) => s.coverage)
    // Fail closed on a shrunken denominator: the recommendation can be
    // `promote_now`, so it does not get computed over the cells that happened
    // to pair. The accounting ships either way.
    const covered = series.every((s) => s.coverage.coverage >= minDeltaCoverage)
    if (covered && series.some((s) => s.deltas.length > 0)) {
      interimConfidence = evaluateInterimReleaseConfidence({
        deltaSeries: series.map(({ candidateId, deltas }) => ({ candidateId, deltas })),
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
  const trainerRows: RLCampaignResult['trainerRows'] = {}
  if (opts.trainerExport?.dpo) {
    trainerRows.dpo = await toDpoRows(preferences.pairs, opts.trainerExport.dpo, {
      lines: rolloutLines,
    })
  }
  if (opts.trainerExport?.grpo) {
    trainerRows.grpo = await toGrpoRows(rolloutLines, opts.trainerExport.grpo)
  }
  if (opts.trainerExport?.sft) {
    trainerRows.sft = await toSftRows(rolloutLines, opts.trainerExport.sft)
  }

  const summary = buildSummary({
    campaign,
    preferences,
    interimConfidence,
    deltaCoverage,
    rewardHacking,
    predictiveValidity,
  })

  return {
    campaign,
    rewardSignals,
    preferences,
    interimConfidence,
    deltaCoverage,
    rewardHacking,
    predictiveValidity,
    trainerRows,
    summary,
    kind: 'agent-eval-rl-campaign',
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Pair on (scenarioId, seed) and count what was DEALT, not only what paired.
 *
 * Every drop below used to be silent: a comparator run with no score never
 * entered the map, a candidate run with no score was skipped, and a candidate
 * cell with no comparator at the same identity was skipped. The surviving
 * deltas then flowed into `evaluateInterimReleaseConfidence`, whose
 * `recommendation.decision` can be `promote_now` — so a candidate that scored 6
 * of 26 cells could be recommended for promotion off a series of length 6, with
 * nothing in the result saying 20 cells went dark. Same defect as the promotion
 * gates, one call frame up.
 *
 * The denominator is MEASURED: a cell counts as dealt because a run for it
 * exists on either arm. Missing scores are not imputed — the caller who knows
 * the failure value of its metric writes it onto the record.
 */
function collectPairedDeltaSeries(
  runs: RunRecord[],
  failedRuns: FailedRun[],
  comparator: string,
): Array<{ candidateId: string; deltas: number[]; coverage: PairedDeltaCoverage }> {
  const cellKey = (r: { scenarioId: string; seed: number }) => `${r.scenarioId}::${r.seed}`
  // A cell that failed integrity or crashed never reaches `campaign.runs` at
  // all, so counting only the surviving records would make the very failure this
  // check exists to catch invisible. `failedRuns` carries the same
  // (variantId, scenarioId, seed) identity — it is dealt work that produced no
  // score, which is exactly what the denominator must hold.
  const dealtFromFailures = new Map<string, Set<string>>()
  for (const f of failedRuns) {
    let set = dealtFromFailures.get(f.variantId)
    if (!set) {
      set = new Set<string>()
      dealtFromFailures.set(f.variantId, set)
    }
    set.add(cellKey(f))
  }
  // Comparator side, split into what it was dealt and what it answered.
  const comparatorDealt = new Set<string>(dealtFromFailures.get(comparator) ?? [])
  const comparatorScore = new Map<string, number>()
  for (const r of runs) {
    if (r.candidateId !== comparator) continue
    const key = cellKey(r)
    comparatorDealt.add(key)
    // Ungated (`runTaskScore` is raw): this is a measurement of the paired
    // delta between candidates, not a value any trainer consumes. Gating it
    // would report a candidate as worse than it measured; the gamed run should
    // be excluded upstream instead.
    const score = runTaskScore(r)
    if (score === undefined) continue
    comparatorScore.set(key, score)
  }
  const dealtByCandidate = new Map<string, Set<string>>()
  const scoreByCandidate = new Map<string, Map<string, number>>()
  for (const [variantId, cells] of dealtFromFailures) {
    if (variantId === comparator) continue
    dealtByCandidate.set(variantId, new Set(cells))
  }
  for (const r of runs) {
    if (r.candidateId === comparator) continue
    const key = cellKey(r)
    let dealt = dealtByCandidate.get(r.candidateId)
    if (!dealt) {
      dealt = new Set<string>()
      dealtByCandidate.set(r.candidateId, dealt)
    }
    dealt.add(key)
    const score = runTaskScore(r)
    if (score === undefined) continue
    let scored = scoreByCandidate.get(r.candidateId)
    if (!scored) {
      scored = new Map<string, number>()
      scoreByCandidate.set(r.candidateId, scored)
    }
    scored.set(key, score)
  }

  return [...dealtByCandidate.entries()].map(([candidateId, candidateDealt]) => {
    const scored = scoreByCandidate.get(candidateId) ?? new Map<string, number>()
    const deltas: number[] = []
    let unscoredCandidate = 0
    let unscoredComparator = 0
    let unmatched = 0
    // The dealt set is the union: a cell the comparator ran and this candidate
    // never wrote a row for is still work the comparison was given.
    for (const key of new Set([...candidateDealt, ...comparatorDealt])) {
      const onCandidate = candidateDealt.has(key)
      const onComparator = comparatorDealt.has(key)
      if (!onCandidate || !onComparator) {
        unmatched += 1
        continue
      }
      const a = scored.get(key)
      const b = comparatorScore.get(key)
      if (a === undefined) unscoredCandidate += 1
      else if (b === undefined) unscoredComparator += 1
      else deltas.push(a - b)
    }
    const dealt = new Set([...candidateDealt, ...comparatorDealt]).size
    return {
      candidateId,
      deltas,
      coverage: {
        candidateId,
        dealt,
        answered: deltas.length,
        unscoredCandidate,
        unscoredComparator,
        unmatched,
        coverage: dealt === 0 ? 0 : deltas.length / dealt,
      },
    }
  })
}

function buildSummary(args: {
  campaign: EvalCampaignResult
  preferences: PreferenceExtractionReport
  interimConfidence: InterimReleaseConfidence | null
  deltaCoverage: PairedDeltaCoverage[]
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
  // Never a silent 0 — a shrunken denominator has to say by how much, including
  // (especially) on the path where the verdict was refused for being shrunken.
  const shortfall = args.deltaCoverage.filter((c) => c.answered < c.dealt)
  if (shortfall.length > 0) {
    lines.push(
      `paired-delta coverage: ${shortfall
        .map((c) => `${c.candidateId} ${c.answered}/${c.dealt}`)
        .join(', ')}${args.interimConfidence ? '' : ' (sequential verdict withheld)'}`,
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
