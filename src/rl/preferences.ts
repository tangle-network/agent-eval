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
 * The output `PreferenceTriple` is *agent-eval-canonical* but trivially
 * mappable to TRL's `DPODataset` shape (`prompt`, `chosen`, `rejected`)
 * via the `toTRLFormat` helper, which resolves real prompt/completion text
 * through the same lookups `toDpoRows` takes (`./exporters` carries the
 * richer row with margin + metadata).
 *
 * Input discipline: the primary signature takes `MintedRolloutLine[]` — the
 * `tangle.rollout.v1` waist, whose reward already carries the realness gate.
 * The `RunRecord[]` signature stays as a deprecated overload. Unlike the
 * exporters it does NOT mint internally: this function is synchronous and
 * minting is not, so it feeds the same pairing implementation through a record
 * adapter that applies the gate via `trainingScore` plus the shared
 * training-row eligibility rule (`isTrainingRunEligible`). One implementation,
 * two adapters — the gate is in both, and the published signature stays sync.
 *
 * Split policy, both paths: `search` is the only split paired by default,
 * held-out pairing requires `allowHeldOutTrainingData: true`, and `dev` is
 * refused as evaluation-only — a preference pair IS training data.
 */

import { trainingRewardOverride, trainingScore } from '../rollout/reward'
import type { MintedRolloutLine, RolloutSplit } from '../rollout/schema'
import type { RunRecord } from '../run-record'
import {
  type DpoLookups,
  isTrainingRunEligible,
  type TrainingRunSelectionOptions,
} from './exporters'
import {
  admitUngatedByInvocation,
  isRolloutLineInput,
  type LineContextRequirement,
  type RolloutLineContext,
  trainableLineReward,
} from './rollout-input'

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
   *
   * The realness gate still wins: the value comes back through
   * `trainingRewardOverride`, so a reward derived from a gamed run is forced to
   * 0 exactly like the score it replaced. Identical treatment to the
   * same-named hook on `rl/exporters.toGrpoRows`, which is the point — the two
   * disagreeing was what let a gamed run become the CHOSEN side of a DPO pair.
   */
  rewardOf?: (run: RunRecord) => number | null
}

export interface ExtractPreferencesFromLinesOptions {
  strategy?: PreferenceStrategy
  /**
   * Minimum score gap required to admit a pair. Pairs below this are
   * dropped — they're noise, not signal. Default 0.05 (5% of [0,1]).
   */
  minMargin?: number
  /**
   * Optional split filter — restrict to lines from one split. Default
   * `'search'`: a preference pair is training data, and training data comes
   * from the search split. `'holdout'` requires `allowHeldOutTrainingData`;
   * `'dev'` is refused as evaluation-only.
   */
  split?: RolloutSplit
  /** Named opt-in required before held-out lines may be paired. */
  allowHeldOutTrainingData?: boolean
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
  /**
   * Lines dropped before pairing because they carry no `candidate_id`. A
   * preference is a statement about two candidates, so a line that names none
   * cannot be paired. Only ever non-zero on the `RolloutLine[]` path — mint
   * always copies `RunRecord.candidateId`, which is mandatory.
   */
  linesWithoutCandidateId?: number
}

/** The split each path pairs by default: training data comes from search. */
const SPLIT_DEFAULT: RolloutSplit = 'search'

/**
 * The only shape the pairing strategies see. Both input adapters normalize
 * into it, so `RolloutLine[]` and the deprecated `RunRecord[]` path run the
 * exact same comparison code.
 */
interface PairingCandidate {
  scenarioId: string
  runId: string
  candidateId: string
  /** null only when a line records no seed; RunRecords always carry one. */
  seed: number | null
  score: number
  promptHash: string
  configHash: string
  model: string
}

