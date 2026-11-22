// The simulated user as a second optimizable role. Its objective is the agent's
// failure rate, it is admitted only above a realism floor measured against
// recorded real users, and what it finds becomes train scenarios for the agent
// side that never enter the held-out split. Optimizing it on the agent's own
// success score cannot be configured.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SurfaceProposer } from '../../src/campaign'
import { selfImprove } from '../../src/contract'
import {
  AdversarialScenarioInHeldOutError,
  AdversarialSplitError,
  type AdversarialUserOptions,
  type ConversationArtifact,
  conversationGate,
  conversationJudge,
  improveAdversarialUser,
  type MultishotTransport,
  multishotRollout,
  UserSideObjectiveError,
} from '../../src/multishot/index'
import { InMemoryTraceStore } from '../../src/trace'
import {
  AGENT_MODEL,
  agentTransport,
  appendDirective,
  BASELINE_SURFACE,
  isPushback,
  type RefundScenario,
  realismJudge,
  recordConversations,
  refundAgentProfile,
  refundOutcome,
  refundScenario,
  turnsFrom,
  USER_MODEL,
  userTransport,
} from './conversation-world'

let runDir: string
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'adversarial-user-'))
})
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

const USER_TRAIN = Array.from({ length: 6 }, (_, i) => refundScenario(i, 'user-train-'))
const USER_HELD_OUT = Array.from({ length: 6 }, (_, i) => refundScenario(i + 20, 'user-held-'))
const AGENT_HELD_OUT = Array.from({ length: 6 }, (_, i) => refundScenario(i + 40, 'held-'))
const GOOD_AGENT = appendDirective(BASELINE_SURFACE)

function planProposer(plan: string): SurfaceProposer {
  return {
    kind: `test:plan-${plan}`,
    async propose({ currentSurface, populationSize }) {
      return Array.from({ length: populationSize }, () => ({
        surface: `${String(currentSurface)} ${plan}`,
        label: plan,
        rationale: 'Answer the way a hurried customer answers.',
      }))
    },
  }
}

async function options(
  plan: string,
  transports: { agent?: MultishotTransport; user?: MultishotTransport } = {},
): Promise<AdversarialUserOptions<RefundScenario>> {
  const store = new InMemoryTraceStore()
  const turns = await turnsFrom(store, await recordConversations(store, 'refund-desk'))
  return {
    rollout: {
      agent: { model: AGENT_MODEL, transport: transports.agent ?? agentTransport },
      user: {
        model: USER_MODEL,
        transport: transports.user ?? userTransport,
        rigor: 'demanding',
        agentDescription: 'the refund desk',
        pushback: isPushback,
      },
      maxTurns: 4,
      outcome: refundOutcome,
    },
    agentProfile: refundAgentProfile(GOOD_AGENT),
    baselinePlan: 'Stay on task.',
    scenarios: [...USER_TRAIN, ...USER_HELD_OUT],
    agentHeldOut: AGENT_HELD_OUT,
    proposer: planProposer(plan),
    budget: { generations: 1, populationSize: 1, holdoutScenarios: USER_HELD_OUT },
    runDir,
    realism: {
      turns,
      judge: realismJudge(join(runDir, `realism-${plan}.jsonl`)),
      runId: `adversarial-realism-${plan}`,
      at: '2026-11-21T00:00:00Z',
      persona: (turn) => ({ id: turn.conversationId, name: 'Customer', orderId: 'C-102' }),
      maxJudgeAccuracy: 0.65,
      resamples: 200,
    },
  }
}

