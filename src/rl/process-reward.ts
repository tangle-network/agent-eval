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
import type { Message, Span } from '../trace/schema'
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
   * before this one in the run, and this step's own input. Two steps with the
   * same context digest acted in the same context.
   *
   * Absent when any of that was not recorded: an unknown run, an earlier llm
   * span with no `output`, an earlier tool call whose arguments or result were
   * not captured. Absent means unknown, never "matches nothing in particular".
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
  const run = await store.getRun(runId)
  const spans = await store.spans({ runId })
  const ordered = [...spans].sort((a, b) => a.startedAt - b.startedAt)
  const positionOf = new Map(ordered.map((span, position) => [span.spanId, position]))
  // The context chain: a digest of the scenario and every span recorded so
  // far. It is undefined for a run with no scenario id, and from the first
  // span whose content is unknown.
  const scenarioId = run?.scenarioId
  let prefix =
    typeof scenarioId === 'string' && scenarioId.length > 0 ? digestOf({ scenarioId }) : undefined
  const out: StepReward[] = []
  for (const [position, span] of ordered.entries()) {
    const content = spanContent(span, positionOf)
    const prefixBefore = prefix
    prefix = prefixBefore === undefined ? undefined : extendContext(prefixBefore, span, content)
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
    const contextDigest = scored.contextDigest ?? stepContextDigest(prefixBefore, content)
    const actionDigest = scored.actionDigest ?? stepActionDigest(span, content)
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

// ── Span content: input, action, observation ─────────────────────────────

/**
 * One part of a span's recorded content. `absent` means the span's kind has no
 * such part; `unrecorded` means the kind has one and the trace does not carry
 * it, so nothing that depends on it can be digested.
 */
type ContentPart = { recorded: unknown } | 'absent' | 'unrecorded'

interface SpanContent {
  /** What the span was handed to act on. */
  input: ContentPart
  /** What the policy chose to do. Only a span with a recorded action is pairable. */
  action: ContentPart
  /** What came back, or the record of a span the policy did not choose. */
  observation: ContentPart
}

/**
 * Split a span into input, action and observation, using the fields
 * `trace/schema.ts` defines for its kind:
 *
 *   llm            input = messages (role, content, images), action = output,
 *                  observation = error
 *   tool           action = { toolName, args }, observation = { result, error }
 *   retrieval      action = { query }, observation = { hits, error }
 *   judge          observation = { judgeId, dimension, score, rationale,
 *                  evidence, target }
 *   sandbox        observation = { image, command, exitCode, test counts,
 *                  output hashes, error }
 *   agent, custom  observation = { attributes, status, error }
 *
 * Judge, sandbox, agent and custom spans make no policy decision — a judge
 * grades, the harness runs the sandbox, and a container only groups — so they
 * shape the context of later steps and are never paired.
 *
 * Span ids, timestamps, token and cost accounting, and the model id are left
 * out: they differ between runs that saw and did the same thing, and the model
 * is the policy, not the context. A judge's target is named by its position in
 * the run, so the same target in two runs reads the same. An undefined field
 * inside a recorded part is dropped, as a JSON document drops it.
 */
function spanContent(span: Span, positionOf: ReadonlyMap<string, number>): SpanContent {
  const error = span.error
  switch (span.kind) {
    case 'llm':
      return {
        input:
          Array.isArray(span.messages) && span.messages.length > 0
            ? { recorded: span.messages.map(messageContent) }
            : 'unrecorded',
        action: typeof span.output === 'string' ? { recorded: span.output } : 'unrecorded',
        observation: error === undefined ? 'absent' : { recorded: { error } },
      }
    case 'tool':
      return {
        input: 'absent',
        action:
          span.argsCaptured === false || span.args === undefined
            ? 'unrecorded'
            : { recorded: { toolName: span.toolName, args: span.args } },
        observation:
          span.result === undefined && error === undefined
            ? 'unrecorded'
            : { recorded: { result: span.result, error } },
      }
    case 'retrieval':
      return {
        input: 'absent',
        action: typeof span.query === 'string' ? { recorded: { query: span.query } } : 'unrecorded',
        observation: Array.isArray(span.hits)
          ? { recorded: { hits: span.hits, error } }
          : 'unrecorded',
      }
    case 'judge':
      return {
        input: 'absent',
        action: 'absent',
        observation: {
          recorded: {
            judgeId: span.judgeId,
            dimension: span.dimension,
            score: span.score,
            rationale: span.rationale,
            evidence: span.evidence,
            target: positionOf.get(span.targetSpanId) ?? span.targetSpanId,
            error,
          },
        },
      }
    case 'sandbox':
      return {
        input: 'absent',
        action: 'absent',
        observation: {
          recorded: {
            image: span.image,
            command: span.command,
            exitCode: span.exitCode,
            testsTotal: span.testsTotal,
            testsPassed: span.testsPassed,
            stdoutHash: span.stdoutHash,
            stderrHash: span.stderrHash,
            error,
          },
        },
      }
    default:
      return {
        input: 'absent',
        action: 'absent',
        observation: { recorded: { attributes: span.attributes, status: span.status, error } },
      }
  }
}

/** A message as the model read it; its token count depends on the model, so it is left out. */
function messageContent(message: Message): unknown {
  return { role: message.role, content: message.content, images: message.images }
}

/**
 * The canonical digest of `value` in its JSON document form, or undefined when
 * the value has no canonical form (NaN, a class instance). Such content cannot
 * be compared, the same as content that was never recorded.
 */
function digestOf(value: unknown): string | undefined {
  try {
    return hashCanonical(jsonDocument(value))
  } catch (error) {
    if (error instanceof LedgerCanonicalizationError) return undefined
    throw error
  }
}

function recordedOrOmitted(key: string, part: ContentPart): Record<string, unknown> {
  return typeof part === 'object' ? { [key]: part.recorded } : {}
}

/** The context after `span`: undefined when any part its kind carries is unrecorded. */
function extendContext(prefix: string, span: Span, content: SpanContent): string | undefined {
  const { input, action, observation } = content
  if (input === 'unrecorded' || action === 'unrecorded' || observation === 'unrecorded') {
    return undefined
  }
  return digestOf({
    prefix,
    span: {
      kind: span.kind,
      name: span.name,
      ...recordedOrOmitted('input', input),
      ...recordedOrOmitted('action', action),
      ...recordedOrOmitted('observation', observation),
    },
  })
}

function stepContextDigest(prefix: string | undefined, content: SpanContent): string | undefined {
  if (prefix === undefined || content.input === 'unrecorded') return undefined
  return digestOf({ prefix, ...recordedOrOmitted('input', content.input) })
}

function stepActionDigest(span: Span, content: SpanContent): string | undefined {
  if (typeof content.action !== 'object') return undefined
  return digestOf({ kind: span.kind, name: span.name, action: content.action.recorded })
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
  /** Pairs of different actions in one context whose rewards differ by less than `minMargin`. */
  pairsBelowMargin: number
}

export interface PrmTrainingPairsOptions {
  /** Smallest reward gap that makes a preference. Default 0.2. */
  minMargin?: number
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
 *   - their rewards differ by at least `minMargin`.
 * The higher-reward step is `chosen`. Steps are grouped by context digest
 * across all runs, so every qualifying pair in a context becomes a triple.
 * A step with no digest is counted in the result and never paired.
 */
export function prmTrainingPairs(
  stepRewardsByRun: Map<string, StepReward[]>,
  opts: PrmTrainingPairsOptions = {},
): PrmPairingResult {
  const minMargin = opts.minMargin ?? 0.2
  if (!Number.isFinite(minMargin) || minMargin < 0) {
    throw new RangeError(
      `prmTrainingPairs: minMargin must be a finite number >= 0, got ${minMargin}`,
    )
  }
  const byContext = new Map<string, StepReward[]>()
  let stepsWithoutContextDigest = 0
  let stepsWithoutActionDigest = 0
  for (const steps of stepRewardsByRun.values()) {
    for (const step of steps) {
      if (!isDigest(step.contextDigest)) stepsWithoutContextDigest++
      else if (!isDigest(step.actionDigest)) stepsWithoutActionDigest++
      else {
        const group = byContext.get(step.contextDigest)
        if (group === undefined) byContext.set(step.contextDigest, [step])
        else group.push(step)
      }
    }
  }

  const triples: PrmTrainingTriple[] = []
  let singleRunContexts = 0
  let sameActionContexts = 0
  let pairsBelowMargin = 0
  for (const [contextDigest, group] of byContext) {
    if (new Set(group.map((s) => s.runId)).size < 2) {
      singleRunContexts++
      continue
    }
    if (new Set(group.map((s) => s.actionDigest)).size < 2) {
      sameActionContexts++
      continue
    }
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!
        const b = group[j]!
        if (a.runId === b.runId || a.actionDigest === b.actionDigest) continue
        const margin = Math.abs(a.reward - b.reward)
        if (!(margin > 0 && margin >= minMargin)) {
          pairsBelowMargin++
          continue
        }
        const [chosen, rejected] = a.reward > b.reward ? [a, b] : [b, a]
        triples.push({
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
  return {
    triples,
    stepsWithoutContextDigest,
    stepsWithoutActionDigest,
    singleRunContexts,
    sameActionContexts,
    pairsBelowMargin,
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