const DEFAULT_REWARD = (run: RunRecord): number | null => {
  // Orders chosen-vs-rejected in every exported DPO pair. Ungated, a gamed run
  // with an inflated score becomes the `chosen` side and the trainer is taught
  // to prefer the gaming trajectory over its honest sibling.
  const v = trainingScore(run)
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Convert rollout lines to preference triples for RL training.
 *
 * Returns a structured report so callers can see how much data was
 * dropped and why (low-margin pairs, singleton cells). For production
 * pipelines, you usually want to:
 *
 *   1. Run a campaign producing 5–10 variants × 50–200 scenarios × 3 seeds
 *   2. Mint the runs with `mintRolloutRows` and call this with
 *      `strategy: 'paired-by-scenario-and-seed'`
 *   3. Pass `report.pairs` to `toDpoRows` (or `toTRLFormat`) with
 *      prompt/completion resolvers and pipe to your DPO trainer
 *
 * The gate is what makes a preference dataset safe: ordered on an ungated
 * score, a gamed run with an inflated number becomes the `chosen` side and DPO
 * is trained to prefer the gaming trajectory over its honest sibling. A gated
 * line arrives here already scored 0, so it sinks to `rejected`.
 */
export function extractPreferences(
  lines: MintedRolloutLine[],
  opts?: ExtractPreferencesFromLinesOptions,
): PreferenceExtractionReport
/**
 * @deprecated Pass `RolloutLine[]` (mint with `mintRolloutRows`). This
 * signature applies the same gate through `trainingScore` and the shared
 * eligibility rule (a gamed or non-positive run is dropped outright), and
 * keeps `rewardOf` — the one reward hook the line path deliberately drops.
 */
export function extractPreferences(
  runs: RunRecord[],
  opts?: ExtractPreferencesOptions,
): PreferenceExtractionReport
export function extractPreferences(
  input: MintedRolloutLine[] | RunRecord[],
  opts: ExtractPreferencesFromLinesOptions | ExtractPreferencesOptions = {},
): PreferenceExtractionReport {
  const strategy = opts.strategy ?? 'paired-by-scenario-and-seed'
  const minMargin = opts.minMargin ?? 0.05
  // The split guard runs before dispatch so it fires on either option
  // spelling AND on an empty input (which dispatches as lines): asking for an
  // evaluation split is wrong regardless of whether any rows came with it.
  const requestedSplit =
    (opts as ExtractPreferencesOptions).splitTag ??
    (opts as ExtractPreferencesFromLinesOptions).split
  if (requestedSplit === 'holdout' && opts.allowHeldOutTrainingData !== true) {
    throw new Error('extractPreferences: split "holdout" requires allowHeldOutTrainingData: true')
  }
  if (requestedSplit === 'dev') {
    throw new Error('extractPreferences: split "dev" is evaluation-only; train from "search"')
  }
  const candidates = isRolloutLineInput(input)
    ? candidatesFromLines(input, opts as ExtractPreferencesFromLinesOptions)
    : candidatesFromRecords(input, opts as ExtractPreferencesOptions)
  const report = pairCandidates(candidates.rows, strategy, minMargin)
  return candidates.withoutCandidateId === undefined
    ? report
    : { ...report, linesWithoutCandidateId: candidates.withoutCandidateId }
}

interface NormalizedInput {
  rows: PairingCandidate[]
  /** Undefined on the record path, where `candidateId` is mandatory. */
  withoutCandidateId?: number
}

function candidatesFromRecords(
  runs: RunRecord[],
  opts: ExtractPreferencesOptions,
): NormalizedInput {
  const splitTag = opts.splitTag
  const custom = opts.rewardOf
  const rows: PairingCandidate[] = []
  for (const run of runs) {
    if (splitTag !== undefined && run.splitTag !== splitTag) continue
    // The caller's hook is honoured and then gated, never gated instead of
    // honoured. Ungated it ordered chosen-vs-rejected on the number a gamed run
    // claimed, which is the one ordering DPO must never be taught. The shared
    // eligibility rule then applies on top: gated, non-positive, non-succeeded
    // and wrong-split runs are dropped outright.
    const score =
      custom === undefined ? DEFAULT_REWARD(run) : trainingRewardOverride(run, custom(run))
    if (!isTrainingRunEligible(run, score, opts)) continue
    rows.push({
      // Three-tier scenario fallback, which `RolloutLine.task.instance_id`
      // cannot express (mint knows only `scenarioId ?? experimentId`). Kept on
      // this path so records carrying only `outcome.raw.scenario_id` still
      // group the way they always have.
      scenarioId: scenarioOf(run),
      runId: run.runId,
      candidateId: run.candidateId,
      seed: run.seed,
      score,
      promptHash: run.promptHash,
      configHash: run.configHash,
      model: run.model,
    })
  }
  return { rows }
}

function candidatesFromLines(
  lines: MintedRolloutLine[],
  opts: ExtractPreferencesFromLinesOptions,
): NormalizedInput {
  const split = opts.split ?? SPLIT_DEFAULT
  const rows: PairingCandidate[] = []
  let withoutCandidateId = 0
  for (const line of lines) {
    if (line.task.split !== split) continue
    const score = trainableLineReward(line)
    if (score === null) continue
    const candidateId = line.candidate_id
    if (candidateId === null || candidateId === undefined || candidateId.length === 0) {
      withoutCandidateId++
      continue
    }
    rows.push({
      scenarioId: line.task.instance_id,
      runId: line.run_id,
      candidateId,
      seed: line.task.seed,
      score,
      // `policy.*` is nullable on the wire; a minted line always carries these
      // (RunRecord makes them mandatory). Empty string marks "not recorded" so
      // `toTRLFormat`'s hash lookup fails visibly instead of silently matching.
      promptHash: line.policy.prompt_hash ?? '',
      configHash: line.policy.config_hash ?? '',
      model: line.policy.model ?? '',
    })
  }
  return { rows, withoutCandidateId }
}

function pairCandidates(
  scoredEntries: PairingCandidate[],
  strategy: PreferenceStrategy,
  minMargin: number,
): PreferenceExtractionReport {
  const pairs: PreferenceTriple[] = []
  let pairsBelowMargin = 0
  let cellsSingleton = 0
  let cellsInspected = 0

  if (strategy === 'paired-by-scenario-and-seed') {
    // Group by the canonical (scenarioId, seed) identity.
    const groups = new Map<string, PairingCandidate[]>()
    for (const e of scoredEntries) {
      const key = `${e.scenarioId}::${e.seed}`
      const arr = groups.get(key) ?? []
      arr.push(e)
      groups.set(key, arr)
    }

    for (const members of groups.values()) {
      cellsInspected++
      if (members.length < 2) {
        cellsSingleton++
        continue
      }
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i]!
          const b = members[j]!
          if (a.candidateId === b.candidateId) continue
          const result = makePair(a, b, a.scenarioId, minMargin)
          if (result.kind === 'admit') pairs.push(result.pair)
          else pairsBelowMargin++
        }
      }
    }
  } else if (strategy === 'paired-by-scenario') {
    // Group by scenarioId → average per (variantId, scenarioId) across seeds.
    const byScenarioVariant = new Map<
      string,
      Map<string, { entry: PairingCandidate; sum: number; n: number }>
    >()
    for (const e of scoredEntries) {
      let perScenario = byScenarioVariant.get(e.scenarioId)
      if (!perScenario) {
        perScenario = new Map()
        byScenarioVariant.set(e.scenarioId, perScenario)
      }
      const cur = perScenario.get(e.candidateId)
      if (cur) {
        cur.sum += e.score
        cur.n++
      } else perScenario.set(e.candidateId, { entry: e, sum: e.score, n: 1 })
    }
    for (const [sid, perVariant] of byScenarioVariant.entries()) {
      cellsInspected++
      const arr = [...perVariant.values()].map((agg) => ({
        ...agg.entry,
        score: agg.sum / agg.n,
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
    const byScenario = new Map<string, PairingCandidate[]>()
    for (const e of scoredEntries) {
      const arr = byScenario.get(e.scenarioId) ?? []
      arr.push(e)
      byScenario.set(e.scenarioId, arr)
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
      if (top.candidateId === bot.candidateId) {
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

const PREFERENCE_RUN_IDS = (t: PreferenceTriple): readonly string[] => [
  t.chosenRunId,
  t.rejectedRunId,
]

const TRL_CONTEXT_REQUIREMENT: LineContextRequirement = {
  exporter: 'TRL preference export',
  contextType: 'RolloutLineContext',
  because:
    'a PreferenceTriple carries only run ids and hashes, so without the minted rollout lines this exporter cannot see the realness gate and will put a run that faked its success on the CHOSEN side of a DPO pair.',
}

const ANTHROPIC_CONTEXT_REQUIREMENT: LineContextRequirement = {
  exporter: 'Anthropic preference export',
  contextType: 'RolloutLineContext',
  because:
    'a PreferenceTriple carries only run ids and a bare margin, so without the minted rollout lines this exporter cannot see the realness gate and will name a run that faked its success as the preferred one.',
}

/**
 * TRL-compatible export. TRL's `DPODataset` is `{ prompt, chosen, rejected }`
 * where `chosen`/`rejected` are completion TEXT — a trainer fed prompt hashes
 * would optimize the policy toward emitting hex digests. Neither the prompt
 * nor the completions live on the triple (it carries only run ids and hashes),
 * so the caller supplies the same `promptOf`/`completionOf` lookups `toDpoRows`
 * takes, keyed by run id, and this function resolves real text.
 *
 * The chosen and rejected sides of a valid pair share one prompt; resolving
 * both and comparing catches lookup bugs (a stale map keyed by the wrong id)
 * before they ship a row whose prompt does not match its rejected completion.
 *
 * `context` is REQUIRED: this is the third exporter over the identical
 * line-less input class, and the round that hardened `toPrmRows` while leaving
 * `toDpoRows` open is why every one of them now takes the same argument and
 * runs the same admission rule.
 */
export async function toTRLFormat(
  triples: PreferenceTriple[],
  lookups: DpoLookups,
  context: RolloutLineContext,
): Promise<Array<{ prompt: string; chosen: string; rejected: string }>> {
  const admitted = admitUngatedByInvocation(
    triples,
    PREFERENCE_RUN_IDS,
    context,
    TRL_CONTEXT_REQUIREMENT,
  )
  const out: Array<{ prompt: string; chosen: string; rejected: string }> = []
  for (const t of admitted) {
    const [chosenPrompt, rejectedPrompt, chosen, rejected] = await Promise.all([
      Promise.resolve(lookups.promptOf(t.chosenRunId)),
      Promise.resolve(lookups.promptOf(t.rejectedRunId)),
      Promise.resolve(lookups.completionOf(t.chosenRunId)),
      Promise.resolve(lookups.completionOf(t.rejectedRunId)),
    ])
    if (chosenPrompt !== rejectedPrompt) {
      throw new Error(
        `toTRLFormat: preference "${t.chosenRunId}"/"${t.rejectedRunId}" resolves to different prompts`,
      )
    }
    out.push({ prompt: chosenPrompt, chosen, rejected })
  }
  return out
}

/**
 * Anthropic finetuning JSONL export — `{ system, user, assistant_chosen, assistant_rejected }`
 * shape. Same caveat as TRL: prompt + outputs are content the caller has
 * to map back from the run record / raw event log.
 *
 * `context` is REQUIRED — see `toTRLFormat`. The emitted `margin` is a number
 * derived from the two runs' rewards, so this row is training signal even
 * though it ships no completion text.
 */
export function toAnthropicFormat(
  triples: PreferenceTriple[],
  context: RolloutLineContext,
): Array<{ scenarioId: string; chosenRunId: string; rejectedRunId: string; margin: number }> {
  return admitUngatedByInvocation(
    triples,
    PREFERENCE_RUN_IDS,
    context,
    ANTHROPIC_CONTEXT_REQUIREMENT,
  ).map((t) => ({
    scenarioId: t.scenarioId,
    chosenRunId: t.chosenRunId,
    rejectedRunId: t.rejectedRunId,
    margin: t.marginScore,
  }))
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makePair(
  a: PairingCandidate,
  b: PairingCandidate,
  scenarioId: string,
  minMargin: number,
): { kind: 'admit'; pair: PreferenceTriple } | { kind: 'reject' } {
  const margin = Math.abs(a.score - b.score)
  if (margin < minMargin) return { kind: 'reject' }
  const [chosen, rejected] = a.score > b.score ? [a, b] : [b, a]
  const seed = chosen.seed !== null && chosen.seed === rejected.seed ? chosen.seed : undefined
  return {
    kind: 'admit',
    pair: {
      scenarioId,
      chosenRunId: chosen.runId,
      rejectedRunId: rejected.runId,
      chosenVariantId: chosen.candidateId,
      rejectedVariantId: rejected.candidateId,
      marginScore: chosen.score - rejected.score,
      scores: { chosen: chosen.score, rejected: rejected.score },
      seed,
      meta: {
        chosenPromptHash: chosen.promptHash,
        rejectedPromptHash: rejected.promptHash,
        chosenConfigHash: chosen.configHash,
        rejectedConfigHash: rejected.configHash,
        chosenModel: chosen.model,
        rejectedModel: rejected.model,
      },
    },
  }
}

function scenarioOf(run: RunRecord): string {
  return run.scenarioId
}
