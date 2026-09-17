/**
 * Trainer-format exporters.
 *
 * agent-eval produces canonical artifacts (`MintedRolloutLine[]`, `PreferenceTriple[]`,
 * `StepReward[]`, `PrmTrainingTriple[]`). RL training pipelines consume
 * different shapes — Hugging Face TRL, Prime Intellect's prime-rl, OpenAI
 * fine-tuning, Anthropic finetuning, OpenRLHF, verl. Each has its own
 * JSONL conventions. Rather than ship N adapters, this module ships the
 * canonical formats most production pipelines accept and ergonomic helpers
 * for the rest.
 *
 * Shapes:
 *   - **DPO / IPO / KTO** — `{prompt, chosen, rejected}` JSONL. Consumed
 *     by HuggingFace TRL, prime-rl's offline DPO, OpenRLHF.
 *   - **GRPO offline** — `{prompt, completions[], rewards[]}` JSONL.
 *     Consumed by prime-rl GRPO, verl, OpenRLHF.
 *   - **SFT** — `{messages[]}` JSONL with chosen completion as the final
 *     assistant turn. Consumed by HF SFT trainers, OpenAI fine-tuning,
 *     Anthropic finetuning.
 *   - **PRM** — `{prompt, prefix_steps[], chosen_step, rejected_step}` JSONL.
 *     Consumed by Lightman-style PRM trainers and prime-rl's PRM mode.
 *
 * Why ship this in agent-eval rather than a separate adapter package: the
 * canonical artifacts (`MintedRolloutLine[]`, `PreferenceTriple[]`, etc.) are
 * agent-eval's contract; without first-party exporters consumers reverse-
 * engineer the mapping every release. The exporters codify it.
 *
 * The text-only formats (DPO, GRPO, PRM) take callbacks for prompt and
 * completion text, which the canonical artifact does not carry as flat fields —
 * the consumer resolves them from its trace store / raw event log. SFT is the
 * one format whose row IS the captured conversation, so it projects the line's
 * inline `messages` through `rollout/exporters.toSftRows` and uses the text
 * lookups only to recover a gap line (a line minted without a transcript).
 *
 * Every exporter that produces a training row accepts canonical minted rollout
 * lines. Convert run records once with `mintRolloutRows`; downstream transforms
 * then share one reward, split, and authenticity contract.
 */

import {
  isSplitEligible,
  isTrainingLineEligible,
  type TrainingExportOptions,
  toSftRows as toCanonicalSftRows,
} from '../rollout/exporters'
import { assertRewardGate, type ChatMessage, type MintedRolloutLine } from '../rollout/schema'
import type { PreferenceTriple } from './preferences'
import type { PrmTrainingTriple, StepReward } from './process-reward'
import {
  admitUngatedByInvocation,
  type LineContextRequirement,
  type RolloutLineContext,
  trainableLineReward,
} from './rollout-input'

export type { RolloutLineContext } from './rollout-input'

// ── DPO / IPO / KTO ──────────────────────────────────────────────────────

export interface DpoLookups {
  /** Resolve the prompt text for a run (typically from a trace store / raw event sink). */
  promptOf: (runId: string) => string | Promise<string>
  /** Resolve the assistant completion text for a run. */
  completionOf: (runId: string) => string | Promise<string>
}

export interface DpoExportRow {
  prompt: string
  chosen: string
  rejected: string
  /** Carried-through margin. Some KTO / IPO variants use this. */
  margin?: number
  /** Free-form metadata for downstream filtering / sharding. */
  meta?: Record<string, unknown>
}

/** The minted lines for the runs a `PreferenceTriple` names on each side. */
export type DpoLineContext = RolloutLineContext

const DPO_CONTEXT_REQUIREMENT: LineContextRequirement = {
  exporter: 'DPO export',
  contextType: 'DpoLineContext',
  because:
    'a PreferenceTriple carries only run ids and a bare margin number, so without the minted rollout lines this exporter cannot see the realness gate and will write a run that faked its success onto the CHOSEN side of the pair — which is DPO trained to PREFER the gaming trajectory.',
}

