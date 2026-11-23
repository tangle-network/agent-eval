// How real a simulated user is, measured against recorded real users.
//
// At sampled real user turns, the driver writes the next user message from
// the same recorded context the real user saw. A System One decision point is
// shown the context and the two messages, in both orders, and picks the one
// the real user wrote. Accuracy is reported per independent conversation with
// a cluster bootstrap interval; 50% means the judge cannot tell the driver from
// the real user.
//
// The measure is a same-context comparison: a row must carry the identity that
// proves its context, `userTurnContextDigest` of the conversation's task and
// the visible context, and a row without it is refused, as the PRM pair rule
// never pairs a step without a context digest. The PRM's own chain digest
// cannot serve here: it digests a step's input, which already contains the
// real user's message.

import type { FindingCalibration } from '../analyst/finding-scope'
import type { FindingsLedger, FindingsLedgerOutcome } from '../analyst/findings-ledger'
import type { EvidenceRef } from '../analyst/types'
import type { CostLedgerHandle } from '../cost-ledger/contract'
import {
  DECISION_POINT_MIN_KAPPA,
  type DecisionPointResult,
  type DecisionQuestions,
  decisionPoint,
  decisionQuestionDigest,
} from '../decision-point'
import { hashCanonical, jsonDocument } from '../ledger-core/canonical'
import { clusterBootstrapMean } from '../meta-eval/cluster-bootstrap'
import { makeRng } from '../statistics/internal'
import type { SystemOneEvaluatorOptions } from '../systemone'
import { runTaskId } from '../trace/emitter'
import type { Run } from '../trace/schema'
import type { Trajectory } from '../trajectory'
import { driverViewMessages, requestUserReply } from './conversation'
import { DEFAULT_USER_ENDING, type SimulatedUserOptions, simulatedUserSetup } from './rollout'
import type {
  MultishotPersona,
  MultishotTransportRequest,
  MultishotTransportResponse,
} from './types'

/** One real user turn and the context the user wrote it in. */
export interface RecordedUserTurn {
  /** The independent unit: one recorded conversation. */
  conversationId: string
  /** The task the conversation served. Absent when the record names none. */
  taskId?: string
  /** Index of the message among the conversation's user messages; the opener is 0. */
  turn: number
  /** What the user saw before writing: user and agent messages, in order. */
  context: Array<{ role: 'user' | 'assistant'; content: string }>
  /** `userTurnContextDigest` of `taskId` and `context`; absent without a task. */
  contextDigest?: string
  realMessage: string
  /** Where the turn was recorded. */
  evidenceRefs?: EvidenceRef[]
}

/** The shared-context identity of a user turn: its task and visible context. */
export function userTurnContextDigest(input: {
  taskId: string
  context: RecordedUserTurn['context']
}): string {
  return hashCanonical(jsonDocument({ taskId: input.taskId, context: input.context }))
}

/**
 * The real user turns of one recorded conversation, from its trajectory: each
 * model call whose input ends in a user message that answers an agent message
 * is one turn. System and tool messages are not part of what the user saw. A
 * run without a task identity yields rows without a context digest.
 */
export function recordedUserTurns(
  trajectory: Trajectory,
  run: Pick<Run, 'scenarioId' | 'layer' | 'tags'> | undefined,
): RecordedUserTurn[] {
  const taskId = runTaskId(run)
  const turns: RecordedUserTurn[] = []
  const seen = new Set<number>()
  for (const step of trajectory.steps) {
    const span = step.span
    if (span.kind !== 'llm') continue
    const last = span.messages.at(-1)
    if (last?.role !== 'user' || last.content.trim().length === 0) continue
    const context = span.messages
      .slice(0, -1)
      .filter(
        (message): message is typeof message & { role: 'user' | 'assistant' } =>
          (message.role === 'user' || message.role === 'assistant') &&
          message.content.trim().length > 0,
      )
      .map((message) => ({ role: message.role, content: message.content }))
    if (context.at(-1)?.role !== 'assistant') continue
    const turn = context.filter((message) => message.role === 'user').length
    if (seen.has(turn)) continue
    seen.add(turn)
    turns.push({
      conversationId: trajectory.runId,
      ...(taskId === undefined
        ? {}
        : { taskId, contextDigest: userTurnContextDigest({ taskId, context }) }),
      turn,
      context,
      realMessage: last.content,
      evidenceRefs: [{ kind: 'span', uri: span.spanId }],
    })
  }
  return turns
}

/** A recorded turn carries no proof of a shared context, or a proof its
 *  context does not match. */
