/**
 * Pure exporters over `tangle.rollout.v1` lines → the training-data shapes
 * the improvement loops feed:
 *   - SFT chat JSONL           (clean trainable successes, {messages, metadata})
 *   - reward rows              (every scored line, success or failure, with steps)
 *   - Prime Intellect verifiers RolloutOutput (prompt/completion split + reward)
 *   - OpenAI RFT items         (prompt turns + verdict reference fields)
 *
 * All exporters are pure functions of the lines — filtering (never train on
 * holdout, reward thresholds, the realness gate) happens HERE, on inline
 * labels, no joins.
 *
 * Every exporter takes `MintedRolloutLine[]`, not `RolloutLine[]`: the reward
 * on a minted line has been checked against the anti-Goodhart invariant, and
 * the brand is what stops a hand-built object literal claiming a positive
 * reward on a gamed run from being handed to an exporter that copies it
 * verbatim into training data.
 */

import {
  isSplitEligible,
  type TrainingExportOptions,
  trainingAdmission,
} from './training-admission'
import { requireToolLinkage } from './transcript'

export { isSplitEligible, type TrainingExportOptions } from './training-admission'

import type {
  ChatMessage,
  MintedRolloutLine,
  RolloutLine,
  RolloutSplit,
  RolloutStep,
  ToolDef,
} from './schema'
import { assertRewardGate } from './schema'

// ---------------------------------------------------------------------------
// The realness claims every emitted row carries.
// ---------------------------------------------------------------------------

/**
 * The gate's two claims, which travel TOGETHER on every emitted row.
 *
 * `realness_gated` alone is ambiguous, and the ambiguity is exploitable:
 * `false` reads as "we screened it and nothing fired", so a producer that has no
 * screen at all emitted rows indistinguishable from screened-clean ones, and
 * every consumer of the published dataset read them as clean. The second field
 * is what separates the two claims, and it only removes the ambiguity if it
 * reaches the WIRE — for a round it existed on `RolloutOutcome` and on no
 * exported row shape at all, which left the published rows exactly as ambiguous
 * as before.
 *
 * So there is one helper and every row shape spreads it. A row that states one
 * claim without the other is not constructible by copying the pattern, and
 * `exporters.test.ts` walks every emitted shape to prove none does.
 */
export interface RealnessLabels {
  /** The screen's VERDICT: the run faked its success signal. */
  realness_gated: boolean
  /**
   * Whether a screen RAN at all. `true` = it ran, so `realness_gated` is its
   * verdict. `false` = the producer declares it has none. `null` = not stated
   * (pre-unification producers), which is "unknown" and never "clean".
   */
  realness_screened: boolean | null
}

function realnessLabels(line: MintedRolloutLine): RealnessLabels {
  return {
    realness_gated: line.outcome.realness_gated === true,
    // `?? null` rather than `?? false`: absent means the producer never stated
    // it, and `false` is a load-bearing claim ("no screen exists") that would be
    // an invention here.
    realness_screened: line.outcome.realness_screened ?? null,
  }
}

// ---------------------------------------------------------------------------
// (a) SFT chat JSONL
// ---------------------------------------------------------------------------

/**
 * What a signed-signal exporter (verifiers, RFT) does with lines that are not
 * clean trainable successes — realness-gated lines above all.
 *
 *   - 'exclude'       — the default, the same fail-closed policy as every
 *                       other training export: positive, completed,
 *                       non-gated rows on a trainable split.
 *   - 'zero-and-flag' — keep them, at their non-positive (or null) reward,
 *                       with `RealnessLabels` on the row. The dataset release
 *                       sets this per `FORMAT_GATE_DISPOSITION`: in these
 *                       formats the reward is a signed learning signal, so a
 *                       gamed trajectory at reward 0 is a correct negative,
 *                       and dropping it would bias the negative population
 *                       toward honest failures and leave a trainer no example
 *                       of gaming being penalized. The split policy is NOT
 *                       relaxed: held-out lines still need the named opt-in.
 *
 * SFT deliberately has no such option — an SFT row is an imitation target and
 * a gamed trajectory must never appear in one at any weight.
 */
type GatedLineDisposition = 'exclude' | 'zero-and-flag'

interface SignedSignalExportOptions extends TrainingExportOptions {
  /** Disposition for non-trainable lines. Default 'exclude'. */
  gatedLines?: GatedLineDisposition
}

export type SftExportOptions = TrainingExportOptions

/** Copied context conditions a row but is never a target; both SFT loss fields read this. */
const lossWeight = (copied: boolean | undefined): 0 | 1 => (copied === true ? 0 : 1)

