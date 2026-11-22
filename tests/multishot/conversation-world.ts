// A closed refund-desk world for the multi-turn optimization tests. Every leg
// is a scripted transport, as in the multishot golden harness: no network, no
// clock in a compared field, and the same request always gets the same reply.
//
// The agent confirms a refund only when its system prompt carries the
// CONFIRM_ORDER_ID directive and the user's latest message names the order.
// The simulated user answers the agent's request for the order id directly,
// unless its prompt carries an adversarial plan:
//   PLAN:INDIRECT  answers without the id, the way a hurried real user does;
//   PLAN:ROBOT     answers in a register no real user writes in.

import type { AgentProfile } from '@tangle-network/agent-interface'
import { openFindingsLedger } from '../../src/analyst/index'
import {
  type ConversationOutcome,
  type ConversationScenario,
  type MultishotPersona,
  type MultishotTransport,
  type MultishotTransportRequest,
  type MultishotTransportResponse,
  type RecordedUserTurn,
  recordedUserTurns,
  simulatorRealismJudge,
} from '../../src/multishot/index'
import { buildTrajectory, type InMemoryTraceStore, TraceEmitter } from '../../src/trace'

export const AGENT_MODEL = 'gpt-4.1-2025-04-14'
export const USER_MODEL = 'gpt-4.1-mini-2025-04-14'
export const OTHER_USER_MODEL = 'gpt-4.1-nano-2025-04-14'
export const DIRECTIVE = 'CONFIRM_ORDER_ID'
export const BASELINE_SURFACE = 'You are the refund desk. Help the customer.'
export const ROBOT_TELL = 'As an AI language model'

export interface RefundPersona extends MultishotPersona {
  id: string
  name: string
  orderId: string
  /** The agent's refund system fails on odd seeds for this customer. */
  flaky?: boolean
}

export type RefundScenario = ConversationScenario<RefundPersona>

export function refundScenario(index: number, prefix = 'p', flaky = false): RefundScenario {
  const id = `${prefix}${index}`
  const orderId = `${String.fromCharCode(65 + (index % 26))}-${100 + index}`
  return {
    id,
    kind: 'refund',
    persona: { id, name: `Customer ${index}`, orderId, ...(flaky ? { flaky: true } : {}) },
  }
}

const USAGE = { prompt_tokens: 120, completion_tokens: 30 }
const ORDER_ID = /\b([A-Z]-\d{3})\b/

function reply(req: MultishotTransportRequest, content: string): MultishotTransportResponse {
  return { message: { content }, usage: USAGE, costUsd: 0.0002, model: req.model }
}

function text(message: Record<string, unknown> | undefined): string {
  return typeof message?.content === 'string' ? message.content : ''
}

/** The agent under test. Its system prompt is the candidate surface. */
export const agentTransport: MultishotTransport = async (req) => {
  const system = text(req.messages[0])
  const userTurns = req.messages.filter((message) => message.role === 'user')
  const latest = text(userTurns.at(-1))
  if (!system.includes(DIRECTIVE)) {
    return reply(req, 'Thanks for reaching out. Could you describe the issue in more detail?')
  }
  const named = userTurns.length > 1 ? ORDER_ID.exec(latest)?.[1] : undefined
  if (!named) return reply(req, 'I can help with that. Please confirm the order id.')
  // The opener carries the persona facts, so a flaky account shows there.
  if (/flaky: true/.test(text(req.messages[1])) && (req.seed ?? 0) % 2 === 1) {
    return reply(req, 'Our refund system is unavailable right now. Please try again later.')
  }
  return reply(req, `Refund issued for ${named}. Confirmation REFUND-${named}.`)
}

/** The simulated user. Its system prompt carries the persona facts and any plan. */
export const userTransport: MultishotTransport = async (req) => reply(req, userReply(req))

export function userReply(req: Pick<MultishotTransportRequest, 'messages'>): string {
  const system = text(req.messages[0])
  const orderId = /orderId: (\S+)/.exec(system)?.[1] ?? 'unknown'
  const agentSaid = req.messages.filter((message) => message.role === 'user')
  const lastAgent = text(agentSaid.at(-1))
  const priorUserReplies = req.messages.filter((message) => message.role === 'assistant').length
  if (lastAgent.includes('REFUND-')) return 'great, thanks. [[signed-off]]'
  if (lastAgent.includes('confirm the order id')) {
    if (system.includes('PLAN:ROBOT')) {
      return `${ROBOT_TELL}, I would prefer not to restate the identifier of my order.`
    }
    if (system.includes('PLAN:INDIRECT')) return 'the one from last tuesday, you should have it'
    return `its ${orderId}`
  }
  if (priorUserReplies >= 3) return 'forget it. [[gave-up]]'
  return 'That does not answer me. i just need my refund'
}

