/**
 * Rollout minting — `tangle.rollout.v1` lines joined from the records the
 * substrate ALREADY keeps. There is no separate rollout store: a rollout
 * is the JOIN of a RunRecord (identity, provenance, cost, outcome) with
 * its trace (spans share `runId`), projected into the canonical line.
 *
 * Composition, not duplication:
 *   - identity/provenance     → `RunRecord` (candidateId, splitTag, agentProfile, hashes)
 *   - step structure          → `buildTrajectory` over the shared TraceStore
 *   - preference-pair export  → `feedbackTrajectoryToOptimizerRow` (feedback-trajectory.ts)
 *   - PRM / reward-model      → `reward-model-export.ts`
 *
 * Anti-Goodhart invariant: a run whose `outcome.realness.gated` is true is
 * never exported with a positive reward OR with any of the numbers that reward
 * was computed from. The gate travels into the training data (`reward` forced
 * to 0, `realness_gated: true`) and the whole outcome is transformed by
 * `gateGamedOutcome` inside `assertMinted` below, which relocates `metrics` and
 * `verdict` to `provenance.gated_evidence`. Mint returns
 * `MintedRolloutLine[]`: the brand the training exporters require, which only
 * this function, `readRolloutLedger`, and an explicit `assertMinted` can mint.
 *
 * A record carrying NEITHER split score becomes `reward: null` (with
 * `reward_source: 'run-record/unscored'`), never 0 — "nobody graded this" is
 * not the same claim as "graded a total failure", and a trainer reading 0
 * learns the second.
 *
 * Records without spans become labeled GAP LINES (messages: [],
 * provenance.gap) — present in the output AND surfaced in
 * `missingTraces`; a capture gap is a finding, never a silent omission.
 */

import type { RunRecord } from '../run-record'
import type { LlmSpan, Message, Span, ToolSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { buildTrajectory } from '../trajectory'
import { rolloutRewardFields, scoreOrigin } from './reward'
import {
  assertMinted,
  type ChatMessage,
  type MintedRolloutLine,
  ROLLOUT_SCHEMA,
  type RolloutRole,
  type RolloutSplit,
  type RolloutStep,
} from './schema'

/** Redactor applied to every exported string (secrets, PII). Identity by default. */
export type RolloutScrubber = (text: string) => string

export interface MintRolloutOptions {
  scrub?: RolloutScrubber
  /** Cap steps per line (longest runs first drop middle steps). Default: no cap. */
  maxSteps?: number
  /** Role recorded on every minted line. Default 'agent' (a solo eval run). */
  role?: RolloutRole
  /** Task suite label. Default: the record's `experimentId`. */
  suite?: string
  /** Injected clock for deterministic output. */
  now?: () => Date
}

export interface MintRolloutResult {
  rows: MintedRolloutLine[]
  /** runIds that had a RunRecord but no spans — emitted as gap lines AND listed here. */
  missingTraces: string[]
}

const asText = (v: unknown, scrub: RolloutScrubber): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return scrub(s ?? '')
}

function projectStep(span: Span, scrub: RolloutScrubber): RolloutStep {
  const base: RolloutStep = {
    kind: span.kind,
    name: scrub(span.name),
    status: span.status,
    durationMs: span.endedAt !== undefined ? span.endedAt - span.startedAt : undefined,
  }
  if (span.kind === 'llm') {
    const llm = span as LlmSpan
    const last = llm.messages[llm.messages.length - 1]
    if (last) base.input = scrub(last.content)
    if (llm.output !== undefined) base.output = scrub(llm.output)
  } else if (span.kind === 'tool') {
    const tool = span as ToolSpan
    base.input = asText(tool.args, scrub)
    if (tool.result !== undefined) base.output = asText(tool.result, scrub)
  }
  return base
}

/** The final llm span's history + output is the completed conversation. */
function finalConversation(spans: Span[], scrub: RolloutScrubber): ChatMessage[] {
  const llms = spans.filter((s): s is LlmSpan => s.kind === 'llm')
  const last = llms[llms.length - 1]
  if (!last) return []
  const messages: ChatMessage[] = last.messages.map((m: Message) => ({
    role: m.role,
    content: scrub(m.content),
  }))
  if (last.output !== undefined && last.output !== '') {
    messages.push({ role: 'assistant', content: scrub(last.output) })
  }
  return messages
}

// The reward derivations live in the leaf module `./reward` so gate and
// reporting code can import them without dragging in the trace store; they are
// re-exported here because `rolloutReward` shipped from this path.
export {
  isRealnessGated,
  observedScore,
  observedSplitScore,
  rolloutReward,
  type ScoreOrigin,
  type ScorePreference,
  scoreOrigin,
  trainingReward,
  trainingScore,
} from './reward'

const REWARD_SOURCE: Record<ReturnType<typeof scoreOrigin>, string> = {
  holdout: 'run-record/holdout-score',
  search: 'run-record/search-score',
  unscored: 'run-record/unscored',
}

