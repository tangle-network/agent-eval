/**
 * Trainer-format exporters.
 *
 * agent-eval produces canonical artifacts (`RunRecord[]`, `PreferenceTriple[]`,
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
 * canonical artifacts (`RunRecord[]`, `PreferenceTriple[]`, etc.) are
 * agent-eval's contract; without first-party exporters consumers reverse-
 * engineer the mapping every release. The exporters codify it.
 *
 * The exporters take callbacks for any field that isn't on the canonical
 * artifact (specifically: prompt + completion text, since the package
 * stores only their hashes by design — full text is the consumer's
 * trace store / raw event log).
 */

import { type RunRecord, runTaskScore } from '../run-record'
import type { PreferenceTriple } from './preferences'
import type { PrmTrainingTriple, StepReward } from './process-reward'

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

/**
 * Convert preference triples to TRL-compatible DPO rows. The shape
 * `{prompt, chosen, rejected}` is the canonical HuggingFace DPODataset
 * entry; every major DPO trainer accepts it.
 */
export async function toDpoRows(
  triples: PreferenceTriple[],
  lookups: DpoLookups,
): Promise<DpoExportRow[]> {
  const out: DpoExportRow[] = []
  for (const t of triples) {
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

export interface TrainingRunSelectionOptions {
  /** Include held-out evaluation data in training output. Default false. */
  allowHeldOutTrainingData?: boolean
  /** Require quality to be strictly greater than this value. Default 0. */
  minimumQualityExclusive?: number
}

export interface GrpoLookups extends TrainingRunSelectionOptions {
  promptOf: (runId: string) => string | Promise<string>
  completionOf: (runId: string) => string | Promise<string>
  /** Optional: derive a custom reward from the run. Defaults to score. */
  rewardOf?: (run: RunRecord) => number | null
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
 * Convert RunRecord[] grouped by canonical `(scenarioId, promptHash)` identity
 * into GRPO offline rows.
 *
 * GRPO (Shao et al. 2024 / DeepSeek-R1) trains on relative advantages
 * within a group of completions for the same prompt; this is the
 * canonical input format. A scenario containing multiple prompt hashes, or a
 * prompt hash that resolves to different text, is rejected rather than mixed.
 */
export async function toGrpoRows(
  runs: RunRecord[],
  lookups: GrpoLookups,
): Promise<GrpoExportRow[]> {
  const rewardOf = lookups.rewardOf ?? defaultReward
  const promptHashByScenario = new Map<string, string>()
  const grouped = new Map<
    string,
    {
      scenarioId: string
      promptHash: string
      scored: Array<{ run: RunRecord; reward: number }>
    }
  >()
  for (const r of runs) {
    const reward = rewardOf(r)
    if (!isTrainingRunEligible(r, reward, lookups)) continue

    const existingPromptHash = promptHashByScenario.get(r.scenarioId)
    if (existingPromptHash !== undefined && existingPromptHash !== r.promptHash) {
      throw new Error(
        `toGrpoRows: scenario "${r.scenarioId}" contains mixed prompt identities ` +
          `"${existingPromptHash}" and "${r.promptHash}"`,
      )
    }
    promptHashByScenario.set(r.scenarioId, r.promptHash)

    const key = `${r.scenarioId}\u0000${r.promptHash}`
    const group = grouped.get(key) ?? {
      scenarioId: r.scenarioId,
      promptHash: r.promptHash,
      scored: [],
    }
    group.scored.push({ run: r, reward: reward as number })
    grouped.set(key, group)
  }

  const rows: GrpoExportRow[] = []
  for (const { scenarioId, promptHash, scored } of grouped.values()) {
    if (scored.length < 2) continue
    const prompts = await Promise.all(
      scored.map(({ run }) => Promise.resolve(lookups.promptOf(run.runId))),
    )
    const prompt = prompts[0]!
    if (prompts.some((value) => value !== prompt)) {
      throw new Error(
        `toGrpoRows: prompt identity "${promptHash}" resolves to different text within scenario "${scenarioId}"`,
      )
    }
    const completions = await Promise.all(
      scored.map(({ run }) => Promise.resolve(lookups.completionOf(run.runId))),
    )
    const rewards = scored.map(({ reward }) => reward)
    const runIds = scored.map(({ run }) => run.runId)
    rows.push({
      prompt,
      completions,
      rewards,
      runIds,
      meta: {
        scenarioId,
        promptHash,
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

export interface SftLookups extends TrainingRunSelectionOptions {
  promptOf: (runId: string) => string | Promise<string>
  completionOf: (runId: string) => string | Promise<string>
  /** Optional system message. Default omits. */
  systemOf?: (run: RunRecord) => string | null | undefined
  /** Filter — return false to skip the run (e.g., low score, failed cases). */
  include?: (run: RunRecord) => boolean
}

export interface SftExportRow {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  meta?: Record<string, unknown>
}

/**
 * Convert RunRecord[] into Hugging Face / OpenAI / Anthropic-style
 * conversational SFT rows. By default, only completed, positive-quality
 * search runs are eligible. Pass `include` for additional filtering.
 */
export async function toSftRows(runs: RunRecord[], lookups: SftLookups): Promise<SftExportRow[]> {
  const include = lookups.include ?? (() => true)
  const rows: SftExportRow[] = []
  for (const r of runs) {
    const score = runTaskScore(r)
    if (!isTrainingRunEligible(r, score, lookups)) continue
    if (!include(r)) continue
    const system = lookups.systemOf?.(r)
    const [prompt, completion] = await Promise.all([
      Promise.resolve(lookups.promptOf(r.runId)),
      Promise.resolve(lookups.completionOf(r.runId)),
    ])
    const messages: SftExportRow['messages'] = []
    if (system) messages.push({ role: 'system', content: system })
    messages.push({ role: 'user', content: prompt })
    messages.push({ role: 'assistant', content: completion })
    rows.push({
      messages,
      meta: {
        runId: r.runId,
        candidateId: r.candidateId,
        scenarioId: r.scenarioId,
        score,
        model: r.model,
      },
    })
  }
  return rows
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

/**
 * Convert PRM training triples to JSONL rows. Caller's `stepTextOf`
 * callback resolves span text from the consumer's trace store.
 */
export async function toPrmRows(
  triples: PrmTrainingTriple[],
  lookups: PrmLookups,
): Promise<PrmExportRow[]> {
  const rows: PrmExportRow[] = []
  for (const t of triples) {
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

export function stepRewardsToJsonl(stepRewards: StepReward[]): string {
  const rows: StepRewardJsonlRow[] = stepRewards.map((s) => ({
    runId: s.runId,
    spanId: s.spanId,
    stepIndex: s.stepIndex,
    reward: s.reward,
    determinism: s.determinism,
    weight: s.weight ?? 1,
  }))
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
}

// ── Helpers ──────────────────────────────────────────────────────────────

function defaultReward(run: RunRecord): number | null {
  return runTaskScore(run) ?? null
}

export function isTrainingRunEligible(
  run: RunRecord,
  quality: number | null | undefined,
  options: TrainingRunSelectionOptions = {},
): quality is number {
  const minimumQualityExclusive = options.minimumQualityExclusive ?? 0
  if (!Number.isFinite(minimumQualityExclusive)) {
    throw new Error('minimumQualityExclusive must be finite')
  }
  if (quality === null || quality === undefined) return false
  if (!Number.isFinite(quality)) {
    throw new Error(`training quality for run "${run.runId}" must be finite`)
  }
  if (quality <= minimumQualityExclusive) return false
  if (run.terminalOutcome !== 'succeeded') return false
  if (run.failureClass !== undefined || run.terminalFailureReason !== undefined) return false
  if (run.outcome.realness?.gated === true) return false
  if (run.splitTag === 'search') return true
  return run.splitTag === 'holdout' && options.allowHeldOutTrainingData === true
}