describe('an adversarial user as its own optimizable surface', () => {
  it('raises the agent failure rate, passes the realism floor, and emits train-only scenarios', async () => {
    const result = await improveAdversarialUser(await options('PLAN:INDIRECT'))

    expect(result.improvement.gateDecision).toBe('ship')
    expect(result.plan).toContain('PLAN:INDIRECT')
    // The user side's score is the agent's failure rate.
    expect(result.improvement.baseline?.compositeMean).toBe(0)
    expect(result.improvement.winner.compositeMean).toBe(1)
    expect(result.realism?.accuracy.mean).toBe(0.5)
    expect(result.realism?.judge.calibrated).toBe(true)
    expect(result.admitted).toBe(true)

    const emitted = result.trainScenarios
    expect(emitted.map((scenario) => scenario.origin?.sourceScenarioId).sort()).toEqual(
      USER_HELD_OUT.map((scenario) => scenario.id).sort(),
    )
    for (const scenario of emitted) {
      expect(scenario.userPlan).toBe(result.plan)
      expect(scenario.origin?.kind).toBe('adversarial-user')
      expect(AGENT_HELD_OUT.some((heldOut) => heldOut.id === scenario.id)).toBe(false)
    }

    // On the agent side, an emitted scenario trains: the planned user meets the agent.
    const agentSide = multishotRollout<RefundScenario>({
      agent: { model: AGENT_MODEL, transport: agentTransport },
      user: {
        model: USER_MODEL,
        transport: userTransport,
        rigor: 'demanding',
        agentDescription: 'the refund desk',
      },
      maxTurns: 4,
      outcome: refundOutcome,
    })
    expect(agentSide.simulatedUser(emitted[0]!).digest).not.toBe(
      agentSide.simulatedUser({ ...emitted[0]!, userPlan: undefined }).digest,
    )

    // ...and never enters the held-out split.
    const error = await selfImprove<RefundScenario, ConversationArtifact>({
      agent: agentSide.agent,
      dispatchRef: agentSide.dispatchRef,
      scenarios: [...USER_TRAIN, ...emitted],
      judge: conversationJudge(),
      gate: conversationGate(),
      baselineSurface: BASELINE_SURFACE,
      proposer: planProposer('CONFIRM_ORDER_ID'),
      budget: { generations: 1, populationSize: 1, holdoutScenarios: emitted },
      runDir: join(runDir, 'agent-side'),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(chain(error).some((cause) => cause instanceof AdversarialScenarioInHeldOutError)).toBe(
      true,
    )
  })

  it('does not admit an adversarial user below the realism floor', async () => {
    const result = await improveAdversarialUser(await options('PLAN:ROBOT'))

    expect(result.improvement.gateDecision).toBe('ship')
    expect(result.realism?.accuracy.mean).toBe(0.75)
    expect(result.admitted).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/realism/)
    expect(result.trainScenarios).toEqual([])
  })

  it('cannot be configured to optimize the user side on the agent success score', async () => {
    let calls = 0
    const counted: MultishotTransport = async (req) => {
      calls += 1
      return userTransport(req)
    }
    const configured = {
      ...(await options('PLAN:INDIRECT', { agent: counted, user: counted })),
      judge: conversationJudge(),
    }
    await expect(improveAdversarialUser(configured as never)).rejects.toBeInstanceOf(
      UserSideObjectiveError,
    )
    expect(calls).toBe(0)

    // The agent-success judge refuses a conversation in which the user side was optimized.
    const result = await improveAdversarialUser(await options('PLAN:INDIRECT'))
    const cell = result.improvement.raw.winnerOnHoldout.cells[0]!
    expect(cell.artifact.optimizedRole).toBe('user')
    const scenario = USER_HELD_OUT.find((candidate) => candidate.id === cell.scenarioId)!
    expect(() =>
      conversationJudge<RefundScenario>().score({
        artifact: cell.artifact,
        scenario,
        signal: new AbortController().signal,
      }),
    ).toThrow(UserSideObjectiveError)
  })

  it('refuses a user-side search that reaches the agent held-out personas', async () => {
    const base = await options('PLAN:INDIRECT')
    await expect(
      improveAdversarialUser({ ...base, scenarios: [...base.scenarios, AGENT_HELD_OUT[0]!] }),
    ).rejects.toBeInstanceOf(AdversarialSplitError)
    const samePersona = { ...USER_TRAIN[0]!, id: 'renamed', persona: AGENT_HELD_OUT[1]!.persona }
    await expect(
      improveAdversarialUser({ ...base, scenarios: [...base.scenarios, samePersona] }),
    ).rejects.toBeInstanceOf(AdversarialSplitError)
  })
})

function chain(error: unknown): unknown[] {
  const causes: unknown[] = []
  let current: unknown = error
  while (current !== undefined && current !== null && causes.length < 10) {
    causes.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return causes
}
