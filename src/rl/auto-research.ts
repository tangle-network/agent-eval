/**
 * `analyzeOptimizationResult` — unifies the pre-0.22 auto-research stack
 * (`runPromptEvolution`, `runMultiShotOptimization`, reflective-mutation,
 * Ax/AxRLM trace analyst) with the 0.23 RL bridge in a single call.
 *
 * What this fixes: until 0.23 the optimization stack and the RL bridge
 * lived in parallel namespaces. The optimization primitives produced
 * `TrialResult[]`; the RL bridge consumed `RunRecord[]`. Trace-analyst
 * was decoupled from both. `analyzeOptimizationResult` does the wiring
 * once so consumers don't have to:
 *
 *    Optimization (existing primitives)           RL bridge (0.23)
 *    ──────────────────────────────────           ────────────────
 *    runPromptEvolution → TrialResult[]    →
 *    runMultiShotOptimization → MSTrial[]  → analyzeOptimizationResult →
 *    reflective-mutation → mutations.jsonl →                             ↓
 *                                                                        │
 *    ↓ (per-generation inputs flow back)                                 │
 *    PredictiveValidityResearcher.proposeChange  ←─────────────────────  │
 *                                                                        │
 *    ↓                                                                   │
 *    TraceAnalyst.analyze(progressLog)         ←─────────────────────────┘
 *
 * The output of this function is the canonical RL artifact set:
 * `RunRecord[]` (so every other 0.22+ primitive composes), preference
 * triples, verifiable reward signals, reward-hacking diagnosis,
 * sequential interim verdict, and (when wired) trace-analyst summary.
 *
 * What this primitive does NOT do: it does not modify the optimization
 * primitives' internals. They keep producing `TrialResult` and emitting
 * `onProgress` events; this function bridges *after* the sweep completes.
 * Per-step capture-integrity (raw HTTP events from inside the score
 * adapter) requires the consumer to wire `RawProviderSink` into their
 * own `ScoreAdapter` — that's a per-consumer integration point.
 */

import {
  evaluateInterimReleaseConfidence,
  type InterimReleaseConfidence,
} from '../sequential'
import type { PromptEvolutionResult, TrialResult } from '../prompt-evolution'
import type { MultiShotOptimizationResult } from '../multi-shot-optimization'
import {
  trialsToRunRecords,
  type AdapterContext,
} from './run-record-adapters'
import {
  extractVerifiableRewardsFromRecords,
  type VerifiableReward,
  type VerifiableRewardExtractionOptions,
} from './verifiable-reward'
import {
  extractPreferences,
  type ExtractPreferencesOptions,
  type PreferenceExtractionReport,
} from './preferences'
import {
  detectRewardHacking,
  type RewardHackingReport,
} from './reward-hacking'
import {
  rubricPredictiveValidity,
  type RubricPredictiveValidityReport,
} from '../meta-eval/rubric-predictive-validity'
import type { OutcomeStore } from '../meta-eval/outcome-store'
import type { RunRecord } from '../run-record'
import {
  toDpoRows,
  toGrpoRows,
  type DpoExportRow,
  type DpoLookups,
  type GrpoExportRow,
  type GrpoLookups,
} from './exporters'

export interface AnalyzeOptimizationResultOptions {
  /**
   * The optimization output. Either a `PromptEvolutionResult` or a
   * `MultiShotOptimizationResult`. The function detects which by
   * structural typing and produces canonical `RunRecord[]` from either.
   */
  result: PromptEvolutionResult | MultiShotOptimizationResult
  /** Adapter context — `commitSha`, `model`, `promptHash`, `configHash`. */
  ctx: AdapterContext
  /** Optional comparator candidate id for paired analyses. */
  comparator?: string
  /** Verifiable-reward extraction options. */
  verifiableReward?: VerifiableRewardExtractionOptions
  /** Preference extraction options. */
  preferences?: ExtractPreferencesOptions
  /** Sequential interim-confidence options. */
  sequential?: { alpha?: number; bound?: number; rope?: { low: number; high: number } }
  /** Outcome calibration store + metrics. */
  outcomes?: { store: OutcomeStore; metrics: string[] }
  /** Trainer-format export — DPO + GRPO lookups. */
  trainerExport?: { dpo?: DpoLookups; grpo?: GrpoLookups }
}

export interface AnalyzeOptimizationResultReport {
  /** All trials promoted to canonical `RunRecord` shape. */
  runs: RunRecord[]
  /** Per-run verifiable reward signal. */
  rewardSignals: Array<{ runId: string; reward: VerifiableReward | null }>
  /** Preference triples ready for DPO/PPO/KTO training. */
  preferences: PreferenceExtractionReport
  /** Anytime-valid sequential verdict, when a comparator is supplied. */
  interimConfidence: InterimReleaseConfidence | null
  /** Standing reward-hacking hygiene check. */
  rewardHacking: RewardHackingReport
  /** Predictive validity, when an outcome store is supplied. */
  predictiveValidity: RubricPredictiveValidityReport | null
  /** Trainer-export rows, populated only for the formats requested. */
  trainerRows: { dpo?: DpoExportRow[]; grpo?: GrpoExportRow[] }
  /** One-line summary suitable for logs. */
  summary: string
}

