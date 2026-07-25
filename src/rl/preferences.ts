/**
 * Preference dataset extraction — bridge from `RunRecord[]` to RL training.
 *
 * Production RLHF / DPO / KTO / SimPO pipelines need preference triples:
 * `(prompt, chosen, rejected)`. The campaign artifact already contains the
 * ingredients — every (variantId, scenarioId, seed) cell is a candidate
 * that ran the same prompt against the same scenario, scored by the same
 * judge — but turning that into a clean preference dataset requires
 * deciding *what counts as a preference*.
 *
 * This module ships three preference-extraction strategies with explicit
 * tradeoffs, plus a unified output type compatible with HuggingFace TRL,
 * Anthropic finetuning JSONL, and OpenAI fine-tuning APIs. The strategies
 * are deliberately not auto-magical — picking the wrong one corrupts the
 * gradient.
 *
 * Strategies:
 *
 *   1. **`paired-by-scenario-and-seed`** — exact-match comparisons. For
 *      each scenario × seed pair, compare every (variantA, variantB) on
 *      that exact (scenario, seed). Matches scenarios so the comparison
 *      isolates variant effects. Highest signal-to-noise; smallest
 *      dataset (only matched pairs count).
 *
 *   2. **`paired-by-scenario`** — looser matching. For each scenario,
 *      compare every (variantA, variantB) where both have ≥ 1 run on the
 *      same scenario. Aggregates across seeds to compute mean scores per
 *      (variant, scenario), then forms preferences from the means. More
 *      data, lower per-pair signal.
 *
 *   3. **`top-vs-bottom`** — coarsest. Within each scenario, the highest-
 *      scoring run is `chosen`, the lowest is `rejected`. Smallest dataset
 *      per scenario but biggest score gap per pair. Useful for early
 *      bootstrapping when you have few variants.
 *
 * Resolve `PreferenceTriple` text with `toDpoRows` from `./exporters`.
 */

import { type RunRecord, runTaskScore } from '../run-record'
import { isTrainingRunEligible, type TrainingRunSelectionOptions } from './exporters'

export type PreferenceStrategy =
  | 'paired-by-scenario-and-seed'
  | 'paired-by-scenario'
  | 'top-vs-bottom'

export interface PreferenceTriple {
  /** The scenario (input) the variants were run against. */
  scenarioId: string
  /** RunRecord ids on each side, for traceability. */
  chosenRunId: string
  rejectedRunId: string
  /** Variant ids — load-bearing for the RL update. */
  chosenVariantId: string
  rejectedVariantId: string
  /** The score gap between chosen and rejected. Larger = stronger signal. */
  marginScore: number
  /**
   * Optional `(chosen_score, rejected_score)` pair for soft-margin DPO
   * variants. Omitted for `top-vs-bottom` runs that don't carry meaningful
   * scalar gaps.
   */
  scores?: { chosen: number; rejected: number }
  /** Tie-breaker — when multiple seeds match this scenario, the one used. */
  seed?: number
  /**
   * Free-form metadata propagated from the run records — e.g. original
   * prompt-hash, model, etc. Lets the RL trainer reconstruct the prompt.
   */
  meta: {
    chosenPromptHash: string
    rejectedPromptHash: string
    chosenConfigHash: string
    rejectedConfigHash: string
    chosenModel: string
    rejectedModel: string
  }
}

export interface ExtractPreferencesOptions extends TrainingRunSelectionOptions {
  strategy?: PreferenceStrategy
  /**
   * Minimum score gap required to admit a pair. Pairs below this are
   * dropped — they're noise, not signal. Default 0.05 (5% of [0,1]).
   */
  minMargin?: number
  /**
   * Optional split tag filter. Without one, only search is included.
   * Holdout requires `allowHeldOutTrainingData: true`; dev is evaluation-only.
   */
  splitTag?: RunRecord['splitTag']
  /**
   * Optional reward extractor that overrides `outcome.holdoutScore` /
   * `outcome.searchScore`. Use to drive preferences off a verifiable
   * reward instead of the headline score.
   */
  rewardOf?: (run: RunRecord) => number | null
}

export interface PreferenceExtractionReport {
  pairs: PreferenceTriple[]
  /** Number of (scenario, seed) cells inspected. */
  cellsInspected: number
  /** Number of pairs filtered by `minMargin`. */
  pairsBelowMargin: number
  /** Number of cells with only one variant (no comparison possible). */
  cellsSingleton: number
  /** Strategy used. */
  strategy: PreferenceStrategy
}

const DEFAULT_REWARD = (run: RunRecord): number | null => {
  return runTaskScore(run) ?? null
}

/**
 * Convert `RunRecord[]` to preference triples for RL training.
 *
 * Returns a structured report so callers can see how much data was
 * dropped and why (low-margin pairs, singleton cells). For production
 * pipelines, you usually want to:
 *
 *   1. Run a campaign producing 5–10 variants × 50–200 scenarios × 3 seeds
 *   2. Call this with `strategy: 'paired-by-scenario-and-seed'` and a
 *      verifiable-reward extractor as `rewardOf`
 *   3. Pass `report.pairs` to `toDpoRows` with prompt/completion resolvers
 */
