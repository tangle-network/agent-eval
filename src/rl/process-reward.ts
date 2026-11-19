/**
 * Process reward extraction — step-level credit assignment from trace spans.
 *
 * RL on long-horizon agents needs *step-level* rewards, not run-level
 * ones. The classic credit-assignment problem (Sutton & Barto) requires
 * knowing which sub-decisions in a trajectory contributed to the
 * outcome. Modern systems (DeepSeek-R1, OpenAI o-series, Lightman et al.
 * "Let's Verify Step by Step" 2023) train *process reward models* (PRMs)
 * that score every step, then do RL with the PRM as the reward signal.
 *
 * This module extracts `StepReward[]` from trace spans — one per
 * meaningful step — and ships:
 *
 *   1. `extractStepRewards(store, runId, opts)` — span → step-reward
 *      conversion using configurable per-span scorers (LLM judge over the
 *      span output, deterministic checkers, or a learned PRM). Each step
 *      carries a digest of the context it acted in and of the action it took.
 *   2. `runwiseStepRewardSummary(stepRewards)` — aggregate the per-step
 *      signal into a credit-assignment-aware run-level score.
 *   3. `prmTrainingPairs(stepRewardsByRun, options)` — produce the
 *      `(prefix, chosen_step, rejected_step)` triples that PRM training
 *      pipelines consume. A triple pairs two different actions taken in the
 *      same context by two different runs; nothing else is a pair.
 *
 * What we ship: the *extraction* and *aggregation* infrastructure plus
 * the data shape PRM training expects. We do NOT ship the actual PRM
 * training (gradient descent over a transformer is out of scope for a
 * TS package). The interface is the contract; downstream consumers wire
 * their preferred trainer.
 *
 * Caveat: a pair says that, from one recorded context, one action was
 * followed by a higher step reward than another. The reward is still the
 * scorer's; whether the action caused it needs counterfactual rollouts or a
 * learned dynamics model.
 */

import { hashCanonical, jsonDocument, LedgerCanonicalizationError } from '../ledger-core/canonical'
import type { Span } from '../trace/schema'
import type { TraceStore } from '../trace/store'

export interface StepReward {
  /** Trace span this reward attaches to. */
  spanId: string
  runId: string
  /**
   * Position of the span among ALL spans of the run, 0-based, ordered by
   * `startedAt` with ties kept in store order. Spans no scorer scored and spans
   * `preFilter` dropped still take a position, so spans `0..stepIndex - 1` of
   * the run are exactly the spans recorded before this step.
   */
  stepIndex: number
  /** Span kind (typically 'tool', 'llm', 'judge'). */
  kind: Span['kind']
  /** Span name — for the consumer's downstream filtering. */
  name: string
  /** Step-level reward in [0, 1]. */
  reward: number
  /**
   * Determinism class. Mirrors the verifiable-reward distinction:
   * deterministic = test/compile/schema check; probabilistic = LLM judge.
   */
  determinism: 'deterministic' | 'probabilistic'
  /** Optional rationale / evidence — the trainer typically discards. */
  rationale?: string
  /** Optional weight — how much this step contributes to credit assignment. */
  weight?: number
  /**
   * Digest of everything the policy could have seen before acting at this
   * step: the run's scenario id, the recorded content of every span ordered
   * before this one in the run (all fields, attributes included, except
   * identifiers, timestamps, token and cost accounting and the model id), and
   * this step's own input (an llm span's `messages`). Two steps with the same
   * context digest acted in the same context. A value a producer writes per run
   * into a span therefore keeps that run from matching any other.
   *
   * Absent when any of that was not recorded: a run the store does not know,
   * an llm span with no `messages` or an earlier one with no `output`, an
   * earlier tool call whose arguments or result were not captured. Absent means
   * unknown and is never treated as a match.
   */
  contextDigest?: string
  /**
   * Digest of what the step did: its kind, its name and its decision (an llm
   * span's `output`, a tool call's name and arguments, a retrieval's query).
   * Absent when the decision was not recorded or the span kind makes none.
   */
  actionDigest?: string
}

