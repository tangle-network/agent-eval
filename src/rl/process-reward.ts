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
 *      pipelines consume: two different actions taken in the same context,
 *      compared on their mean reward across the runs that took them.
 *
 * What we ship: the *extraction* and *aggregation* infrastructure plus
 * the data shape PRM training expects. We do NOT ship the actual PRM
 * training (gradient descent over a transformer is out of scope for a
 * TS package). The interface is the contract; downstream consumers wire
 * their preferred trainer.
 *
 * A step's context is what had been recorded by the time it started: the
 * start of every earlier span and the end of every span that had already
 * ended. That is a timing boundary. It does not prove the policy read an
 * earlier span's output, only that the output existed before the step began.
 *
 * Caveat: a pair says that, from one recorded context, one action was
 * followed by a higher mean step reward than another. The reward is still the
 * scorer's; whether the action caused it needs counterfactual rollouts or a
 * learned dynamics model.
 */

import {
  compareCodeUnits,
  hashCanonical,
  jsonDocument,
  LedgerCanonicalizationError,
} from '../ledger-core/canonical'
import { defaultScenarioId } from '../trace/emitter'
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
   * the run are exactly the spans that started before this step.
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
   * Digest of what was observable when this step started: the run's scenario
   * id, then in time order the start of every span that started before this
   * one and the end of every span that had ended by then, then this step's own
   * input (an llm span's `messages`). Two steps with the same context digest
   * acted in the same context.
   *
   * A span's start carries every recorded field except its end fields (see
   * `END_FIELDS`), identifiers, timestamps, token and cost accounting and the
   * model id — attributes included, unless `contextAttributes` narrows them. A
   * value a producer writes per run into a span therefore keeps that run from
   * matching any other.
   *
   * Absent when any of that was not recorded, and absent means unknown, never a
   * match: a run the store does not know, a run whose scenario id is the
   * emitter's default (no task identity), an llm span with no `messages`, an
   * earlier llm span that ended with neither output nor error, an earlier tool
   * call whose arguments were not captured or that ended with neither result
   * nor error. A span still open when this step started is not missing
   * evidence: only its start was observable.
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
  /**
   * The keys of each span's `attributes` that count as context. Default: all
   * of them. Recorders commonly write per-run values (request ids, session
   * ids) into attributes, and with every key counted no two such runs share a
   * context. Naming keys here is the caller asserting that the attributes it
   * leaves out were not observable to the policy.
   */
  contextAttributes?: readonly string[]
}

/**
 * Score a recorded run's spans and attach to each step the digest of its
 * context and of its action.
 *
 * The context is built from a time-ordered chain of events: each span adds its
 * start content at `startedAt` and its end content (`END_FIELDS`) at
 * `endedAt`. A step's context digest is the chain just before its own start,
 * plus its own input. This is a timing boundary: it says what had been
 * recorded when the step began, not that the policy read it.
 */
export async function extractStepRewards(
  store: TraceStore,
  runId: string,
  opts: ExtractStepRewardsOptions,
): Promise<StepReward[]> {
  const run = await store.getRun(runId)
  const spans = await store.spans({ runId })
  const ordered = [...spans].sort((a, b) => a.startedAt - b.startedAt)
  const positionOf = new Map(ordered.map((span, position) => [span.spanId, position]))
  const attributeKeys =
    opts.contextAttributes === undefined ? undefined : new Set(opts.contextAttributes)
  // A defaulted scenario id names the run's layer, not its task.
  const task =
    run?.scenarioId && run.scenarioId !== defaultScenarioId(run) ? run.scenarioId : undefined
  // The context chain. It is undefined from the first observable content that
  // was not recorded, and for a run with no task identity.
  let chain = task === undefined ? undefined : digestOf({ scenarioId: task })
  const fold = (event: Record<string, unknown>, recorded: boolean): void => {
    chain = chain === undefined || !recorded ? undefined : digestOf({ prefix: chain, event })
  }
  // Started spans whose end has not been folded into the chain, in start order.
  let running: number[] = []
  const out: StepReward[] = []
  for (const [position, span] of ordered.entries()) {
    // The ends observable at this start, in end order with ties in start order.
    const ended = running
      .filter((p) => endedBy(ordered[p]!, span.startedAt))
      .sort((a, b) => ordered[a]!.endedAt! - ordered[b]!.endedAt! || a - b)
    for (const p of ended) {
      const earlier = ordered[p]!
      fold({ end: p, content: endContent(earlier) }, endRecorded(earlier))
    }
    running = running.filter((p) => !ended.includes(p))

    // This span's own start is the next event, so it is not part of its own context.
    const start = startContent(span, positionOf, attributeKeys)
    const input = span.kind === 'llm' ? (start.messages ?? UNRECORDED) : undefined
    const action = actionOf(span)
    const contextBefore = chain
    fold({ start: position, content: start }, input !== UNRECORDED && action !== UNRECORDED)
    running.push(position)

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
 * Fields left out of a span's content: identifiers, timestamps, and token and
 * cost accounting differ between runs that saw and did the same thing, and the
 * model is the policy, not the context.
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

/**
 * Fields that exist only once a span has ended, so they are observable only
 * after `endedAt`. Every other content field, including `attributes` and any
 * field the schema gains later, counts as known from `startedAt` — the strict
 * reading, since a field read too early can only make contexts differ.
 */
const END_FIELDS = new Set([
  'output',
  'finishReason',
  'result',
  'hits',
  'score',
  'rationale',
  'evidence',
  'exitCode',
  'testsTotal',
  'testsPassed',
  'stdoutHash',
  'stderrHash',
  'status',
  'error',
])

function contentOf(value: object, keep: (key: string) => boolean): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !NOT_CONTENT.has(key) && keep(key)),
  )
}