export function extractPreferences(
  runs: RunRecord[],
  opts: ExtractPreferencesOptions = {},
): PreferenceExtractionReport {
  const strategy = opts.strategy ?? 'paired-by-scenario-and-seed'
  const minMargin = opts.minMargin ?? 0.05
  const splitTag = opts.splitTag
  const rewardOf = opts.rewardOf ?? DEFAULT_REWARD

  if (splitTag === 'holdout' && opts.allowHeldOutTrainingData !== true) {
    throw new Error(
      'extractPreferences: splitTag "holdout" requires allowHeldOutTrainingData: true',
    )
  }
  if (splitTag === 'dev') {
    throw new Error('extractPreferences: splitTag "dev" is evaluation-only; train from "search"')
  }

  const scoredEntries: Array<{ run: RunRecord; score: number }> = []
  for (const run of runs) {
    if (splitTag !== undefined && run.splitTag !== splitTag) continue
    const s = rewardOf(run)
    if (!isTrainingRunEligible(run, s, opts)) continue
    scoredEntries.push({ run, score: s })
  }

  const pairs: PreferenceTriple[] = []
  let pairsBelowMargin = 0
  let cellsSingleton = 0
  let cellsInspected = 0

  if (strategy === 'paired-by-scenario-and-seed') {
    // Group by the canonical (scenarioId, seed) identity.
    const groups = new Map<string, Array<{ run: RunRecord; score: number }>>()
    for (const e of scoredEntries) {
      const sid = scenarioOf(e.run)
      const key = `${sid}::${e.run.seed}`
      const arr = groups.get(key) ?? []
      arr.push(e)
      groups.set(key, arr)
    }

    for (const [key, members] of groups.entries()) {
      cellsInspected++
      if (members.length < 2) {
        cellsSingleton++
        continue
      }
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i]!
          const b = members[j]!
          if (a.run.candidateId === b.run.candidateId) continue
          const result = makePair(a, b, key.split('::')[0]!, minMargin)
          if (result.kind === 'admit') pairs.push(result.pair)
          else pairsBelowMargin++
        }
      }
    }
  } else if (strategy === 'paired-by-scenario') {
    // Group by scenarioId → average per (variantId, scenarioId) across seeds.
    const byScenarioVariant = new Map<
      string,
      Map<string, { run: RunRecord; sum: number; n: number }>
    >()
    for (const e of scoredEntries) {
      const sid = scenarioOf(e.run)
      let perScenario = byScenarioVariant.get(sid)
      if (!perScenario) {
        perScenario = new Map()
        byScenarioVariant.set(sid, perScenario)
      }
      const cur = perScenario.get(e.run.candidateId)
      if (cur) {
        cur.sum += e.score
        cur.n++
      } else perScenario.set(e.run.candidateId, { run: e.run, sum: e.score, n: 1 })
    }
    for (const [sid, perVariant] of byScenarioVariant.entries()) {
      cellsInspected++
      const arr = [...perVariant.entries()].map(([vid, agg]) => ({
        run: agg.run,
        score: agg.sum / agg.n,
        variantId: vid,
      }))
      if (arr.length < 2) {
        cellsSingleton++
        continue
      }
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const result = makePair(arr[i]!, arr[j]!, sid, minMargin)
          if (result.kind === 'admit') pairs.push(result.pair)
          else pairsBelowMargin++
        }
      }
    }
  } else {
    // top-vs-bottom: per scenario, top vs bottom only.
    const byScenario = new Map<string, Array<{ run: RunRecord; score: number }>>()
    for (const e of scoredEntries) {
      const sid = scenarioOf(e.run)
      const arr = byScenario.get(sid) ?? []
      arr.push(e)
      byScenario.set(sid, arr)
    }
    for (const [sid, arr] of byScenario.entries()) {
      cellsInspected++
      if (arr.length < 2) {
        cellsSingleton++
        continue
      }
      const sorted = [...arr].sort((a, b) => a.score - b.score)
      const top = sorted[sorted.length - 1]!
      const bot = sorted[0]!
      if (top.run.candidateId === bot.run.candidateId) {
        cellsSingleton++
        continue
      }
      const result = makePair(bot, top, sid, minMargin)
      if (result.kind === 'admit') pairs.push(result.pair)
      else pairsBelowMargin++
    }
  }

  return { pairs, cellsInspected, pairsBelowMargin, cellsSingleton, strategy }
}

/**
 * Anthropic finetuning JSONL export — `{ system, user, assistant_chosen, assistant_rejected }`
 * shape. Same caveat as TRL: prompt + outputs are content the caller has
 * to map back from the run record / raw event log.
 */
export function toAnthropicFormat(
  triples: PreferenceTriple[],
): Array<{ scenarioId: string; chosenRunId: string; rejectedRunId: string; margin: number }> {
  return triples.map((t) => ({
    scenarioId: t.scenarioId,
    chosenRunId: t.chosenRunId,
    rejectedRunId: t.rejectedRunId,
    margin: t.marginScore,
  }))
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makePair(
  a: { run: RunRecord; score: number },
  b: { run: RunRecord; score: number },
  scenarioId: string,
  minMargin: number,
): { kind: 'admit'; pair: PreferenceTriple } | { kind: 'reject' } {
  const margin = Math.abs(a.score - b.score)
  if (margin < minMargin) return { kind: 'reject' }
  const [chosen, rejected] = a.score > b.score ? [a, b] : [b, a]
  return {
    kind: 'admit',
    pair: {
      scenarioId,
      chosenRunId: chosen.run.runId,
      rejectedRunId: rejected.run.runId,
      chosenVariantId: chosen.run.candidateId,
      rejectedVariantId: rejected.run.candidateId,
      marginScore: chosen.score - rejected.score,
      scores: { chosen: chosen.score, rejected: rejected.score },
      seed: chosen.run.seed === rejected.run.seed ? chosen.run.seed : undefined,
      meta: {
        chosenPromptHash: chosen.run.promptHash,
        rejectedPromptHash: rejected.run.promptHash,
        chosenConfigHash: chosen.run.configHash,
        rejectedConfigHash: rejected.run.configHash,
        chosenModel: chosen.run.model,
        rejectedModel: rejected.run.model,
      },
    },
  }
}

function scenarioOf(run: RunRecord): string {
  return run.scenarioId
}