/**
 * Convert preference triples to TRL-compatible DPO rows. The shape
 * `{prompt, chosen, rejected}` is the canonical HuggingFace DPODataset
 * entry; every major DPO trainer accepts it.
 *
 * `context` is REQUIRED, and for the same reason it is required on the sibling
 * `toPrmRows`: a triple is a line-less artifact. It names two run ids and a
 * margin, and nothing on it says whether either run was flagged as gamed —
 * so a two-argument call applied NO gate at all and emitted the row verbatim,
 * reachable straight through the published bundle builder
 * (`buildRlDataset(lines, lookups, {formats:['dpo']}, {triples, lookups})`).
 * Triples whose chosen or rejected side is realness-gated are dropped; a triple
 * naming a run with no supplied line is refused. See `admitUngatedByInvocation` for
 * why dropping, not zeroing, is the right disposition for a preference pair.
 */
export async function toDpoRows(
  triples: PreferenceTriple[],
  lookups: DpoLookups,
  context: DpoLineContext,
): Promise<DpoExportRow[]> {
  const admitted = admitUngatedByInvocation(
    triples,
    (t) => [t.chosenRunId, t.rejectedRunId],
    context,
    DPO_CONTEXT_REQUIREMENT,
  )
  const out: DpoExportRow[] = []
  for (const t of admitted) {
    const [chosenPrompt, rejectedPrompt, chosen, rejected] = await Promise.all([
      Promise.resolve(lookups.promptOf(t.chosenRunId)),
      Promise.resolve(lookups.promptOf(t.rejectedRunId)),
      Promise.resolve(lookups.completionOf(t.chosenRunId)),
      Promise.resolve(lookups.completionOf(t.rejectedRunId)),
    ])
    if (chosenPrompt !== rejectedPrompt) {
      throw new Error(
        `toDpoRows: preference "${t.chosenRunId}"/"${t.rejectedRunId}" resolves to different prompts`,
      )
    }
    out.push({
      prompt: chosenPrompt,
      chosen,
      rejected,
      margin: t.marginScore,
      meta: {
        scenarioId: t.scenarioId,
        chosenVariantId: t.chosenVariantId,
        rejectedVariantId: t.rejectedVariantId,
        chosenRunId: t.chosenRunId,
        rejectedRunId: t.rejectedRunId,
        chosenModel: t.meta.chosenModel,
        rejectedModel: t.meta.rejectedModel,
      },
    })
  }
  return out
}

/** Serialize DPO rows as JSONL. One line per row. */
export function toDpoJsonl(rows: DpoExportRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
}

// ── GRPO offline ─────────────────────────────────────────────────────────

/** The one training policy, owned by `rollout/exporters`; the `/rl` name for it. */
export type TrainingLineSelectionOptions = TrainingExportOptions

export interface GrpoLookups
  extends Pick<TrainingLineSelectionOptions, 'allowHeldOutTrainingData' | 'splitFilter'> {
  /** Resolve the prompt text for a rollout, keyed by `line.run_id`. */
  promptOf: (runId: string) => string | Promise<string>
  /** Resolve the assistant completion text for a rollout. */
  completionOf: (runId: string) => string | Promise<string>
}

export interface GrpoExportRow {
  prompt: string
  completions: string[]
  rewards: number[]
  /** runIds in the same order as `completions[]` for traceability. */
  runIds: string[]
  meta?: Record<string, unknown>
}

/**
 * Convert rollout lines grouped by `task.instance_id` into GRPO offline rows —
 * one row per scenario, with one completion per rollout on that scenario.
 * A scenario with fewer than two rewarded completions emits no row because a
 * group of one has no relative baseline.
 *
 * GRPO (Shao et al. 2024 / DeepSeek-R1) trains on relative advantages
 * within a group of completions for the same prompt; this is the
 * canonical input format. That relative baseline is exactly why the gate has
 * to hold here: one gamed sibling exporting at full reward shifts the advantage
 * of every honest run beside it.
 *
 * On the line path a realness-gated line stays in its group at reward 0 rather
 * than being dropped. 0 is the honest label for a faked success and is usable
 * signal; removing the line would also move the group's baseline, just in the
 * other direction. (SFT differs — see `toSftRows`.)
 */
export async function toGrpoRows(
  lines: MintedRolloutLine[],
  lookups: GrpoLookups,
): Promise<GrpoExportRow[]> {
  return grpoRowsFromLines(lines, lookups)
}