/**
 * What a span carried when it started. An llm span's messages are missing when
 * none were captured; a judge's target is named by its position in the run, so
 * the same target reads the same in two runs.
 */
function startContent(
  span: Span,
  positionOf: ReadonlyMap<string, number>,
  attributeKeys: ReadonlySet<string> | undefined,
): Record<string, unknown> {
  const content = contentOf(span, (key) => !END_FIELDS.has(key))
  if (span.kind === 'llm') {
    content.messages =
      Array.isArray(span.messages) && span.messages.length > 0
        ? span.messages.map((message) => contentOf(message, () => true))
        : undefined
  }
  if (span.kind === 'judge') {
    content.targetSpanId = positionOf.get(span.targetSpanId) ?? span.targetSpanId
  }
  if (attributeKeys !== undefined && span.attributes !== undefined) {
    const kept = Object.entries(span.attributes).filter(([key]) => attributeKeys.has(key))
    content.attributes = kept.length > 0 ? Object.fromEntries(kept) : undefined
  }
  return content
}

/** What a span carried once it ended. */
function endContent(span: Span): Record<string, unknown> {
  return contentOf(span, (key) => END_FIELDS.has(key))
}

/** Whether the span had ended by `time`. A span that never ended never has. */
function endedBy(span: Span, time: number): boolean {
  return span.endedAt !== undefined && span.endedAt <= time
}

/**
 * Whether an ended span recorded what it produced: an llm span its output or
 * error, a tool call its result or error, a retrieval its hits.
 */
function endRecorded(span: Span): boolean {
  switch (span.kind) {
    case 'llm':
      return typeof span.output === 'string' || span.error !== undefined
    case 'tool':
      return span.result !== undefined || span.error !== undefined
    case 'retrieval':
      return Array.isArray(span.hits) || span.error !== undefined
    default:
      return true
  }
}

/**
 * The decision a step made: an llm span's `output`, a tool call's name and
 * arguments, a retrieval's query. Judge, sandbox, agent and custom spans make
 * no policy decision — a judge grades, the harness runs the sandbox, a
 * container only groups — so they shape later contexts and are never paired.
 * A tool call's arguments and a retrieval's query are known at its start, so an
 * uncaptured one leaves the context unknown from that start on.
 */
function actionOf(span: Span): unknown {
  switch (span.kind) {
    case 'llm':
      return typeof span.output === 'string' ? span.output : undefined
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
 * instance, a reference cycle) has no digest, the same as content that was
 * never recorded.
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
  /** Index into the given step rewards of the step after the worst drop; null when no reward dropped. */
  worstStepIndex: number | null
}

/** Summarize one run's step rewards, given in step order. */
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
  /** The context digest every step behind both means carries. */
  contextDigest: string
  /** Run of the chosen representative step; the prefix is read from this run. */
  prefixRunId: string
  /**
   * `stepIndex` of the span just before the chosen step in `prefixRunId`, or
   * -1 when nothing precedes it. Spans `0..prefixStepIndex` are the spans that
   * started before the chosen step; one still open then contributed only its
   * start to the shared context.
   */
  prefixStepIndex: number
  /** The representative step of the action with the higher mean reward. */
  chosenSpanId: string
  /** Mean reward of the chosen action over `chosenStepCount` steps. */
  chosenReward: number
  /** Steps behind `chosenReward`. */
  chosenStepCount: number
  /** Every run behind `chosenReward`, sorted. */
  chosenRunIds: string[]
  /** The representative step of the other action, from a different run. */
  rejectedSpanId: string
  /** Mean reward of the rejected action over `rejectedStepCount` steps. */
  rejectedReward: number
  /** Steps behind `rejectedReward`. */
  rejectedStepCount: number
  /** Every run behind `rejectedReward`, sorted. */
  rejectedRunIds: string[]
  /** Run of the rejected representative step; never `prefixRunId`. */
  rejectedRunId: string
  /** `chosenReward - rejectedReward`. */
  marginScore: number
}

