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
 * Anti-Goodhart invariant: a run whose `outcome.realness.gated` is true
 * is never exported with a positive reward — the gate travels into the
 * training data (`reward` forced to 0, `realness_gated: true`), so a
 * fine-tune cannot learn from gamed successes.
 *
 * Records without spans become labeled GAP LINES (messages: [],
 * provenance.gap) — present in the output AND surfaced in
 * `missingTraces`; a capture gap is a finding, never a silent omission.
 */

import type { RunRecord } from '../run-record'
import type { LlmSpan, Message, Span, ToolSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import { buildTrajectory } from '../trajectory'
import {
  type ChatMessage,
  ROLLOUT_SCHEMA,
  type RolloutLine,
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
  rows: RolloutLine[]
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

export function rolloutReward(record: RunRecord): { reward: number; gated: boolean } {
  const gated = record.outcome.realness?.gated === true
  const raw = record.outcome.holdoutScore ?? record.outcome.searchScore ?? 0
  return { reward: gated ? 0 : raw, gated }
}

function rewardSource(record: RunRecord): string {
  if (record.outcome.holdoutScore !== undefined) return 'run-record/holdout-score'
  if (record.outcome.searchScore !== undefined) return 'run-record/search-score'
  return 'run-record/unscored'
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
): RolloutLine {
  const { reward, gated } = rolloutReward(record)
  const uncaptured = record.costProvenance?.kind === 'uncaptured'
  return {
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
      reward,
      reward_source: rewardSource(record),
      verdict: null,
      metrics: { ...record.outcome.raw },
      is_completed: true,
      is_truncated: false,
      error: null,
      realness_gated: gated,
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
  }
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
  const rows: RolloutLine[] = []
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