async function grpoRowsFromLines(
  lines: MintedRolloutLine[],
  lookups: GrpoLookups,
): Promise<GrpoExportRow[]> {
  const grouped = new Map<string, MintedRolloutLine[]>()
  for (const line of lines) {
    if (!isSplitEligible(line, lookups)) continue
    const arr = grouped.get(line.task.instance_id) ?? []
    arr.push(line)
    grouped.set(line.task.instance_id, arr)
  }

  const rows: GrpoExportRow[] = []
  for (const [scenarioId, group] of grouped.entries()) {
    if (group.length === 0) continue
    const scored: Array<{ line: MintedRolloutLine; reward: number }> = []
    for (const line of group) {
      const reward = trainableLineReward(line)
      if (reward === null) continue
      scored.push({ line, reward })
    }
    // GRPO's advantage is relative to the group mean, and a single completion
    // has no baseline.
    if (scored.length < 2) continue
    const prompts = await Promise.all(
      scored.map(({ line }) => Promise.resolve(lookups.promptOf(line.run_id))),
    )
    const prompt = prompts[0]!
    if (prompts.some((value) => value !== prompt)) {
      throw new Error(
        `toGrpoRows: scenario "${scenarioId}" resolves to different prompt text within one group`,
      )
    }
    const completions = await Promise.all(
      scored.map(({ line }) => Promise.resolve(lookups.completionOf(line.run_id))),
    )
    const rewards = scored.map(({ reward }) => reward)
    const runIds = scored.map(({ line }) => line.run_id)
    rows.push({
      prompt,
      completions,
      rewards,
      runIds,
      meta: {
        scenarioId,
        n: completions.length,
        meanReward: rewards.reduce((s, x) => s + x, 0) / rewards.length,
      },
    })
  }
  return rows
}

export function toGrpoJsonl(rows: GrpoExportRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
}

// ── SFT ──────────────────────────────────────────────────────────────────

export interface SftLookups extends TrainingLineSelectionOptions {
  /**
   * Resolve the prompt text for a GAP line (one minted without a transcript),
   * keyed by `line.run_id`. A line with a captured transcript never consults it.
   */
  promptOf: (runId: string) => string | Promise<string>
  /** Resolve the assistant completion text for a gap line. */
  completionOf: (runId: string) => string | Promise<string>
  /** Optional system message for a gap line. Default omits. */
  systemOf?: (line: MintedRolloutLine) => string | null | undefined
  /** Extra filter on top of the realness gate (e.g., low score, failed cases). */
  include?: (line: MintedRolloutLine) => boolean
}

export interface SftExportRow {
  /** The canonical chat transcript, tool turns and nullable content included. */
  messages: ChatMessage[]
  meta?: Record<string, unknown>
}

/**
 * Convert rollout lines into Hugging Face / OpenAI / Anthropic-style
 * conversational SFT rows. By default every qualifying line becomes one row;
 * pass `include` to filter further (e.g., keep only `reward >= 0.8` for
 * rejection-sampling SFT).
 *
 * Eligibility and the transcript projection belong to
 * `rollout/exporters.toSftRows`: same fail-closed policy (realness-gated lines
 * are dropped, not zeroed; `search` ships by default, held-out needs
 * `allowHeldOutTrainingData`, `splitFilter` names an explicit slice) and the
 * same copied-context drop. This adapter adds only the legacy text lookups: a
 * line whose transcript was captured is exported as captured, tool turns
 * included, and a gap line (empty `messages`, `provenance.gap` set) is
 * recovered from `promptOf` / `completionOf` / `systemOf`. `meta.transcriptSource`
 * says which path a row took. A captured transcript whose every turn is copied
 * context yields no row rather than a lookup-built substitute.
 */
export async function toSftRows(
  lines: MintedRolloutLine[],
  lookups: SftLookups,
): Promise<SftExportRow[]> {
  // Checked BEFORE any drop or lookup, so an impossible line fails loud exactly
  // like `rollout/exporters.toSftRows` rather than being filtered quietly.
  for (const line of lines) assertRewardGate(line, 'SFT export')
  const include = lookups.include ?? (() => true)
  const rows: SftExportRow[] = []
  for (const line of lines) {
    if (!isTrainingLineEligible(line, lookups) || !include(line)) continue
    const captured = line.messages.length > 0
    const messages = captured ? line.messages : await recoveredTranscript(line, lookups)
    const [row] = toCanonicalSftRows([{ ...line, messages }], lookups)
    if (row === undefined) continue
    rows.push({
      messages: row.messages,
      meta: {
        runId: line.run_id,
        rolloutId: line.rollout_id,
        candidateId: line.candidate_id ?? null,
        scenarioId: line.task.instance_id,
        score: row.metadata.reward,
        model: line.policy.model,
        transcriptSource: captured ? 'captured' : 'lookups',
        captureGap: line.provenance.gap ?? null,
        realness_gated: row.metadata.realness_gated,
        realness_screened: row.metadata.realness_screened,
      },
    })
  }
  return rows
}