export class SharedContextIdentityError extends Error {
  readonly conversationId: string
  readonly turn: number
  constructor(row: Pick<RecordedUserTurn, 'conversationId' | 'turn'>, reason: string) {
    super(
      `recorded user turn ${row.conversationId}#${row.turn} ${reason}; a realism comparison ` +
        "needs the identity that proves the driver saw the real user's context",
    )
    this.name = 'SharedContextIdentityError'
    this.conversationId = row.conversationId
    this.turn = row.turn
  }
}

function assertSharedContext(row: RecordedUserTurn): void {
  if (!row.taskId || !row.contextDigest) {
    throw new SharedContextIdentityError(row, 'has no task identity and context digest')
  }
  if (userTurnContextDigest({ taskId: row.taskId, context: row.context }) !== row.contextDigest) {
    throw new SharedContextIdentityError(row, 'has a context digest its context does not match')
  }
}

/** Writes the user's next message for a recorded context. */
export interface RealismDriver {
  /** Stable identity of everything that shapes the driver's message. */
  identity: string
  next(input: {
    turn: RecordedUserTurn
    signal?: AbortSignal
    costLedger?: CostLedgerHandle
  }): Promise<string>
}

/**
 * The simulated user a rollout runs, as a realism driver: the same prompt,
 * the same driver point of view on the recorded context, the same model
 * rotation. An ending marker is removed, as a rollout removes it.
 */
export function simulatedUserDriver<TPersona extends MultishotPersona>(opts: {
  user: SimulatedUserOptions<TPersona>
  /** The persona the user plays for a recorded conversation. */
  persona: (turn: RecordedUserTurn) => TPersona
  plan?: string
}): RealismDriver {
  const ending = opts.user.ending ?? DEFAULT_USER_ENDING
  const models = [opts.user.model, ...(opts.user.fallbackModels ?? [])]
  return {
    identity: `simulated-user:${hashCanonical(
      jsonDocument({
        models,
        rigor: opts.user.rigor ?? 'demanding',
        agentDescription: opts.user.agentDescription ?? 'an AI agent',
        shapeRef: opts.user.shapeRef ?? 'agent-eval:default-shape',
        maxTokens: opts.user.maxTokens ?? 600,
        endingRef: ending.ref,
        endingInstructions: ending.instructions,
        plan: opts.plan,
      }),
    )}`,
    async next({ turn, signal, costLedger }) {
      const setup = simulatedUserSetup(opts.user, opts.persona(turn), opts.plan)
      const messages = driverViewMessages(setup.driverSystemPrompt, turn.context)
      const transport = costLedger
        ? async (req: MultishotTransportRequest) => {
            const result = await costLedger.runPaidCall({
              channel: 'driver',
              phase: 'realism.driver',
              actor: 'simulated-user',
              model: req.model,
              signal: req.signal,
              execute: (callSignal) => opts.user.transport({ ...req, signal: callSignal }),
              receipt: (response: MultishotTransportResponse) => ({
                model: response.model ?? req.model,
                inputTokens: response.usage?.prompt_tokens ?? 0,
                outputTokens: response.usage?.completion_tokens ?? 0,
                ...(response.usage === undefined ? { usageUnknown: true } : {}),
                ...(response.costUsd === undefined ? {} : { actualCostUsd: response.costUsd }),
              }),
            })
            if (!result.succeeded) throw result.error
            return result.value
          }
        : opts.user.transport
      const content = await requestUserReply({
        models,
        messages,
        transport,
        maxTokens: setup.identity.maxTokens,
        signal,
        turn: turn.turn,
      })
      const classified = ending.classify(content)
      return classified.kind === 'continue' ? content : classified.message
    },
  }
}

/** The realism question: which of two messages did the real user write. */
export const SIMULATOR_REALISM_QUESTIONS = {
  real: {
    type: 'choice',
    instructions:
      "The state holds a conversation between a user and an AI agent up to the user's next " +
      'message, and two candidate next messages, a and b. A real user wrote one; a simulator ' +
      'wrote the other. Choose the one the real user wrote. Judge voice, length, specificity, ' +
      "what the user would know, and how a person reacts to the agent's last message. Neither " +
      'position is more likely.',
    criteria: {
      a: 'The real user wrote message a.',
      b: 'The real user wrote message b.',
    },
  },
} as const satisfies DecisionQuestions

export interface SimulatorRealismJudgeOptions {
  id: string
  version: string
  /** Requested judge model. */
  model: string
  ledger: FindingsLedger
  evaluator: SystemOneEvaluatorOptions
  /** Agreement with independent real-or-simulated labels, bound to this exact
   *  question, model and served model through `questionDigest`. Without it
   *  every judgment is recorded as uncalibrated. */
  calibration?: FindingCalibration & {
    servedModel: string
    questionDigest: string
    evidenceRefs: EvidenceRef[]
  }
  /** Default 0.6. */
  minimumProbability?: number
  /** Default 0.2. */
  minimumMargin?: number
}

