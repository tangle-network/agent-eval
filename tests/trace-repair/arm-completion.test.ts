/**
 * The chat-completion arms, driven by an injected fake bridge.
 *
 * No test here calls a model. The transport is a function that returns a
 * scripted body, so every branch the campaign can hit — a finding, an honest
 * decline, a malformed reply repaired, a malformed reply that stays malformed,
 * and an action that busts the budget — is exercised at zero cost.
 */

import { describe, expect, it } from 'vitest'
import type {
  PrimeBridgeTransport,
  PrimeBridgeTransportRequest,
} from '../../src/analyst/prime-bridge-transport'
import { SCAFFOLD_INTERVENTION_BUDGET } from '../../src/trace-repair/action-budget'
import { askRepairArm, repairArmResponse } from '../../src/trace-repair/analyst-arm'
import { createCompletionRepairArm } from '../../src/trace-repair/arm-completion'
import { admitted, step } from './fixtures'

const PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }

const ROW = admitted({
  steps: [
    step(1, 'ls -la', { returncode: 0, output: 'solve.py' }),
    step(2, 'python solve.py', { returncode: 1, output: 'no such file: /app/answer.txt' }),
  ],
})

/** A bridge that replies with the scripted contents, in order. */
function scriptedTransport(replies: readonly string[]): PrimeBridgeTransport & {
  requests: PrimeBridgeTransportRequest[]
} {
  const requests: PrimeBridgeTransportRequest[] = []
  const transport = async (request: PrimeBridgeTransportRequest) => {
    requests.push(request)
    const content = replies[requests.length - 1]
    if (content === undefined) {
      throw new Error(`the fake bridge was called ${requests.length} times, scripted for ${replies.length}`)
    }
    return {
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content } }],
        usage: { model_requests: 1, prompt_tokens: 1200, completion_tokens: 300 },
      }),
    }
  }
  return Object.assign(transport, { requests })
}

function arm(transport: PrimeBridgeTransport) {
  return createCompletionRepairArm({
    id: 'bare-framing',
    execution: 'one chat completion, no harness',
    url: 'http://127.0.0.1:4200/v1/chat/completions',
    model: 'test-model',
    transport,
    timeoutMs: 60_000,
    pricing: PRICING,
    affordances: ['inline-trajectory'],
    certification: { kind: 'none', reason: 'authored for the repair contract, certified by nothing' },
  })
}

function reply(action: string, k = 2): string {
  return `Here is my answer.\n\`\`\`json\n${JSON.stringify({
    answer: 'step 2 wrote to the wrong path',
    findings: [
      {
        k,
        failure_claim: 'solve.py writes nothing to /app/answer.txt',
        intervention: { kind: 'shell', action },
      },
    ],
  })}\n\`\`\``
}

describe('completion repair arm', () => {
  it('returns one finding and measures it against the scaffold budget', async () => {
    const transport = scriptedTransport([reply('python solve.py --out /app/answer.txt')])

    const answer = await askRepairArm({ arm: arm(transport), row: ROW })

    expect(transport.requests).toHaveLength(1)
    expect(answer.reply).toMatchObject({
      status: 'finding',
      k: 2,
      intervention: { kind: 'shell', action: 'python solve.py --out /app/answer.txt' },
      repair: { attempted: false, succeeded: null },
    })
    expect(answer.budget).toMatchObject({
      admissible: true,
      measurement: { statements: 1, heredocs: 0, payload: 'shell' },
    })
    expect(repairArmResponse(answer)).toMatchObject({ kind: 'finding', k: 2 })
  })

  it('shows the arm the trajectory and never a grading field', async () => {
    const transport = scriptedTransport([reply('touch /app/answer.txt')])

    await askRepairArm({ arm: arm(transport), row: ROW })

    const prompt = transport.requests[0]!.body.messages[0]!.content
    expect(prompt).toContain('step_id 2')
    expect(prompt).toContain('python solve.py')
    expect(prompt).toContain(String(SCAFFOLD_INTERVENTION_BUDGET.maxBytes))
    for (const leak of [ROW.suiteDigest, ROW.image, ROW.policyDigest]) {
      expect(prompt).not.toContain(leak)
    }
  })

  it('records an empty findings array as an honest decline, not a failure', async () => {
    const transport = scriptedTransport([
      '```json\n{"answer": "no single action repairs this", "findings": []}\n```',
    ])

    const answer = await askRepairArm({ arm: arm(transport), row: ROW })

    expect(answer.reply).toMatchObject({ status: 'declined', reportedRows: 0 })
    expect(answer.budget).toBeNull()
    expect(repairArmResponse(answer)).toEqual({ kind: 'no-decisive-failure' })
  })

  it('gives a structurally malformed reply exactly one repair turn', async () => {
    const transport = scriptedTransport([
      'I think step 2 is wrong but I will not use JSON.',
      reply('touch /app/answer.txt'),
    ])

    const answer = await askRepairArm({ arm: arm(transport), row: ROW })

    expect(transport.requests).toHaveLength(2)
    // The repair turn carries the contract and the previous reply, never the
    // trajectory: a second copy would buy this arm a longer prompt.
    expect(transport.requests[1]!.body.messages[0]!.content).not.toContain('step_id 2')
    expect(answer.reply).toMatchObject({
      status: 'finding',
      repair: { attempted: true, succeeded: true },
    })
  })

  it('fails loud when the reply is still malformed after the repair turn', async () => {
    const transport = scriptedTransport(['still prose', 'still prose again'])

    const answer = await askRepairArm({ arm: arm(transport), row: ROW })

    expect(transport.requests).toHaveLength(2)
    expect(answer.reply.status).toBe('failed')
    expect(answer.reply).toMatchObject({ repair: { attempted: true, succeeded: false } })
    if (answer.reply.status !== 'failed') throw new Error('expected a failed reply')
    expect(answer.reply.failure).toContain('even after the bounded repair turn')
    expect(repairArmResponse(answer)).toBeNull()
  })

  it('reports a budget violation without trimming the action to fit', async () => {
    const action = 'cd /app\npython solve.py --out answer.txt'
    const transport = scriptedTransport([reply(action)])

    const answer = await askRepairArm({ arm: arm(transport), row: ROW })

    expect(answer.reply.status).toBe('finding')
    expect(answer.budget).toMatchObject({
      admissible: false,
      violation: 'multiple-statements',
      measurement: { statements: 2 },
    })
    // The grader is the authority that refuses it, so the action reaches it
    // exactly as the model wrote it.
    expect(repairArmResponse(answer)).toMatchObject({ intervention: { action } })
  })

  it('rejects a k the recording does not hold rather than clamping it', async () => {
    const transport = scriptedTransport([reply('touch /app/answer.txt', 99)])

    const answer = await askRepairArm({ arm: arm(transport), row: ROW })

    expect(answer.reply.status).toBe('declined')
    expect(answer.reply).toMatchObject({
      reportedRows: 1,
      rejectedRows: [{ index: 0, reason: expect.stringContaining('recorded step_id') }],
    })
  })

  it('prices only the tokens the bridge reported', async () => {
    const transport = scriptedTransport([reply('touch /app/answer.txt')])

    const answer = await askRepairArm({ arm: arm(transport), row: ROW })

    expect(answer.reply.usage).toEqual({
      calls: 1,
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: (1200 * 0.6 + 300 * 2.2) / 1_000_000,
    })
  })
})