/** A second simulated user that writes like a form letter. */
export const formalUserTransport: MultishotTransport = async (req) =>
  reply(req, `${ROBOT_TELL}, ${userReply(req)}`)

export const refundOutcome = (
  conversation: { transcript: Array<{ role: string; content: string }> },
  scenario: RefundScenario,
): ConversationOutcome => {
  const confirmed = conversation.transcript.some(
    (message) =>
      message.role === 'assistant' &&
      message.content.includes(`REFUND-${scenario.persona.orderId}`),
  )
  return confirmed
    ? { passed: true, detail: 'the refund confirmation names the order' }
    : { passed: false, detail: 'no refund confirmation names the order' }
}

export const isPushback = (message: string) => message.startsWith('That does not answer me')

export const appendDirective = (surface: unknown) => `${String(surface)} ${DIRECTIVE}`

export function refundAgentProfile(surface: string): AgentProfile {
  return { name: 'refund-desk', prompt: { systemPrompt: surface } }
}

// ── Recorded real conversations and the realism judge ─────────────────────

export const JUDGE_MODEL = 'realism-judge-2026-10-01'

/** Recorded product conversations: each agent call is an llm span whose input
 *  is the conversation so far, exactly as an OpenTelemetry intake records it.
 *  Without a scenario id the run carries the emitter's default, which names no task. */
export async function recordConversations(store: InMemoryTraceStore, scenarioId?: string) {
  const conversations = [
    ['hi i need a refund, order C-102', 'its C-102', 'ok thanks'],
    ['refund please. it arrived broken', 'the one from last tuesday', 'fine, whatever works'],
    ['my order never showed up', 'D-103 i think', 'cool thx'],
    ['i was charged twice', 'its E-104', 'thanks that worked'],
  ]
  const runIds: string[] = []
  for (const [index, userTurns] of conversations.entries()) {
    const emitter = new TraceEmitter(store)
    await emitter.startRun({
      ...(scenarioId === undefined ? {} : { scenarioId }),
      layer: 'app-runtime',
    })
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: 'You are the refund desk.' },
    ]
    for (const [turn, userMessage] of userTurns.entries()) {
      messages.push({ role: 'user', content: userMessage })
      const reply =
        turn === 0
          ? 'I can help with that. Please confirm the order id.'
          : `Refund issued. Confirmation REFUND-${index}.`
      const span = await emitter.llm({
        name: 'agent',
        model: 'agent-2026-01-01',
        messages: [...messages],
      })
      await span.end({ output: reply })
      messages.push({ role: 'assistant', content: reply })
    }
    await emitter.endRun({ pass: true })
    runIds.push(emitter.runId)
  }
  return runIds
}

export async function turnsFrom(store: InMemoryTraceStore, runIds: string[]) {
  const turns: RecordedUserTurn[] = []
  for (const runId of runIds) {
    const run = await store.getRun(runId)
    turns.push(...recordedUserTurns(await buildTrajectory(store, runId), run!))
  }
  return turns
}

/** The scripted realism judge: a real user never writes in the robot's
 *  register. Two equal messages are a coin it always calls for A. */
export function realismJudge(path: string, calibrated = true) {
  return simulatorRealismJudge({
    id: 'refund-realism',
    version: '1',
    model: JUDGE_MODEL,
    ledger: openFindingsLedger({ path }),
    evaluator: {
      evaluate: async (request) => {
        const state = request.state as { a: string; b: string }
        const aRobot = state.a.includes(ROBOT_TELL)
        const bRobot = state.b.includes(ROBOT_TELL)
        const pA = aRobot === bRobot ? 0.5 : aRobot ? 0.1 : 0.9
        return {
          model: JUDGE_MODEL,
          answers: {
            real: {
              type: 'choice',
              choice: pA >= 0.5 ? 'a' : 'b',
              confidence: Math.max(pA, 1 - pA),
              probabilities: { a: pA, b: 1 - pA },
            },
          },
          usage: { input_tokens: 40, output_tokens: 1 },
        }
      },
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    },
    ...(calibrated
      ? {
          calibration: {
            servedModel: JUDGE_MODEL,
            gold_n: 40,
            agreement: 0.95,
            kappa: 0.9,
            evidenceRefs: [
              { kind: 'artifact' as const, uri: 'artifact://independent-realism-labels' },
            ],
          },
        }
      : {}),
  })
}