/**
 * What `prmTrainingPairs` built, and how much of its input it could not use.
 * Zero triples with every count zero means there was nothing to pair; zero
 * triples with steps counted here means the evidence for a pair was missing.
 */
export interface PrmPairingResult {
  triples: PrmTrainingTriple[]
  /** Steps with no context digest: something observable before them, or their own input, was not recorded. */
  stepsWithoutContextDigest: number
  /** Steps with a context digest and no action digest: what they did was not recorded. */
  stepsWithoutActionDigest: number
  /** Contexts that only one run reached, so no alternative action was recorded there. */
  singleRunContexts: number
  /** Contexts reached by two or more runs that all took the same action there. */
  sameActionContexts: number
  /** Pairs of actions in one context whose mean rewards differ by less than `minMargin`, or not at all. */
  actionPairsBelowMargin: number
  /** Pairs of actions in one context that no two different runs can represent. */
  actionPairsInOneRun: number
}

/**
 * Build PRM training triples — the `(prefix, chosen_step, rejected_step)`
 * shape of Lightman et al. and DeepSeek-R1 process supervision.
 *
 * Steps are grouped by `contextDigest` across all runs, and within a context by
 * `actionDigest`. Each action's reward is its mean over every step that took
 * it there, so the same action scored twice is one estimate, not two
 * preferences. Two actions in one context form one triple when:
 *   - their mean rewards differ, by at least `minMargin` (default 0.2);
 *   - two different runs can represent them.
 * The higher-mean action is `chosen`. Its representative is its step with the
 * lowest run id, then span id; the rejected representative is the other
 * action's first step, in the same order, from a different run. When the
 * chosen action's first step has no such partner, its next step is tried.
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
    actionPairsBelowMargin: 0,
    actionPairsInOneRun: 0,
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
    const actions = actionsIn(group)
    if (actions.length < 2) {
      result.sameActionContexts++
      continue
    }
    for (let i = 0; i < actions.length; i++) {
      for (let j = i + 1; j < actions.length; j++) {
        const a = actions[i]!
        const b = actions[j]!
        const [chosen, rejected] = a.mean >= b.mean ? [a, b] : [b, a]
        const margin = chosen.mean - rejected.mean
        if (!(margin > 0 && margin >= minMargin)) {
          result.actionPairsBelowMargin++
          continue
        }
        const representatives = representativesOf(chosen.steps, rejected.steps)
        if (representatives === undefined) {
          result.actionPairsInOneRun++
          continue
        }
        const [chosenStep, rejectedStep] = representatives
        result.triples.push({
          contextDigest,
          prefixRunId: chosenStep.runId,
          prefixStepIndex: chosenStep.stepIndex - 1,
          chosenSpanId: chosenStep.spanId,
          chosenReward: chosen.mean,
          chosenStepCount: chosen.steps.length,
          chosenRunIds: runIdsOf(chosen.steps),
          rejectedSpanId: rejectedStep.spanId,
          rejectedReward: rejected.mean,
          rejectedStepCount: rejected.steps.length,
          rejectedRunIds: runIdsOf(rejected.steps),
          rejectedRunId: rejectedStep.runId,
          marginScore: margin,
        })
      }
    }
  }
  return result
}

interface ActionInContext {
  /** The action's steps, ordered by run id, then span id. */
  steps: StepReward[]
  mean: number
}

/** A context's steps grouped by action, in first-seen order. */
function actionsIn(group: readonly StepReward[]): ActionInContext[] {
  const byAction = new Map<string, StepReward[]>()
  for (const step of group) {
    const digest = step.actionDigest!
    byAction.set(digest, [...(byAction.get(digest) ?? []), step])
  }
  return [...byAction.values()].map((steps) => ({
    steps: [...steps].sort(byRunThenSpan),
    mean: steps.reduce((sum, s) => sum + s.reward, 0) / steps.length,
  }))
}

/** The first chosen step, in order, that a rejected step from another run can face. */
function representativesOf(
  chosen: readonly StepReward[],
  rejected: readonly StepReward[],
): [StepReward, StepReward] | undefined {
  for (const c of chosen) {
    const r = rejected.find((s) => s.runId !== c.runId)
    if (r !== undefined) return [c, r]
  }
  return undefined
}

function byRunThenSpan(a: StepReward, b: StepReward): number {
  return compareCodeUnits(a.runId, b.runId) || compareCodeUnits(a.spanId, b.spanId)
}

function runIdsOf(steps: readonly StepReward[]): string[] {
  return [...new Set(steps.map((s) => s.runId))].sort(compareCodeUnits)
}