/** A gap line's transcript from the text lookups. Blank or non-string text is refused. */
async function recoveredTranscript(
  line: MintedRolloutLine,
  lookups: SftLookups,
): Promise<ChatMessage[]> {
  const system = lookups.systemOf?.(line)
  const [prompt, completion] = await Promise.all([
    Promise.resolve(lookups.promptOf(line.run_id)),
    Promise.resolve(lookups.completionOf(line.run_id)),
  ])
  if (
    typeof prompt !== 'string' ||
    prompt.trim() === '' ||
    typeof completion !== 'string' ||
    completion.trim() === '' ||
    (system != null && typeof system !== 'string')
  ) {
    throw new Error(`SFT export: rollout ${line.rollout_id} has invalid text lookups`)
  }
  const messages: ChatMessage[] = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt }, { role: 'assistant', content: completion })
  return messages
}

export function toSftJsonl(rows: SftExportRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
}

// ── PRM ──────────────────────────────────────────────────────────────────

export interface PrmLookups {
  /** Resolve the prompt text for a run. */
  promptOf: (runId: string) => string | Promise<string>
  /** Resolve the trajectory step text for a (runId, spanId) pair. */
  stepTextOf: (runId: string, spanId: string) => string | Promise<string>
  /** Optional: sequence of prefix span ids leading up to the divergence. */
  prefixOf?: (runId: string, prefixStepIndex: number) => string[] | Promise<string[]>
}

export interface PrmExportRow {
  prompt: string
  /** Span ids for the steps before divergence — caller resolves text via `stepTextOf`. */
  prefixSpanIds: string[]
  prefixStepText: string[]
  chosenStep: string
  rejectedStep: string
  chosenReward: number
  rejectedReward: number
  marginScore: number
  meta?: Record<string, unknown>
}

export interface PrmLineContext extends RolloutLineContext {
  /**
   * The `maxSteps` cap the lines were minted with, if any.
   *
   * `mintRolloutRows` drops the MIDDLE of an over-long trajectory and leaves no
   * marker on the line, so a capped trajectory is indistinguishable from a
   * short one. Declaring the cap lets this exporter refuse any line sitting at
   * it — a process-reward model trained on a trajectory with a hole in it
   * learns credit assignment that never happened.
   */
  mintedWithMaxSteps?: number
}

/**
 * Convert PRM training triples to JSONL rows. Caller's `stepTextOf`
 * callback resolves span text from the consumer's trace store.
 *
 * Every referenced run is checked against its minted line before any row is
 * emitted, and the export FAILS LOUD on a trajectory that was never fully
 * captured (see `assertPrmTrainableLine`). Triples whose chosen or rejected
 * side is realness-gated are dropped instead: a capture defect is the caller's
 * mint configuration and must be fixed, whereas a gamed run is exactly the
 * condition the gate exists to filter.
 *
 * `context` is REQUIRED. A two-argument call used to be accepted and produced
 * rows with no gate applied at all — a `PrmTrainingTriple` carries a bare
 * `chosenReward` number and nothing that says which run it came from is honest,
 * so with no lines this exporter has no way to learn that its chosen step is a
 * step from a run that faked its success. It now throws: fail closed, because
 * the alternative is a process-reward model taught to prefer the gaming move at
 * the exact step the gaming happened.
 */
export async function toPrmRows(
  triples: PrmTrainingTriple[],
  lookups: PrmLookups,
  context: PrmLineContext,
): Promise<PrmExportRow[]> {
  const admitted = admitPrmTriples(triples, context)
  const rows: PrmExportRow[] = []
  for (const t of admitted) {
    const prompt = await Promise.resolve(lookups.promptOf(t.prefixRunId))
    const prefixSpanIds = lookups.prefixOf
      ? await Promise.resolve(lookups.prefixOf(t.prefixRunId, t.prefixStepIndex))
      : []
    const prefixStepText: string[] = []
    for (const spanId of prefixSpanIds) {
      prefixStepText.push(await Promise.resolve(lookups.stepTextOf(t.prefixRunId, spanId)))
    }
    const chosenStep = await Promise.resolve(lookups.stepTextOf(t.prefixRunId, t.chosenSpanId))
    const rejectedStep = await Promise.resolve(
      lookups.stepTextOf(t.rejectedRunId, t.rejectedSpanId),
    )
    rows.push({
      prompt,
      prefixSpanIds,
      prefixStepText,
      chosenStep,
      rejectedStep,
      chosenReward: t.chosenReward,
      rejectedReward: t.rejectedReward,
      marginScore: t.marginScore,
      meta: {
        prefixRunId: t.prefixRunId,
        rejectedRunId: t.rejectedRunId,
        prefixStepIndex: t.prefixStepIndex,
      },
    })
  }
  return rows
}

