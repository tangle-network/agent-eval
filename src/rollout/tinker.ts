/** Tinker RL Datum projection of the canonical rollout waist; no client or training loop. */
import { assessShareSafety, shareAllowed } from '../trace/redact'
import { isSplitEligible, type TrainingExportOptions } from './exporters'
import { defaultRolloutScrubber } from './release/scrub'
import { assertMinted, assertRewardGate, type MintedRolloutLine, type RolloutStep } from './schema'

/** JSON wire projection of Tinker's text-only Datum; the consumer constructs SDK objects. */
export interface TinkerDatum {
  model_input: { chunks: Array<{ type: 'encoded_text'; tokens: number[] }> }
  loss_fn_inputs: {
    target_tokens: { data: number[]; dtype: 'int64'; shape: [number] }
    logprobs: { data: number[]; dtype: 'float32'; shape: [number] }
    advantages: { data: number[]; dtype: 'float32'; shape: [number] }
  }
}

export interface TinkerDatumRow {
  /** Only this object goes to the Tinker SDK. Attribution stays with the caller. */
  datum: TinkerDatum
  rollout_id: string
  run_id: string
  instance_id: string
  step_index: number
  reward: number
  realness_gated: false
  realness_screened: boolean | null
}

export interface TinkerExportOptions
  extends Pick<TrainingExportOptions, 'allowHeldOutTrainingData'> {
  /** Exact model identity of the captured tokenizer/sampling policy. */
  model: string
  /** Offline decoder for that model. Never re-tokenize or fabricate missing sampling data. */
  decodeTokens: (tokens: readonly number[]) => string
  /** Caller owns group baselines; a reward is not silently treated as an advantage. */
  advantageOf: (line: MintedRolloutLine, stepIndex: number) => number
}

function safeText(text: string, context: string): void {
  // Scrubbing text while retaining its original token ids would transmit the very bytes removed.
  if (
    defaultRolloutScrubber(text) !== text ||
    !shareAllowed(assessShareSafety(text, { profile: 'share' }))
  ) {
    throw new Error(`Tinker export: ${context} needs scrubbing; recapture approved token data`)
  }
}

function tokenIds(tokens: number[] | undefined, context: string): number[] {
  if (!tokens?.length || tokens.some((id) => !Number.isSafeInteger(id) || id < 0)) {
    throw new Error(`Tinker export: ${context} requires captured nonempty token ids`)
  }
  return [...tokens]
}

function projectStep(
  step: RolloutStep,
  line: MintedRolloutLine,
  stepIndex: number,
  options: TinkerExportOptions,
): TinkerDatumRow {
  if (step.llm_call_count !== 1) {
    throw new Error(
      `Tinker export: ${line.rollout_id} step ${stepIndex} must name one captured model call`,
    )
  }
  const prompt = tokenIds(step.prompt_token_ids, 'prompt')
  const completion = tokenIds(step.completion_token_ids, 'completion')
  const logprobs = step.logprobs === undefined ? undefined : [...step.logprobs]
  if (
    !logprobs ||
    logprobs.length !== completion.length ||
    logprobs.some((p) => !Number.isFinite(Math.fround(p)) || p > 0)
  ) {
    throw new Error(
      `Tinker export: ${line.rollout_id} step ${stepIndex} needs aligned sampling logprobs`,
    )
  }
  safeText(options.decodeTokens(prompt), 'decoded prompt')
  safeText(options.decodeTokens(completion), 'decoded completion')
  const advantage = options.advantageOf(line, stepIndex)
  if (
    typeof advantage !== 'number' ||
    !Number.isFinite(advantage) ||
    !Number.isFinite(Math.fround(advantage))
  ) {
    throw new Error('Tinker export: advantage must be a finite number that fits float32')
  }
  const full = [...prompt, ...completion]
  safeText(options.decodeTokens(full), 'decoded sequence')
  const prefix = Array<number>(prompt.length - 1).fill(0)
  const length = full.length - 1
  return {
    datum: {
      model_input: { chunks: [{ type: 'encoded_text', tokens: full.slice(0, -1) }] },
      loss_fn_inputs: {
        target_tokens: { data: full.slice(1), dtype: 'int64', shape: [length] },
        logprobs: { data: [...prefix, ...logprobs], dtype: 'float32', shape: [length] },
        advantages: {
          data: [...prefix, ...completion.map(() => advantage)],
          dtype: 'float32',
          shape: [length],
        },
      },
    },
    rollout_id: line.rollout_id,
    run_id: line.run_id,
    instance_id: line.task.instance_id,
    step_index: stepIndex,
    reward: line.outcome.reward!,
    realness_gated: false,
    realness_screened: line.outcome.realness_screened ?? null,
  }
}

/**
 * Project known-reward completed search rollouts, including honest zero/negative rewards.
 * Unknown rewards, gated/lossy/incomplete runs and ineligible splits do not become training data.
 * Missing capture on an otherwise eligible model call refuses the batch, never invents tokens.
 * The caller retains the canonical ledger and owns Tinker sampling/forward_backward/optim_step.
 */
export function toTinkerDatumRows(
  lines: readonly MintedRolloutLine[],
  options: TinkerExportOptions,
): TinkerDatumRow[] {
  if (!options.model) throw new Error('Tinker export: captured model identity is required')
  const rows: TinkerDatumRow[] = []
  const identities = new Set<string>()
  for (const supplied of lines) {
    const line = assertMinted(supplied, 'Tinker rollout')
    assertRewardGate(line, 'Tinker export')
    if (identities.has(line.rollout_id))
      throw new Error(`Tinker export: duplicate rollout ${line.rollout_id}`)
    identities.add(line.rollout_id)
    if (
      !isSplitEligible(line, { allowHeldOutTrainingData: options.allowHeldOutTrainingData }) ||
      line.outcome.reward === null ||
      line.outcome.realness_gated ||
      !line.outcome.is_completed ||
      line.outcome.is_truncated ||
      line.outcome.error !== null ||
      line.provenance.lossy_projection === true
    )
      continue
    if (!Number.isFinite(line.outcome.reward))
      throw new Error('Tinker export: reward must be finite')
    if (line.policy.model !== options.model)
      throw new Error('Tinker export: captured model identity differs')
    if (line.messages.some((message) => message.is_copied_context)) {
      throw new Error('Tinker export: copied context has no captured token mask')
    }
    const steps = line.steps
    if (!steps?.some((step) => step.kind === 'llm'))
      throw new Error('Tinker export: no captured model steps')
    safeText(
      JSON.stringify({ messages: line.messages, steps, tool_defs: line.tool_defs }),
      'rollout content',
    )
    for (const [index, step] of steps.entries()) {
      if (step.kind === 'llm') rows.push(projectStep(step, line, index, options))
    }
  }
  return rows
}