/** What a scorer returns for one span. `extractStepRewards` fills in the identity fields. */
export type ScoredStep = Omit<StepReward, 'spanId' | 'runId' | 'stepIndex'>

export interface StepScorer {
  /** Span kinds this scorer applies to. */
  appliesTo: Span['kind'][]
  /**
   * Returns null to skip the span. A `contextDigest` or `actionDigest` the
   * scorer returns replaces the one computed from the trace — for a caller that
   * holds a real fork or checkpoint identity for the step.
   */
  score(span: Span): ScoredStep | null | undefined | Promise<ScoredStep | null | undefined>
}

export interface ExtractStepRewardsOptions {
  /**
   * Ordered list of scorers. Each span runs through scorers in order;
   * the first non-null result wins. If no scorer applies, the span is
   * skipped (not all spans are training-worthy).
   */
  scorers: StepScorer[]
  /**
   * Optional filter — return false to drop the span before scoring. A dropped
   * span still counts toward `stepIndex` and the context of later steps.
   */
  preFilter?: (span: Span) => boolean
}

export async function extractStepRewards(
  store: TraceStore,
  runId: string,
  opts: ExtractStepRewardsOptions,
): Promise<StepReward[]> {
  const scenarioId = (await store.getRun(runId))?.scenarioId
  const spans = await store.spans({ runId })
  const ordered = [...spans].sort((a, b) => a.startedAt - b.startedAt)
  const positionOf = new Map(ordered.map((span, position) => [span.spanId, position]))
  // The context chain: the scenario, then every span recorded so far. It is
  // undefined for a run with no scenario id, and from the first span whose
  // content is not fully recorded.
  let prefix = scenarioId ? digestOf({ scenarioId }) : undefined
  const out: StepReward[] = []
  for (const [position, span] of ordered.entries()) {
    const record = spanRecord(span, positionOf)
    const input = span.kind === 'llm' ? (record.messages ?? UNRECORDED) : undefined
    const action = actionOf(span)
    const contextBefore = prefix
    // A tool call with neither a result nor an error leaves unknown what came back.
    const complete =
      input !== UNRECORDED &&
      action !== UNRECORDED &&
      (span.kind !== 'tool' || span.result !== undefined || span.error !== undefined)
    prefix = prefix !== undefined && complete ? digestOf({ prefix, span: record }) : undefined
    if (opts.preFilter && !opts.preFilter(span)) continue
    let scored: ScoredStep | null | undefined = null
    for (const s of opts.scorers) {
      if (!s.appliesTo.includes(span.kind)) continue
      const r = await s.score(span)
      if (r) {
        scored = r
        break
      }
    }
    if (!scored) continue
    const contextDigest =
      scored.contextDigest ??
      (contextBefore === undefined || input === UNRECORDED
        ? undefined
        : digestOf({ prefix: contextBefore, input }))
    const actionDigest =
      scored.actionDigest ??
      (action === undefined || action === UNRECORDED
        ? undefined
        : digestOf({ kind: span.kind, name: span.name, action }))
    out.push({
      spanId: span.spanId,
      runId,
      stepIndex: position,
      kind: span.kind,
      name: span.name,
      reward: scored.reward,
      determinism: scored.determinism,
      rationale: scored.rationale,
      weight: scored.weight,
      ...(contextDigest === undefined ? {} : { contextDigest }),
      ...(actionDigest === undefined ? {} : { actionDigest }),
    })
  }
  return out
}

// ── Span content ─────────────────────────────────────────────────────────

/** A part the span's kind carries and the trace does not. */
const UNRECORDED = Symbol('unrecorded')

/**
 * Fields left out of a span's record: identifiers, timestamps, and token and
 * cost accounting differ between runs that saw and did the same thing, and the
 * model is the policy, not the context. Every other field is content, so a
 * field the schema gains later makes contexts more specific, never less.
 */
const NOT_CONTENT = new Set([
  'spanId',
  'parentSpanId',
  'runId',
  'startedAt',
  'endedAt',
  'latencyMs',
  'wallMs',
  'model',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'costUsd',
  'tokens',
])

