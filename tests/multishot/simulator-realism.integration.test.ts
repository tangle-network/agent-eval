// Simulator realism through the public entry: recorded real conversations are
// traces, the user turns are read from their trajectories, a driver writes the
// next message from the same recorded context, and a System One decision point
// picks which of the two the real user wrote. 50% means indistinguishable.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  measureSimulatorRealism,
  type RealismDriver,
  SharedContextIdentityError,
  SIMULATOR_REALISM_QUESTIONS,
  simulatedUserDriver,
  userTurnContextDigest,
} from '../../src/multishot/index'
import { decisionQuestionDigest } from '../../src/systemone'
import { InMemoryTraceStore } from '../../src/trace'
import {
  JUDGE_MODEL,
  realismJudge as judge,
  type RefundPersona,
  ROBOT_TELL,
  recordConversations,
  turnsFrom,
  USER_MODEL,
  userTransport,
} from './conversation-world'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'simulator-realism-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('simulator realism against recorded user turns', () => {
  it('reads each real user turn with the context that preceded it and its shared-context identity', async () => {
    const store = new InMemoryTraceStore()
    const runIds = await recordConversations(store, 'refund-desk')
    const turns = await turnsFrom(store, runIds)

    // The opener has no agent message before it; every later user turn is a row.
    expect(turns).toHaveLength(8)
    expect(turns[0]).toMatchObject({
      conversationId: runIds[0],
      taskId: 'refund-desk',
      turn: 1,
      realMessage: 'its C-102',
      context: [
        { role: 'user', content: 'hi i need a refund, order C-102' },
        { role: 'assistant', content: 'I can help with that. Please confirm the order id.' },
      ],
    })
    expect(turns[0]!.contextDigest).toBe(
      userTurnContextDigest({ taskId: 'refund-desk', context: turns[0]!.context }),
    )
  })

  it('is about 50% for a driver that replays the real turn and clearly above for an off-distribution driver', async () => {
    const store = new InMemoryTraceStore()
    const turns = await turnsFrom(store, await recordConversations(store, 'refund-desk'))
    const realByContext = new Map(turns.map((turn) => [turn.contextDigest, turn.realMessage]))

    const replay: RealismDriver = {
      identity: 'replay-the-real-turn',
      next: async ({ turn }) => realByContext.get(turn.contextDigest)!,
    }
    const replayed = await measureSimulatorRealism({
      turns,
      driver: replay,
      judge: judge(join(directory, 'replay.jsonl')),
      runId: 'realism-replay',
      at: '2026-11-21T00:00:00Z',
      resamples: 200,
    })
    expect(replayed).toMatchObject({
      driver: 'replay-the-real-turn',
      conversations: 4,
      turns: 8,
      presentations: 16,
      failedJudgments: 0,
      unbalancedTurns: 0,
      indistinguishable: true,
    })
    expect(replayed.accuracy.mean).toBe(0.5)
    expect(replayed.accuracy.low).toBeLessThanOrEqual(0.5)
    expect(replayed.accuracy.high).toBeGreaterThanOrEqual(0.5)
    expect(replayed.judge.calibrated).toBe(true)

    const robot = simulatedUserDriver<RefundPersona>({
      user: {
        model: USER_MODEL,
        transport: async (req) => {
          const scripted = await userTransport(req)
          return {
            ...scripted,
            message: { content: `${ROBOT_TELL}, ${scripted.message.content}` },
          }
        },
        agentDescription: 'the refund desk',
      },
      persona: (turn) => ({ id: turn.conversationId, name: 'Customer', orderId: 'C-102' }),
    })
    const offDistribution = await measureSimulatorRealism({
      turns,
      driver: robot,
      judge: judge(join(directory, 'robot.jsonl')),
      runId: 'realism-robot',
      at: '2026-11-21T00:00:00Z',
      resamples: 200,
    })
    expect(offDistribution.accuracy.mean).toBe(1)
    expect(offDistribution.accuracy.low).toBeGreaterThan(0.5)
    expect(offDistribution.indistinguishable).toBe(false)
    expect(offDistribution.driver).toBe(robot.identity)
    expect(offDistribution.meanProbabilityOnReal).toBeCloseTo(0.9, 12)
  })

  it('keeps indistinguishable apart from admission on a small, wide sample', async () => {
    const store = new InMemoryTraceStore()
    const runIds = await recordConversations(store, 'refund-desk')
    const turns = await turnsFrom(store, runIds.slice(0, 2))
    const realByContext = new Map(turns.map((turn) => [turn.contextDigest, turn.realMessage]))
    // Off-distribution on one of two conversations, a replay on the other.
    const driver: RealismDriver = {
      identity: 'half-robot',
      next: async ({ turn }) => {
        const real = realByContext.get(turn.contextDigest)!
        return turn.conversationId === runIds[0] ? `${ROBOT_TELL}, ${real}` : real
      },
    }
    const report = await measureSimulatorRealism({
      turns,
      driver,
      judge: judge(join(directory, 'small.jsonl')),
      runId: 'realism-small',
      at: '2026-11-21T00:00:00Z',
      resamples: 200,
    })
    expect(report.conversations).toBe(2)
    expect(report.accuracy.mean).toBe(0.75)
    // Two conversations leave the interval wide enough to contain 0.5...
    expect(report.indistinguishable).toBe(true)
    // ...while its upper end is above the floor an adversarial plan is admitted under.
    expect(report.accuracy.high).toBeGreaterThan(0.65)
  })

  it('drops a turn whose other order failed to judge and reports it as unbalanced', async () => {
    const store = new InMemoryTraceStore()
    const turns = await turnsFrom(store, await recordConversations(store, 'refund-desk'))
    const failing = turns[0]!.realMessage
    const report = await measureSimulatorRealism({
      turns,
      driver: { identity: 'echo', next: async () => 'ok' },
      // Fails only the presentation with the first turn's real message second.
      judge: judge(join(directory, 'unbalanced.jsonl'), true, (state) => state.b === failing),
      runId: 'realism-unbalanced',
      at: '2026-11-21T00:00:00Z',
      resamples: 200,
    })
    expect(report).toMatchObject({
      turns: 8,
      presentations: 14,
      failedJudgments: 1,
      unbalancedTurns: 1,
    })
    // The judge always picks a on a coin: counted only in the first position,
    // the dropped turn would read as a correct call and lift its conversation above 0.5.
    expect(report.accuracy.mean).toBe(0.5)
  })

  it('reports an uncalibrated judge as uncalibrated', async () => {
    const store = new InMemoryTraceStore()
    const turns = await turnsFrom(store, await recordConversations(store, 'refund-desk'))
    const report = await measureSimulatorRealism({
      turns: turns.slice(0, 2),
      driver: { identity: 'echo', next: async () => 'ok' },
      judge: judge(join(directory, 'uncalibrated.jsonl'), false),
      runId: 'realism-uncalibrated',
      at: '2026-11-21T00:00:00Z',
      resamples: 50,
    })
    expect(report.judge.calibrated).toBe(false)
    expect(report.judge.reasons).toEqual({ uncalibrated: 4 })
  })

  it('refuses a row without the identity that proves a shared context', async () => {
    const store = new InMemoryTraceStore()
    // No scenario id: the run carries the emitter's default, which names no task.
    const anonymous = await turnsFrom(store, await recordConversations(store))
    expect(anonymous.every((turn) => turn.contextDigest === undefined)).toBe(true)

    const tasked = await turnsFrom(store, await recordConversations(store, 'refund-desk'))
    const tampered = { ...tasked[0]!, context: [...tasked[0]!.context.slice(1)] }
    const driverCalls: string[] = []
    const driver: RealismDriver = {
      identity: 'counting',
      next: async ({ turn }) => {
        driverCalls.push(turn.conversationId)
        return 'ok'
      },
    }
    for (const rows of [
      [anonymous[0]!, ...tasked],
      [tampered, ...tasked.slice(1)],
    ]) {
      await expect(
        measureSimulatorRealism({
          turns: rows,
          driver,
          judge: judge(join(directory, `refused-${rows.length}.jsonl`)),
          runId: 'realism-refused',
          at: '2026-11-21T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(SharedContextIdentityError)
    }
    expect(driverCalls).toEqual([])
  })

  it('binds the judge calibration to the exact realism question', () => {
    const digest = decisionQuestionDigest({
      id: 'refund-realism',
      version: '1',
      model: JUDGE_MODEL,
      servedModel: JUDGE_MODEL,
      name: 'real',
      question: SIMULATOR_REALISM_QUESTIONS.real,
    })
    expect(judge(join(directory, 'digest.jsonl')).questionDigest).toBe(digest)
  })
})
