/**
 * Rollout export — `tangle.rollout.v1` training rows minted from the
 * records the substrate ALREADY keeps. There is no separate rollout
 * store: a rollout is the JOIN of a RunRecord (identity, provenance,
 * cost, outcome) with its trace (spans share `runId`), optionally
 * annotated with feedback labels. This module performs that join and
 * serializes it to fine-tune-ready formats.
 *
 * Composition, not duplication:
 *   - identity/provenance     → `RunRecord` (candidateId, splitTag, agentProfile, hashes)
 *   - step structure          → `buildTrajectory` over the shared TraceStore
 *   - preference-pair export  → `feedbackTrajectoryToOptimizerRow` (feedback-trajectory.ts)
 *   - PRM / reward-model      → `reward-model-export.ts`
 *   This module adds only the joined row + SFT/reward serialization,
 *   which none of the above produce.
 *
 * Anti-Goodhart invariant: a run whose `outcome.realness.gated` is true
 * is never exported with a positive reward — the gate travels into the
 * training data, so a fine-tune cannot learn from gamed successes.
 */

import type { RunRecord } from './run-record'
import type { LlmSpan, Message, Span, ToolSpan } from './trace/schema'
import type { TraceStore } from './trace/store'
import { buildTrajectory } from './trajectory'

export const ROLLOUT_FORMAT = 'tangle.rollout.v1' as const

/** Compact, serialization-safe projection of one span for training rows. */
export interface RolloutStep {
  kind: Span['kind']
  name: string
  /** llm: last-message summary · tool: stringified args. Scrubbed. */
  input?: string
  /** llm: output text · tool: stringified result. Scrubbed. */
  output?: string
  status?: 'ok' | 'error'
  durationMs?: number
}

export interface RolloutRow {
  format: typeof ROLLOUT_FORMAT
  runId: string
  experimentId: string
  candidateId: string
  scenarioId?: string
  splitTag: RunRecord['splitTag']
  model: string
  /** Canonical profile-cell identity when the record carries one. */
  agentProfileCellId?: string
  /** holdoutScore ?? searchScore, forced to 0 when realness-gated. */
  reward: number
  /** True when `outcome.realness.gated` — excluded from SFT positives. */
  realnessGated: boolean
  costUsd: number
  totalTokens: number
  steps: RolloutStep[]
  /** Full message history of the final llm span — the SFT conversation. */
  conversation: Message[]
}

/** Redactor applied to every exported string (secrets, PII). Identity by default. */
export type RolloutScrubber = (text: string) => string

export interface MintRolloutOptions {
  scrub?: RolloutScrubber
  /** Cap steps per row (longest runs first drop middle steps). Default: no cap. */
  maxSteps?: number
}

export interface MintRolloutResult {
  rows: RolloutRow[]
  /** runIds that had a RunRecord but no spans — surfaced, never silently dropped. */
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

function scrubMessages(messages: Message[], scrub: RolloutScrubber): Message[] {
  return messages.map((m) => ({ ...m, content: scrub(m.content) }))
}

/** The final llm span's history + output is the completed conversation. */
function finalConversation(spans: Span[], scrub: RolloutScrubber): Message[] {
  const llms = spans.filter((s): s is LlmSpan => s.kind === 'llm')
  const last = llms[llms.length - 1]
  if (!last) return []
  const messages = scrubMessages(last.messages, scrub)
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

/**
 * Join RunRecords with their traces into rollout rows. Records without
 * spans are reported in `missingTraces` — a capture gap is a finding,
 * not a silent omission.
 */
export async function mintRolloutRows(
  records: RunRecord[],
  store: TraceStore,
  options: MintRolloutOptions = {},
): Promise<MintRolloutResult> {
  const scrub = options.scrub ?? ((t) => t)
  const rows: RolloutRow[] = []
  const missingTraces: string[] = []
  for (const record of records) {
    const trajectory = await buildTrajectory(store, record.runId)
    if (trajectory.steps.length === 0) {
      missingTraces.push(record.runId)
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
    const { reward, gated } = rolloutReward(record)
    rows.push({
      format: ROLLOUT_FORMAT,
      runId: record.runId,
      experimentId: record.experimentId,
      candidateId: record.candidateId,
      scenarioId: record.scenarioId,
      splitTag: record.splitTag,
      model: record.model,
      agentProfileCellId: record.agentProfile?.cellId,
      reward,
      realnessGated: gated,
      costUsd: record.costUsd,
      totalTokens: record.tokenUsage.input + record.tokenUsage.output,
      steps,
      conversation: finalConversation(
        trajectory.steps.map((s) => s.span),
        scrub,
      ),
    })
  }
  return { rows, missingTraces }
}

// ── Serialization ────────────────────────────────────────────────────

export interface SftExportOptions {
  /** Export only rows with reward ≥ this (default 1 = clean successes only). */
  minReward?: number
}

export interface SftRow {
  messages: Message[]
  metadata: { runId: string; candidateId: string; scenarioId?: string; reward: number }
}

/**
 * Supervised fine-tune rows: the completed conversation of each
 * qualifying rollout. Realness-gated rows never qualify (reward forced
 * to 0 at mint time).
 */
export function toSftRows(rows: RolloutRow[], options: SftExportOptions = {}): SftRow[] {
  const minReward = options.minReward ?? 1
  return rows
    .filter((r) => r.reward >= minReward && !r.realnessGated && r.conversation.length > 0)
    .map((r) => ({
      messages: r.conversation,
      metadata: {
        runId: r.runId,
        candidateId: r.candidateId,
        scenarioId: r.scenarioId,
        reward: r.reward,
      },
    }))
}

export interface RewardRow {
  prompt: string
  steps: RolloutStep[]
  reward: number
  metadata: {
    runId: string
    candidateId: string
    scenarioId?: string
    splitTag: RunRecord['splitTag']
  }
}

/**
 * Reward-labeled rows (RFT / verifiers-style): every rollout, success or
 * failure, with its scalar reward. Failures are signal here — only the
 * realness-gate zeroing is applied, never filtering.
 */
export function toRewardRows(rows: RolloutRow[]): RewardRow[] {
  return rows.map((r) => ({
    prompt: r.conversation.find((m) => m.role === 'user')?.content ?? '',
    steps: r.steps,
    reward: r.reward,
    metadata: {
      runId: r.runId,
      candidateId: r.candidateId,
      scenarioId: r.scenarioId,
      splitTag: r.splitTag,
    },
  }))
}

/** One JSON object per line — the interchange format for every export. */
export function toJsonl(rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')
}