const contentOf = (value: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !NOT_CONTENT.has(key)))

/**
 * A span's recorded content as later steps saw it. An llm span's messages are
 * missing when none were captured, and a judge's target is named by its
 * position in the run, so the same target reads the same in two runs.
 */
function spanRecord(span: Span, positionOf: ReadonlyMap<string, number>): Record<string, unknown> {
  const record = contentOf(span)
  if (span.kind === 'llm') {
    record.messages =
      Array.isArray(span.messages) && span.messages.length > 0
        ? span.messages.map(contentOf)
        : undefined
  }
  if (span.kind === 'judge') {
    record.targetSpanId = positionOf.get(span.targetSpanId) ?? span.targetSpanId
  }
  return record
}

/**
 * The decision a step made: an llm span's `output`, a tool call's name and
 * arguments, a retrieval's query. Judge, sandbox, agent and custom spans make
 * no policy decision — a judge grades, the harness runs the sandbox, a
 * container only groups — so they shape later contexts and are never paired.
 */
function actionOf(span: Span): unknown {
  switch (span.kind) {
    case 'llm':
      return typeof span.output === 'string' ? span.output : UNRECORDED
    case 'tool':
      return span.argsCaptured === false || span.args === undefined
        ? UNRECORDED
        : { toolName: span.toolName, args: span.args }
    case 'retrieval':
      return typeof span.query === 'string' ? { query: span.query } : UNRECORDED
    default:
      return undefined
  }
}

/**
 * The canonical digest of `value` in its JSON document form, where an
 * undefined field is absent. Content with no canonical form (NaN, a class
 * instance) has no digest, the same as content that was never recorded.
 */
function digestOf(value: unknown): string | undefined {
  try {
    return hashCanonical(jsonDocument(value))
  } catch (error) {
    if (error instanceof LedgerCanonicalizationError) return undefined
    throw error
  }
}

// ── Run-level summary ────────────────────────────────────────────────────

export interface RunwiseStepSummary {
  runId: string
  totalSteps: number
  meanReward: number
  /** Sum-of-rewards (weighted by `weight ?? 1`). Use as the run-level proxy. */
  sumWeightedReward: number
  /** Fraction of steps where reward < 0.5 — proxy for "where the policy was wrong." */
  failureFraction: number
  /** Maximum drop in reward between consecutive steps — diagnoses a step where things went sideways. */
  worstStepDelta: number
  worstStepIndex: number | null
}

export function runwiseStepRewardSummary(stepRewards: StepReward[]): RunwiseStepSummary {
  if (stepRewards.length === 0) {
    return {
      runId: '',
      totalSteps: 0,
      meanReward: 0,
      sumWeightedReward: 0,
      failureFraction: 0,
      worstStepDelta: 0,
      worstStepIndex: null,
    }
  }
  const runId = stepRewards[0]!.runId
  let sumW = 0
  let sumWR = 0
  let failures = 0
  let worstDelta = 0
  let worstIdx: number | null = null
  let prev = stepRewards[0]!.reward
  for (let i = 0; i < stepRewards.length; i++) {
    const s = stepRewards[i]!
    const w = s.weight ?? 1
    sumW += w
    sumWR += w * s.reward
    if (s.reward < 0.5) failures++
    if (i > 0) {
      const delta = s.reward - prev
      if (delta < worstDelta) {
        worstDelta = delta
        worstIdx = i
      }
      prev = s.reward
    } else {
      prev = s.reward
    }
  }
  return {
    runId,
    totalSteps: stepRewards.length,
    meanReward: sumW === 0 ? 0 : sumWR / sumW,
    sumWeightedReward: sumWR,
    failureFraction: failures / stepRewards.length,
    worstStepDelta: worstDelta,
    worstStepIndex: worstIdx,
  }
}

// ── PRM training pairs ───────────────────────────────────────────────────

