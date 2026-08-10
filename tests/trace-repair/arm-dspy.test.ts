/**
 * The DSPy arm, driven by an injected fake engine.
 *
 * The fake stands in for the Python bridge and returns the same
 * `TraceAnalysisEngineResult` shape it produces, so the decode this arm
 * performs — including everything it refuses — is exercised without a
 * subprocess, an interpreter, or a model.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  TraceAnalysisEngine,
  TraceAnalysisEngineRequest,
  TraceAnalysisEngineResult,
} from '../../src/analyst/engine'
import { CostLedger } from '../../src/cost-ledger'
import { askRepairArm, repairArmResponse } from '../../src/trace-repair/analyst-arm'
import { createCompletionRepairArm } from '../../src/trace-repair/arm-completion'
import {
  assertDspyRepairEngine,
  createDspyRepairArm,
  DSPY_REPAIR_SIGNATURE,
  DSPY_REPAIR_TASK_TOKEN,
  dspyRepairInstructions,
} from '../../src/trace-repair/arm-dspy'
import { admitted, step } from './fixtures'

const ROW = admitted({
  steps: [
    step(1, 'ls -la', { returncode: 0, output: 'solve.py' }),
    step(2, 'python solve.py', { returncode: 1, output: 'no such file: /app/answer.txt' }),
  ],
})

interface RepairBlock {
  signature?: unknown
  reported?: unknown
  kept?: number
  dropped?: unknown
  repair?: unknown
  rows?: unknown
  failure?: unknown
}

function fakeEngine(
  repair: RepairBlock | null,
  overrides: Partial<TraceAnalysisEngineResult> = {},
): TraceAnalysisEngine & { requests: TraceAnalysisEngineRequest[] } {
  const requests: TraceAnalysisEngineRequest[] = []
  return {
    id: 'dspy-rlm',
    description: 'fake DSPy RLM',
    version: '1.0.0',
    executionConfig: {},
    requests,
    async analyze(request) {
      requests.push(request)
      return {
        answer: 'step 2 wrote to the wrong path',
        findings: [],
        trajectory: [],
        modelCalls: 3,
        toolCalls: 0,
        runtime: repair === null ? {} : { repair },
        ...overrides,
      }
    },
  }
}

function validBlock(rows: unknown[], extra: RepairBlock = {}): RepairBlock {
  return {
    signature: DSPY_REPAIR_SIGNATURE,
    reported: rows.length,
    kept: rows.length,
    dropped: [],
    repair: null,
    rows,
    failure: null,
    ...extra,
  }
}

const VALID_ROW = {
  k: 2,
  failure_claim: 'solve.py writes nothing to /app/answer.txt',
  intervention: { kind: 'shell', action: 'python solve.py --out /app/answer.txt' },
}

function arm(engine: TraceAnalysisEngine) {
  return createDspyRepairArm({
    engine,
    limits: { maxIterations: 8, maxLlmCalls: 6, maxToolCalls: 0, maxOutputChars: 8_000 },
    costLedger: new CostLedger(),
    costPhase: 'test',
    analystId: 'test-dspy',
  })
}

describe('dspy repair arm', () => {
  it('declares itself uncertified on this task', () => {
    const declaration = arm(fakeEngine(validBlock([VALID_ROW]))).declaration

    expect(declaration.certification.kind).toBe('none')
    if (declaration.certification.kind !== 'none') throw new Error('expected no certification')
    expect(declaration.certification.reason).toContain('CodeTraceBench')
    expect(declaration.repairTurns).toBe(1)
  })

  it('asks the typed repair signature and hands it the trajectory as input', async () => {
    const engine = fakeEngine(validBlock([VALID_ROW]))

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    const request = engine.requests[0]!
    expect(request.instructions).toContain(DSPY_REPAIR_TASK_TOKEN)
    expect(request.tools).toEqual([])
    expect(request.taskInputs).toEqual({
      trajectory: [
        { step_id: 1, action: 'ls -la', observation: expect.stringContaining('returncode') },
        { step_id: 2, action: 'python solve.py', observation: expect.stringContaining('returncode') },
      ],
      taskStatement: 'make the suite pass',
    })
    expect(answer.reply).toMatchObject({
      status: 'finding',
      k: 2,
      intervention: { kind: 'shell', action: 'python solve.py --out /app/answer.txt' },
    })
    expect(answer.budget).toMatchObject({ admissible: true })
    expect(repairArmResponse(answer)).toMatchObject({ kind: 'finding', k: 2 })
  })

  it('states the same execution rules the completion arms are given', () => {
    const instructions = dspyRepairInstructions()

    expect(instructions).toContain('FRESH `/bin/sh`')
    expect(instructions).toContain('4096 bytes')
    expect(instructions).toContain('exactly ONE top-level statement')
  })

  it('records an empty rows array as an honest decline', async () => {
    const answer = await askRepairArm({ arm: arm(fakeEngine(validBlock([]))), row: ROW })

    expect(answer.reply).toMatchObject({ status: 'declined', reportedRows: 0 })
    expect(repairArmResponse(answer)).toEqual({ kind: 'no-decisive-failure' })
  })

  it('reports the one bounded structured re-read the bridge took', async () => {
    const engine = fakeEngine(
      validBlock([VALID_ROW], { repair: 'parsed-repairs-from-string', reported: 1 }),
    )

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    expect(answer.reply).toMatchObject({
      status: 'finding',
      repair: { attempted: true, succeeded: true },
    })
  })

  it('records a re-read that recovered an honest decline as a repair turn that succeeded', async () => {
    // The completion arms record a repair turn that produced a well-formed
    // `findings: []` as succeeded; the same event here is a recovered empty
    // list, and it must land in the same cell.
    const engine = fakeEngine(
      validBlock([], { repair: 'parsed-repairs-from-string', reported: 0 }),
    )

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    expect(answer.reply).toMatchObject({
      status: 'declined',
      repair: { attempted: true, succeeded: true },
    })
    expect(repairArmResponse(answer)).toEqual({ kind: 'no-decisive-failure' })
  })

  it('keeps the answer and the repair-turn record when the re-read failed', async () => {
    const engine = fakeEngine(
      validBlock([], {
        repair: 'unparseable-repairs-string',
        failure: 'typed repairs output is not a JSON array after the bounded structured re-read',
      }),
    )

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    expect(answer.reply.status).toBe('failed')
    if (answer.reply.status !== 'failed') throw new Error('expected a failed reply')
    expect(answer.reply.failure).toContain('not a JSON array')
    expect(answer.reply.answer).toBe('step 2 wrote to the wrong path')
    expect(answer.reply.repair).toEqual({ attempted: true, succeeded: false })
  })

  it('records a k the recording does not hold as a declined reply, never a finding', async () => {
    const engine = fakeEngine(validBlock([{ ...VALID_ROW, k: 99 }]))

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    expect(answer.reply.status).toBe('declined')
    expect(answer.reply).toMatchObject({
      rejectedRows: [{ index: 0, reason: expect.stringContaining('recorded step_id') }],
    })
    expect(repairArmResponse(answer)).toEqual({ kind: 'no-decisive-failure' })
  })

  it('fails loud when the engine answered under a different contract', async () => {
    const answer = await askRepairArm({ arm: arm(fakeEngine(null)), row: ROW })

    expect(answer.reply.status).toBe('failed')
    if (answer.reply.status !== 'failed') throw new Error('expected a failed reply')
    expect(answer.reply.failure).toContain('runtime.repair')
    expect(repairArmResponse(answer)).toBeNull()
  })

  it('fails loud on a row that carries no executable action', async () => {
    const engine = fakeEngine(
      validBlock([{ k: 2, failure_claim: 'wrong path', intervention: { kind: 'shell', action: '' } }]),
    )

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    expect(answer.reply.status).toBe('failed')
    if (answer.reply.status !== 'failed') throw new Error('expected a failed reply')
    expect(answer.reply.failure).toContain('intervention.action must be a non-empty string')
  })

  it('fails loud rather than reading a block written by another signature', async () => {
    const engine = fakeEngine(validBlock([VALID_ROW], { signature: 'codetrace-typed-v1' }))

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    expect(answer.reply.status).toBe('failed')
    if (answer.reply.status !== 'failed') throw new Error('expected a failed reply')
    expect(answer.reply.failure).toContain('expected "tb-repair-typed-v1"')
  })

  it('reports a budget violation on the same measurement the other arms use', async () => {
    const action = 'cd /app\npython solve.py --out answer.txt'
    const engine = fakeEngine(
      validBlock([{ ...VALID_ROW, intervention: { kind: 'shell', action } }]),
    )

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    expect(answer.budget).toMatchObject({
      admissible: false,
      violation: 'multiple-statements',
      measurement: { statements: 2 },
    })
    expect(repairArmResponse(answer)).toMatchObject({ intervention: { action } })
  })

  it('turns an engine that threw into a failure with the reason attached', async () => {
    const engine: TraceAnalysisEngine = {
      id: 'dspy-rlm',
      description: 'fake',
      version: '1.0.0',
      executionConfig: {},
      analyze: vi.fn().mockRejectedValue(new Error('deno interpreter probe failed')),
    }

    const answer = await askRepairArm({ arm: arm(engine), row: ROW })

    expect(answer.reply.status).toBe('failed')
    if (answer.reply.status !== 'failed') throw new Error('expected a failed reply')
    expect(answer.reply.failure).toContain('deno interpreter probe failed')
  })

  it('refuses an engine that does not run the typed repair signature', () => {
    const wrongEngine: TraceAnalysisEngine = {
      id: 'some-other-engine',
      description: 'x',
      version: '1',
      executionConfig: {},
      analyze: async () => {
        throw new Error('unused')
      },
    }

    expect(() => assertDspyRepairEngine(wrongEngine)).toThrow(/needs the dspy-rlm engine/)
    // The factory refuses at build time, before any model call is spent.
    expect(() =>
      createDspyRepairArm({
        engine: wrongEngine,
        limits: { maxIterations: 8, maxLlmCalls: 6, maxToolCalls: 0, maxOutputChars: 8_000 },
        costLedger: new CostLedger(),
        costPhase: 'test',
        analystId: 'test-dspy',
      }),
    ).toThrow(/needs the dspy-rlm engine/)
  })

  it('lands the same out-of-range k in the same funnel cell as the completion arm', async () => {
    const dspyAnswer = await askRepairArm({
      arm: arm(fakeEngine(validBlock([{ ...VALID_ROW, k: 99 }]))),
      row: ROW,
    })

    const completionReply = `\`\`\`json\n${JSON.stringify({
      answer: 'step 99 is the problem',
      findings: [
        {
          k: 99,
          failure_claim: 'claims a step the recording does not hold',
          intervention: { kind: 'shell', action: 'touch /app/answer.txt' },
        },
      ],
    })}\n\`\`\``
    const completionAnswer = await askRepairArm({
      arm: createCompletionRepairArm({
        id: 'bare-framing',
        execution: 'one chat completion, no harness',
        url: 'http://127.0.0.1:4200/v1/chat/completions',
        model: 'test-model',
        transport: async () => ({
          status: 200,
          text: JSON.stringify({
            choices: [{ message: { content: completionReply } }],
            usage: { model_requests: 1, prompt_tokens: 10, completion_tokens: 10 },
          }),
        }),
        timeoutMs: 60_000,
        pricing: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 },
        affordances: ['inline-trajectory'],
        certification: {
          kind: 'none',
          reason: 'authored for the repair contract, certified by nothing',
        },
      }),
      row: ROW,
    })

    // The same model mistake — naming a step the recording does not hold —
    // must land in the same funnel cell for every arm: a declined reply with
    // the rejected row recorded, never a finding the grader refuses later.
    expect(dspyAnswer.reply.status).toBe('declined')
    expect(completionAnswer.reply.status).toBe('declined')
    expect(repairArmResponse(dspyAnswer)).toEqual(repairArmResponse(completionAnswer))
    expect(repairArmResponse(dspyAnswer)).toEqual({ kind: 'no-decisive-failure' })
  })
})