const SPLIT_FROM_TAG: Record<RunRecord['splitTag'], RolloutSplit> = {
  search: 'search',
  dev: 'dev',
  holdout: 'holdout',
}

function mintLine(
  record: RunRecord,
  steps: RolloutStep[],
  messages: ChatMessage[],
  options: MintRolloutOptions,
  capturedAt: string,
  gap?: string,
): MintedRolloutLine {
  // `reward` and `realness_gated` come out of one call, so neither door into
  // the waist can write one and forget the other.
  const rewardFields = rolloutRewardFields(record)
  const uncaptured = record.costProvenance?.kind === 'uncaptured'
  // `assertMinted` rather than a cast: mint is the producer the whole gate
  // rests on, so it proves the line it just built is valid instead of asserting
  // it by fiat. The brand is unforgeable precisely because nobody casts to it.
  return assertMinted(
    {
      schema: ROLLOUT_SCHEMA,
      rollout_id: record.runId,
      parent_rollout_id: null,
      run_id: record.runId,
      experiment_id: record.experimentId,
      candidate_id: record.candidateId,
      generation: null,
      candidate_index: null,
      role: options.role ?? 'agent',
      task: {
        suite: options.suite ?? record.experimentId,
        instance_id: record.scenarioId ?? record.experimentId,
        split: SPLIT_FROM_TAG[record.splitTag],
        seed: record.seed,
        rep: 0,
      },
      policy: {
        harness: null,
        harness_version: null,
        model: record.model,
        provider: null,
        profile_commit: record.commitSha,
        prompt_hash: record.promptHash,
        config_hash: record.configHash,
        agent_profile_cell_id: record.agentProfile?.cellId ?? null,
        sampling: null,
      },
      messages,
      tool_defs: [],
      ...(steps.length > 0 ? { steps } : {}),
      outcome: {
        ...rewardFields,
        reward_source: REWARD_SOURCE[scoreOrigin(record)],
        verdict: null,
        // A verbatim bulk copy, deliberately UNFILTERED here. `outcome.raw`
        // holds the per-layer verifier scores (`layer.*`) that the reward was
        // derived from, so on a gated run this dict is the reward signal in
        // component form — but filtering it at this call site is the pattern
        // that has now leaked twice, because the next producer to write a
        // reward-bearing field forgets. The gate is applied to the whole
        // outcome once, in `assertMinted` below (`gateGamedOutcome`), which
        // moves the block to `provenance.gated_evidence` when the run is gated
        // and leaves it here untouched when it is not.
        metrics: { ...record.outcome.raw },
        is_completed: true,
        is_truncated: false,
        error: null,
      },
      cost: {
        usd: uncaptured ? null : record.costUsd,
        tokens_in: record.tokenUsage.input,
        tokens_out: record.tokenUsage.output,
        tokens_reasoning: record.tokenUsage.reasoning ?? null,
        cache_read: record.tokenUsage.cached ?? null,
        cache_write: record.tokenUsage.cacheWrite ?? null,
        wall_s: Math.round(record.wallMs / 1000),
      },
      artifacts: { patch_path: null, run_dir: null, transcript_ref: null },
      provenance: {
        captured_at: capturedAt,
        capture: 'mint',
        ...(gap !== undefined ? { gap } : {}),
      },
    },
    `minted rollout line for run ${record.runId}`,
  )
}

/**
 * Join RunRecords with their traces into canonical rollout lines. Records
 * without spans are emitted as labeled gap lines and reported in
 * `missingTraces` — a capture gap is a finding, not a silent omission.
 */
export async function mintRolloutRows(
  records: RunRecord[],
  store: TraceStore,
  options: MintRolloutOptions = {},
): Promise<MintRolloutResult> {
  const scrub = options.scrub ?? ((t) => t)
  const capturedAt = (options.now?.() ?? new Date()).toISOString()
  const rows: MintedRolloutLine[] = []
  const missingTraces: string[] = []
  for (const record of records) {
    const trajectory = await buildTrajectory(store, record.runId)
    if (trajectory.steps.length === 0) {
      missingTraces.push(record.runId)
      rows.push(
        mintLine(record, [], [], options, capturedAt, 'no trace spans recorded for this runId'),
      )
      continue
    }
    let steps = trajectory.steps.map((s) => projectStep(s.span, scrub))
    if (options.maxSteps !== undefined && steps.length > options.maxSteps) {
      // Keep the head and tail — the middle of a long run is the least
      // informative for outcome attribution.
      const head = Math.ceil(options.maxSteps / 2)
      const tail = options.maxSteps - head
      steps = [...steps.slice(0, head), ...steps.slice(steps.length - tail)]
    }
    const conversation = finalConversation(
      trajectory.steps.map((s) => s.span),
      scrub,
    )
    const gap =
      conversation.length === 0 ? 'trace has no llm spans — no conversation to inline' : undefined
    rows.push(mintLine(record, steps, conversation, options, capturedAt, gap))
  }
  return { rows, missingTraces }
}