export interface PrmTrainingTriple {
  /** The context digest both steps carry: they acted in the same context. */
  contextDigest: string
  /** Run the chosen step came from; the prefix is read from this run. */
  prefixRunId: string
  /**
   * `stepIndex` of the span just before the chosen step in `prefixRunId`, or
   * -1 when nothing precedes it. Spans `0..prefixStepIndex` are the recorded
   * prefix of the shared context.
   */
  prefixStepIndex: number
  /** The step with the higher reward. */
  chosenSpanId: string
  chosenReward: number
  /** A different action from the same context, in another run, with the lower reward. */
  rejectedSpanId: string
  rejectedReward: number
  /** Run the rejected step came from; never `prefixRunId`. */
  rejectedRunId: string
  marginScore: number
}

/**
 * What `prmTrainingPairs` built, and how much of its input it could not use.
 * Zero triples with every count zero means there was nothing to pair; zero
 * triples with steps counted here means the evidence for a pair was missing.
 */
export interface PrmPairingResult {
  triples: PrmTrainingTriple[]
  /** Steps with no context digest: something before them, or their own input, was not recorded. */
  stepsWithoutContextDigest: number
  /** Steps with a context digest and no action digest: what they did was not recorded. */
  stepsWithoutActionDigest: number
  /** Contexts that only one run reached, so no alternative action was recorded there. */
  singleRunContexts: number
  /** Contexts reached by two or more runs that all took the same action there. */
  sameActionContexts: number
}

/**
 * Build PRM training triples — the `(prefix, chosen_step, rejected_step)`
 * shape of Lightman et al. and DeepSeek-R1 process supervision.
 *
 * Two steps form a pair only when all of these hold:
 *   - they come from different runs;
 *   - they carry the same `contextDigest`, so they acted in the same context;
 *   - they carry different `actionDigest`s — the same action in the same
 *     context with two rewards is scorer noise, not a preference;
 *   - their rewards differ, by at least `minMargin` (default 0.2).
 * The higher-reward step is `chosen`. Steps are grouped by context digest
 * across all runs, so every qualifying pair in a context becomes a triple.
 * A step with no digest is counted in the result and never paired.
 */
export function prmTrainingPairs(
  stepRewardsByRun: Map<string, StepReward[]>,
  opts: { minMargin?: number } = {},
): PrmPairingResult {
  const minMargin = opts.minMargin ?? 0.2
  if (!Number.isFinite(minMargin) || minMargin < 0) {
    throw new RangeError(
      `prmTrainingPairs: minMargin must be a finite number >= 0, got ${minMargin}`,
    )
  }
  const result: PrmPairingResult = {
    triples: [],
    stepsWithoutContextDigest: 0,
    stepsWithoutActionDigest: 0,
    singleRunContexts: 0,
    sameActionContexts: 0,
  }
  const byContext = new Map<string, StepReward[]>()
  for (const steps of stepRewardsByRun.values()) {
    for (const step of steps) {
      if (!step.contextDigest) result.stepsWithoutContextDigest++
      else if (!step.actionDigest) result.stepsWithoutActionDigest++
      else byContext.set(step.contextDigest, [...(byContext.get(step.contextDigest) ?? []), step])
    }
  }
  for (const [contextDigest, group] of byContext) {
    if (new Set(group.map((s) => s.runId)).size < 2) {
      result.singleRunContexts++
      continue
    }
    if (new Set(group.map((s) => s.actionDigest)).size < 2) {
      result.sameActionContexts++
      continue
    }
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!
        const b = group[j]!
        if (a.runId === b.runId || a.actionDigest === b.actionDigest) continue
        const margin = Math.abs(a.reward - b.reward)
        if (!(margin > 0 && margin >= minMargin)) continue
        const [chosen, rejected] = a.reward > b.reward ? [a, b] : [b, a]
        result.triples.push({
          contextDigest,
          prefixRunId: chosen.runId,
          prefixStepIndex: chosen.stepIndex - 1,
          chosenSpanId: chosen.spanId,
          chosenReward: chosen.reward,
          rejectedSpanId: rejected.spanId,
          rejectedReward: rejected.reward,
          rejectedRunId: rejected.runId,
          marginScore: chosen.reward - rejected.reward,
        })
      }
    }
  }
  return result
}