export interface SftRow {
  /** Assistant weight 0 preserves conditioning without assigning imitation loss. */
  messages: Array<ChatMessage & { weight?: 0 | 1 }>
  /** Per-message flags from the `weight` rule: 0 is context only, 1 keeps the role mask. */
  message_loss_mask: Array<0 | 1>
  tools: ToolDef[]
  metadata: {
    rollout_id: string
    run_id: string
    candidate_id: string | null
    instance_id: string
    reward: number
  } & RealnessLabels
}

/**
 * Supervised fine-tune rows: the completed conversation of each qualifying
 * line. Fail-closed filters: trainable split only (never holdout/canary unless
 * an explicit `splitFilter` names a non-training slice),
 * reward strictly above `minimumQualityExclusive` (default 0), realness-gated
 * lines never qualify, gap lines carry no trainable content, and
 * copied assistant turns remain conditioning with weight 0 (see `ChatMessage.is_copied_context`).
 *
 * `realness_gated` is therefore always `false` on an emitted row. It is carried
 * anyway: an SFT row is a pure imitation target, so the row states its realness
 * claims instead of making the reader know the format's policy, and carrying
 * both flags on all four shapes is what lets the release accounting measure
 * every config with one rule rather than skipping the one whose row shape
 * happened to omit the field.
 */
export function toSftRows(lines: MintedRolloutLine[], options: SftExportOptions = {}): SftRow[] {
  for (const line of lines) assertRewardGate(line, 'SFT export')
  return lines
    .filter((line) => isTrainingLineEligible(line, options) && line.messages.length > 0)
    .map((line) => {
      requireToolLinkage(line.messages, `SFT export ${line.rollout_id}`)
      return {
        messages: line.messages.map((message): SftRow['messages'][number] => {
          const { is_copied_context, ...turn } = message
          return message.role === 'assistant'
            ? { ...turn, weight: lossWeight(is_copied_context) }
            : turn
        }),
        message_loss_mask: line.messages.map((message) => lossWeight(message.is_copied_context)),
        tools: line.tool_defs,
        metadata: {
          rollout_id: line.rollout_id,
          run_id: line.run_id,
          candidate_id: line.candidate_id ?? null,
          instance_id: line.task.instance_id,
          reward: line.outcome.reward as number,
          ...realnessLabels(line),
        },
      }
    })
    .filter((row) =>
      row.messages.some((message) => message.role === 'assistant' && message.weight === 1),
    )
}

// ---------------------------------------------------------------------------
// (b) Reward rows
// ---------------------------------------------------------------------------

export interface RewardRow {
  /** First user turn — the task prompt. */
  prompt: string
  steps: RolloutStep[]
  reward: number
  metadata: {
    rollout_id: string
    run_id: string
    candidate_id: string | null
    instance_id: string
    split: RolloutSplit
    /**
     * The anti-Goodhart verdict AND whether a screen produced it, carried on the
     * row rather than left implicit in a reward of 0. Zeroing alone is lossy: it
     * makes a run that FAKED its success indistinguishable from one that
     * honestly failed, so a consumer can neither drop the gamed population nor
     * mine it (a labeled gamed trajectory is the training signal for a gaming
     * detector). `realness_gated` alone is lossy the same way in the other
     * direction — see `RealnessLabels`.
     */
  } & RealnessLabels
}

/**
 * Reward-labeled rows for completed, positive-quality training runs.
 */
export function toRewardRows(
  lines: MintedRolloutLine[],
  options: TrainingExportOptions = {},
): RewardRow[] {
  for (const line of lines) assertRewardGate(line, 'reward-row export')
  return lines
    .filter(
      (line) =>
        isTrainingLineEligible(line, options) &&
        line.messages.some(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.length > 0,
        ),
    )
    .map((line) => ({
      prompt: line.messages.find((m) => m.role === 'user')?.content ?? '',
      steps: line.steps ?? [],
      reward: line.outcome.reward as number,
      metadata: {
        rollout_id: line.rollout_id,
        run_id: line.run_id,
        candidate_id: line.candidate_id ?? null,
        instance_id: line.task.instance_id,
        split: line.task.split,
        ...realnessLabels(line),
      },
    }))
}

// ---------------------------------------------------------------------------
// (c) Prime Intellect verifiers RolloutOutput
// ---------------------------------------------------------------------------

export interface VerifiersTokenUsage {
  input_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}

export interface VerifiersRolloutOutput {
  /** Messages through the last turn BEFORE the first assistant turn. */
  prompt: ChatMessage[]
  /** The first assistant turn onward — what the policy produced. */
  completion: ChatMessage[]
  reward: number | null
  metrics: Record<string, unknown>
  tool_defs: ToolDef[]
  token_usage: VerifiersTokenUsage
  info: {
    task: RolloutLine['task']
    policy: RolloutLine['policy']
    rollout_id: string
    run_id: string
    experiment_id: string | null
    candidate_id: string | null
    generation: number | null
    candidate_index: number | null
    role: RolloutLine['role']
  } & RealnessLabels
}