/**
 * Convert an optimization sweep output into a fully-analysed RL artifact
 * set. Idempotent and read-only with respect to the optimization result.
 */
export async function analyzeOptimizationResult(
  opts: AnalyzeOptimizationResultOptions,
): Promise<AnalyzeOptimizationResultReport> {
  // 1. Convert trials to RunRecord[] regardless of which optimizer ran.
  const trials = extractTrials(opts.result)
  const runs = trialsToRunRecords(trials, opts.ctx)

  // 2. Verifiable reward extraction.
  const rewardSignals = extractVerifiableRewardsFromRecords(runs, opts.verifiableReward ?? {})

  // 3. Preference triples.
  const preferences = extractPreferences(runs, {
    strategy: opts.preferences?.strategy ?? 'paired-by-scenario-and-seed',
    minMargin: opts.preferences?.minMargin ?? 0.05,
    splitTag: opts.preferences?.splitTag ?? opts.ctx.splitTag ?? 'search',
    rewardOf: opts.preferences?.rewardOf,
  })

  // 4. Anytime-valid interim verdict (if comparator supplied).
  let interimConfidence: InterimReleaseConfidence | null = null
  if (opts.comparator) {
    const deltaSeries = collectPairedDeltaSeries(runs, opts.comparator)
    if (deltaSeries.some((s) => s.deltas.length > 0)) {
      interimConfidence = evaluateInterimReleaseConfidence({
        deltaSeries,
        alpha: opts.sequential?.alpha,
        bound: opts.sequential?.bound,
        rope: opts.sequential?.rope,
      })
    }
  }

  // 5. Reward-hacking diagnosis.
  const rewardHacking = detectRewardHacking({
    runs,
    verifiableRewardOptions: opts.verifiableReward,
  })

  // 6. Predictive validity (if outcomes supplied).
  let predictiveValidity: RubricPredictiveValidityReport | null = null
  if (opts.outcomes) {
    predictiveValidity = await rubricPredictiveValidity({
      runs,
      outcomes: opts.outcomes.store,
      outcomeMetrics: opts.outcomes.metrics,
    })
  }

  // 7. Trainer-format export.
  const trainerRows: AnalyzeOptimizationResultReport['trainerRows'] = {}
  if (opts.trainerExport?.dpo) {
    trainerRows.dpo = await toDpoRows(preferences.pairs, opts.trainerExport.dpo)
  }
  if (opts.trainerExport?.grpo) {
    trainerRows.grpo = await toGrpoRows(runs, opts.trainerExport.grpo)
  }

  const summary = buildSummary({ runs, preferences, interimConfidence, rewardHacking, predictiveValidity })

  return {
    runs,
    rewardSignals,
    preferences,
    interimConfidence,
    rewardHacking,
    predictiveValidity,
    trainerRows,
    summary,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractTrials(
  result: PromptEvolutionResult | MultiShotOptimizationResult,
): TrialResult[] {
  // PromptEvolutionResult shape: { generations: GenerationReport[]; ... }
  // MultiShotOptimizationResult shape: { evolution: PromptEvolutionResult; ... }
  if ('evolution' in result) {
    return collectFromEvolution(result.evolution)
  }
  return collectFromEvolution(result as PromptEvolutionResult)
}

function collectFromEvolution(evolution: PromptEvolutionResult): TrialResult[] {
  const trials: TrialResult[] = []
  for (const gen of evolution.generations) {
    for (const t of gen.trials ?? []) trials.push(t)
  }
  return trials
}

function collectPairedDeltaSeries(
  runs: RunRecord[],
  comparator: string,
): Array<{ candidateId: string; deltas: number[] }> {
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
  runs: RunRecord[]
  preferences: PreferenceExtractionReport
  interimConfidence: InterimReleaseConfidence | null
  rewardHacking: RewardHackingReport
  predictiveValidity: RubricPredictiveValidityReport | null
}): string {
  const lines: string[] = [
    `${args.runs.length} runs analysed`,
    `${args.preferences.pairs.length} preference pairs (${args.preferences.strategy})`,
    `reward-hacking verdict: ${args.rewardHacking.verdict}`,
  ]
  if (args.interimConfidence) {
    lines.push(`sequential: ${args.interimConfidence.recommendation.decision}` +
      (args.interimConfidence.recommendation.candidateId ? ` ${args.interimConfidence.recommendation.candidateId}` : ''))
  }
  if (args.predictiveValidity?.ranked[0]) {
    const top = args.predictiveValidity.ranked[0]
    lines.push(`top-rubric: ${top.rubric} ρ=${top.spearman.toFixed(2)}`)
  }
  return lines.join(' | ')
}