export interface SimulatorRealismJudge {
  id: string
  definitionDigest: string
  /** The digest a calibration of this judge must carry, for the served model
   *  the calibration names, else the requested model. */
  questionDigest: string
  /** The calibration clears `DECISION_POINT_MIN_KAPPA` and binds this question. */
  calibrated: boolean
  decide: ReturnType<typeof decisionPoint<typeof SIMULATOR_REALISM_QUESTIONS>>['decide']
}

/** The realism judge as a System One decision point at the turn layer. */
export function simulatorRealismJudge(opts: SimulatorRealismJudgeOptions): SimulatorRealismJudge {
  const questionDigest = decisionQuestionDigest({
    id: opts.id,
    version: opts.version,
    model: opts.model,
    servedModel: opts.calibration?.servedModel ?? opts.model,
    name: 'real',
    question: SIMULATOR_REALISM_QUESTIONS.real,
  })
  const point = decisionPoint({
    id: opts.id,
    version: opts.version,
    layers: ['turn'],
    model: opts.model,
    questions: SIMULATOR_REALISM_QUESTIONS,
    policy: {
      real: {
        minimumProbability: opts.minimumProbability ?? 0.6,
        minimumMargin: opts.minimumMargin ?? 0.2,
        options: { a: { action: 'record' }, b: { action: 'record' } },
        ...(opts.calibration ? { calibration: opts.calibration } : {}),
      },
    },
    ledger: opts.ledger,
    evaluator: opts.evaluator,
  })
  return {
    id: point.id,
    definitionDigest: point.definitionDigest,
    questionDigest,
    calibrated:
      opts.calibration !== undefined &&
      opts.calibration.kappa >= DECISION_POINT_MIN_KAPPA &&
      opts.calibration.questionDigest === questionDigest,
    decide: point.decide,
  }
}

export interface MeasureSimulatorRealismOptions {
  turns: readonly RecordedUserTurn[]
  driver: RealismDriver
  judge: SimulatorRealismJudge
  /** Ledger run the judgments are recorded under. Repeating a measurement
   *  under the same run replays its recorded judgments, and a changed input
   *  under it counts as a failed judgment, so use a new run per measurement. */
  runId: string
  /** ISO-8601 time stamped on the judgments. Default: now. */
  at?: string
  /** Judge at most this many turns, drawn with `seed`. Default: all. */
  sample?: number
  confidence?: number
  resamples?: number
  seed?: number
  costLedger?: CostLedgerHandle
  signal?: AbortSignal
}

export interface SimulatorRealismReport {
  driver: string
  judge: {
    id: string
    definitionDigest: string
    /** Calibrated, and every judgment ran on the calibrated model. */
    calibrated: boolean
    /** Judgments by System One reason: threshold, uncertain, uncalibrated, model-mismatch. */
    reasons: Record<string, number>
  }
  conversations: number
  turns: number
  /** Judged presentations; each counted turn is shown in both orders. */
  presentations: number
  failedJudgments: number
  /** Turns dropped because one of their two orders failed to judge: a turn
   *  counts only when it was judged in both positions. */
  unbalancedTurns: number
  /** Share of presentations where the judge picked the real message, each
   *  conversation weighted equally, with a bootstrap interval over conversations. */
  accuracy: { mean: number; low: number; high: number; confidence: number; resamples: number }
  meanProbabilityOnReal: number
  /** The interval contains 0.5: this sample does not show the judge telling
   *  the driver from real users. A small sample satisfies it with a wide
   *  interval, so it is not an admission rule; admit on `accuracy.high`
   *  against a stated bound, as `improveAdversarialUser` does. */
  indistinguishable: boolean
}