/** Index of the first assistant turn; messages.length when none exists. */
function firstAssistantIndex(messages: ChatMessage[]): number {
  const index = messages.findIndex((m) => m.role === 'assistant')
  return index === -1 ? messages.length : index
}

function assertCompleteProjection(line: MintedRolloutLine, context: string): void {
  if (line.provenance.lossy_projection === true) {
    throw new Error(`${context}: rollout ${line.rollout_id} has a lossy projection`)
  }
}

export function toVerifiersRolloutOutput(line: MintedRolloutLine): VerifiersRolloutOutput {
  assertRewardGate(line, 'verifiers export')
  assertCompleteProjection(line, 'verifiers export')
  const split = firstAssistantIndex(line.messages)
  return {
    prompt: line.messages.slice(0, split),
    completion: line.messages.slice(split),
    reward: line.outcome.reward,
    metrics: line.outcome.metrics,
    tool_defs: line.tool_defs,
    token_usage: {
      input_tokens: line.cost.tokens_in,
      output_tokens: line.cost.tokens_out,
      reasoning_tokens: line.cost.tokens_reasoning,
      cache_read_tokens: line.cost.cache_read,
      cache_write_tokens: line.cost.cache_write,
    },
    info: {
      task: line.task,
      policy: line.policy,
      rollout_id: line.rollout_id,
      run_id: line.run_id,
      experiment_id: line.experiment_id ?? null,
      candidate_id: line.candidate_id ?? null,
      generation: line.generation,
      candidate_index: line.candidate_index,
      role: line.role,
      ...realnessLabels(line),
    },
  }
}

export function toVerifiersRolloutOutputs(
  lines: MintedRolloutLine[],
  options: SignedSignalExportOptions = {},
): VerifiersRolloutOutput[] {
  if (options.gatedLines === 'zero-and-flag') {
    return lines
      .filter(
        (line) =>
          isSplitEligible(line, options) &&
          line.provenance.lossy_projection !== true &&
          line.messages.length > 0,
      )
      .map(toVerifiersRolloutOutput)
  }
  return lines
    .filter(
      (line) =>
        isTrainingLineEligible(line, options) &&
        firstAssistantIndex(line.messages) > 0 &&
        firstAssistantIndex(line.messages) < line.messages.length,
    )
    .map(toVerifiersRolloutOutput)
}

// ---------------------------------------------------------------------------
// (d) OpenAI RFT items
// ---------------------------------------------------------------------------

export interface RftItem {
  /** Prompt turns only — the graded completion is re-sampled during RFT. */
  messages: ChatMessage[]
  /** Verdict/label fields the grader references as item.reference.* */
  reference: {
    reward: number | null
    reward_source: string | null
    verdict: unknown
    instance_id: string
    suite: string
    split: RolloutSplit
    rollout_id: string
  } & RealnessLabels
}

export function toRftItem(line: MintedRolloutLine): RftItem {
  assertRewardGate(line, 'RFT export')
  assertCompleteProjection(line, 'RFT export')
  const split = firstAssistantIndex(line.messages)
  return {
    messages: line.messages.slice(0, split),
    reference: {
      reward: line.outcome.reward,
      reward_source: line.outcome.reward_source,
      verdict: line.outcome.verdict,
      instance_id: line.task.instance_id,
      suite: line.task.suite,
      split: line.task.split,
      rollout_id: line.rollout_id,
      ...realnessLabels(line),
    },
  }
}

/** RFT needs a real prompt: lines whose transcript starts with prompt turns. */
export function toRftItems(
  lines: MintedRolloutLine[],
  options: SignedSignalExportOptions = {},
): RftItem[] {
  return lines
    .filter(
      (line) =>
        (options.gatedLines === 'zero-and-flag'
          ? isSplitEligible(line, options) && line.provenance.lossy_projection !== true
          : isTrainingLineEligible(line, options)) &&
        line.messages.length > 0 &&
        firstAssistantIndex(line.messages) > 0,
    )
    .map(toRftItem)
}

// ---------------------------------------------------------------------------
// Serialization — one JSON object per line, the interchange format for
// every export. `tangle.rollout.v1` lines and export rows alike.
// ---------------------------------------------------------------------------

export function toJsonl(rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
}

/**
 * The whole fail-closed training policy for one line: scored, positive above
 * the floor, completed, not gated, in the requested license classes, on an eligible split. Shared with
 * `rl/exporters` so its text-lookup adapter cannot drift from this rule.
 */
export function isTrainingLineEligible(
  line: RolloutLine,
  options: TrainingExportOptions,
): line is RolloutLine & { outcome: RolloutLine['outcome'] & { reward: number } } {
  return trainingAdmission(line, 'imitation', options).reason === null
}