/**
 * Refuse to build a process-reward row from a trajectory we do not fully have.
 *
 * PRM training assigns credit step by step, so a missing or silently shortened
 * step list is not degraded data — it is data about a trajectory that never
 * existed. Every condition below throws rather than filters, because each one
 * means the CALLER's capture or mint configuration is wrong.
 */
function assertPrmTrainableLine(line: MintedRolloutLine, mintedWithMaxSteps?: number): void {
  const id = line.rollout_id
  if (line.provenance.gap !== undefined) {
    throw new Error(
      `PRM export: rollout ${id} is a gap line (${line.provenance.gap}) — refusing to build a process-reward row from a trajectory that was never captured`,
    )
  }
  if (line.steps === undefined || line.steps.length === 0) {
    throw new Error(
      `PRM export: rollout ${id} carries no steps — refusing to build a process-reward row with no trajectory`,
    )
  }
  if (line.outcome.is_truncated) {
    throw new Error(
      `PRM export: rollout ${id} is marked truncated — refusing to assign step-level credit over a partial trajectory`,
    )
  }
  if (mintedWithMaxSteps !== undefined && line.steps.length >= mintedWithMaxSteps) {
    throw new Error(
      `PRM export: rollout ${id} has ${line.steps.length} steps at the mint cap of ${mintedWithMaxSteps} — its middle steps may have been dropped, and a capped trajectory carries no marker to prove otherwise`,
    )
  }
}

const PRM_CONTEXT_REQUIREMENT: LineContextRequirement = {
  exporter: 'PRM export',
  contextType: 'PrmLineContext',
  because:
    'without the minted rollout lines this exporter cannot see the realness gate (a triple carries only a bare reward number) and cannot tell a fully-captured trajectory from a capped or empty one.',
}

/**
 * Validate every referenced line up front (fail loud, before a single row is
 * written) and then drop the triples whose evidence is realness-gated.
 *
 * The gate half is `admitUngatedByInvocation`, shared with `toDpoRows` and
 * `stepRewardsToJsonl`; only the trajectory-completeness rules are PRM's own.
 */
function admitPrmTriples(
  triples: PrmTrainingTriple[],
  context: PrmLineContext,
): PrmTrainingTriple[] {
  return admitUngatedByInvocation(
    triples,
    (t) => [t.prefixRunId, t.rejectedRunId],
    context,
    PRM_CONTEXT_REQUIREMENT,
    (line) => assertPrmTrainableLine(line, context.mintedWithMaxSteps),
  )
}

export function toPrmJsonl(rows: PrmExportRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
}

// ── Step rewards (for value-function regression) ─────────────────────────

export interface StepRewardJsonlRow {
  runId: string
  spanId: string
  stepIndex: number
  reward: number
  determinism: 'deterministic' | 'probabilistic'
  weight: number
}

const STEP_REWARD_CONTEXT_REQUIREMENT: LineContextRequirement = {
  exporter: 'step-reward export',
  contextType: 'RolloutLineContext',
  because:
    'a StepReward carries a runId and a bare per-step reward, and nothing that says whether that run faked its success — so without the minted rollout lines this exporter ships the step-level components of a gamed run at full value while the run-level scalar sits at 0 elsewhere.',
}

/**
 * Step-level reward rows as JSONL.
 *
 * `context` is REQUIRED for the same reason it is on `toDpoRows` and
 * `toPrmRows`: this is a line-less input carrying a reward number. Steps
 * belonging to a realness-gated run are dropped rather than zeroed — a
 * per-step reward of 0 across a whole trajectory is a claim that every step was
 * bad, which is a different (and false) statement from "this run's success was
 * fabricated, so its step-level credit assignment is meaningless".
 */
export function stepRewardsToJsonl(stepRewards: StepReward[], context: RolloutLineContext): string {
  const admitted = admitUngatedByInvocation(
    stepRewards,
    (s) => [s.runId],
    context,
    STEP_REWARD_CONTEXT_REQUIREMENT,
  )
  const rows: StepRewardJsonlRow[] = admitted.map((s) => ({
    runId: s.runId,
    spanId: s.spanId,
    stepIndex: s.stepIndex,
    reward: s.reward,
    determinism: s.determinism,
    weight: s.weight ?? 1,
  }))
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
}