/** Measure how often a judge tells the driver's message from the real user's. */
export async function measureSimulatorRealism(
  opts: MeasureSimulatorRealismOptions,
): Promise<SimulatorRealismReport> {
  if (opts.turns.length === 0) throw new RangeError('measureSimulatorRealism: no recorded turns')
  for (const row of opts.turns) assertSharedContext(row)
  const at = opts.at ?? new Date().toISOString()
  const turns = sampleTurns(opts.turns, opts.sample, opts.seed)
  const correctByConversation = new Map<string, number[]>()
  const reasons: Record<string, number> = {}
  const probabilitiesOnReal: number[] = []
  let failedJudgments = 0
  let unbalancedTurns = 0

  for (const row of turns) {
    const simulated = await opts.driver.next({
      turn: row,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.costLedger ? { costLedger: opts.costLedger } : {}),
    })
    const unit = `${row.conversationId}:${row.turn}`
    const answers: Array<{ answer: ReturnType<typeof judgedAnswer>; realOption: 'a' | 'b' }> = []
    for (const order of ['real-first', 'real-second'] as const) {
      const judged = await opts.judge.decide(
        {
          runId: opts.runId,
          invocationId: `${unit}:${order}`,
          layer: 'turn',
          consumer: 'simulator-realism',
          state: {
            context: row.context,
            a: order === 'real-first' ? row.realMessage : simulated,
            b: order === 'real-first' ? simulated : row.realMessage,
          },
          scope: { population: [unit], n: 1, window: { from: at, to: at } },
          at,
          evidenceRefs: row.evidenceRefs?.length
            ? row.evidenceRefs
            : [{ kind: 'event', uri: `user-turn:${unit}` }],
        },
        {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.costLedger ? { costLedger: opts.costLedger } : {}),
          channel: 'judge',
          actor: 'simulator-realism-judge',
          costPhase: 'realism.judge',
        },
      )
      const answer = judgedAnswer(judged)
      if (!answer) failedJudgments += 1
      answers.push({ answer, realOption: order === 'real-first' ? 'a' : 'b' })
    }
    const answered = answers.flatMap(({ answer, realOption }) =>
      answer ? [{ answer, realOption }] : [],
    )
    // A turn judged in one position only would let the judge's position bias
    // count, so it counts only when both orders were judged.
    if (answered.length < answers.length) {
      if (answered.length > 0) unbalancedTurns += 1
      continue
    }
    for (const { answer, realOption } of answered) {
      reasons[answer.reason] = (reasons[answer.reason] ?? 0) + 1
      probabilitiesOnReal.push(answer.probabilities[realOption] ?? 0)
      const list = correctByConversation.get(row.conversationId) ?? []
      list.push(answer.choice === realOption ? 1 : 0)
      correctByConversation.set(row.conversationId, list)
    }
  }

  if (correctByConversation.size === 0) {
    throw new Error('measureSimulatorRealism: no presentation was judged')
  }
  const interval = clusterBootstrapMean(
    [...correctByConversation].map(([conversationId, list]) => ({
      cluster: conversationId,
      value: list.reduce((sum, value) => sum + value, 0) / list.length,
    })),
    {
      ...(opts.confidence === undefined ? {} : { confidence: opts.confidence }),
      ...(opts.resamples === undefined ? {} : { resamples: opts.resamples }),
      ...(opts.seed === undefined ? {} : { seed: opts.seed }),
    },
  )
  const onCalibratedModel = Object.keys(reasons).every(
    (reason) => reason === 'threshold' || reason === 'uncertain',
  )
  return {
    driver: opts.driver.identity,
    judge: {
      id: opts.judge.id,
      definitionDigest: opts.judge.definitionDigest,
      calibrated: opts.judge.calibrated && onCalibratedModel,
      reasons,
    },
    conversations: correctByConversation.size,
    turns: turns.length,
    presentations: probabilitiesOnReal.length,
    failedJudgments,
    unbalancedTurns,
    accuracy: {
      mean: interval.mean,
      low: interval.low,
      high: interval.high,
      confidence: interval.confidence,
      resamples: interval.resamples,
    },
    meanProbabilityOnReal:
      probabilitiesOnReal.reduce((sum, value) => sum + value, 0) / probabilitiesOnReal.length,
    indistinguishable: interval.low <= 0.5 && interval.high >= 0.5,
  }
}

function judgedAnswer(judged: FindingsLedgerOutcome<DecisionPointResult>) {
  if (!judged.succeeded) return undefined
  const record = judged.value.record
  if (!record || record.error) return undefined
  return record.answers.real
}

function sampleTurns(
  turns: readonly RecordedUserTurn[],
  sample: number | undefined,
  seed: number | undefined,
): RecordedUserTurn[] {
  if (sample === undefined || sample >= turns.length) return [...turns]
  if (!Number.isSafeInteger(sample) || sample < 1) {
    throw new RangeError(
      `measureSimulatorRealism: sample must be a positive integer, got ${sample}`,
    )
  }
  const random = makeRng(seed ?? 0)
  const order = turns.map((_, index) => index)
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[order[index], order[swap]] = [order[swap]!, order[index]!]
  }
  return order
    .slice(0, sample)
    .sort((left, right) => left - right)
    .map((index) => turns[index]!)
}
