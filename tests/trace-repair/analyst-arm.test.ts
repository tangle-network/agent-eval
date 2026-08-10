/**
 * What the arm contract refuses, and what it records.
 *
 * The rules under test are the ones that decide whether a between-arm number
 * means anything: one budget, one repair turn, one certification state, and
 * every remaining difference written down where a reader will see it.
 */

import { describe, expect, it } from 'vitest'
import { SCAFFOLD_INTERVENTION_BUDGET } from '../../src/trace-repair/action-budget'
import {
  askRepairArm,
  type RepairArm,
  type RepairArmAffordance,
  type RepairArmCertification,
  type RepairArmReply,
  repairArmAsymmetries,
} from '../../src/trace-repair/analyst-arm'
import { repairPromptSha256 } from '../../src/trace-repair/repair-prompt'
import { admitted, step } from './fixtures'

const ROW = admitted({
  steps: [step(1, 'ls -la', { returncode: 0, output: 'solve.py' })],
})

const FINDING: RepairArmReply = {
  status: 'finding',
  k: 1,
  failureClaim: 'the run never wrote the answer',
  intervention: { kind: 'shell', action: 'touch /app/answer.txt' },
  answer: 'nothing was written',
  reportedRows: 1,
  rejectedRows: [],
  repair: { attempted: false, succeeded: null },
  usage: { calls: 1, inputTokens: 10, outputTokens: 5, costUsd: null },
}

const UNCERTIFIED: RepairArmCertification = {
  kind: 'none',
  reason: 'authored for the repair contract, certified by nothing',
}

function stubArm(
  id: string,
  overrides: {
    reply?: RepairArmReply
    repairTurns?: number
    affordances?: readonly RepairArmAffordance[]
    certification?: RepairArmCertification
    budget?: typeof SCAFFOLD_INTERVENTION_BUDGET
  } = {},
): RepairArm {
  return {
    declaration: {
      id,
      execution: `stub for ${id}`,
      certification: overrides.certification ?? UNCERTIFIED,
      budget: overrides.budget ?? SCAFFOLD_INTERVENTION_BUDGET,
      repairTurns: overrides.repairTurns ?? 1,
      affordances: overrides.affordances ?? ['inline-trajectory'],
    },
    async ask() {
      return overrides.reply ?? FINDING
    },
  }
}

describe('repair arm contract', () => {
  it('measures every finding against the declared budget and stamps the prompt digest', async () => {
    const answer = await askRepairArm({ arm: stubArm('a'), row: ROW, now: counter() })

    expect(answer.promptSha256).toBe(repairPromptSha256())
    expect(answer.budget).toMatchObject({ admissible: true, measurement: { statements: 1 } })
    expect(answer.wallMs).toBe(1)
  })

  it('shows an arm a blinded prefix and never the admitted row it came from', async () => {
    let seen: unknown
    const arm: RepairArm = {
      declaration: stubArm('a').declaration,
      async ask(request) {
        seen = request.prefix
        return FINDING
      },
    }

    await askRepairArm({ arm, row: ROW })

    expect(seen).toEqual({
      rowId: ROW.rowId,
      taskStatement: 'make the suite pass',
      steps: [{ step_id: 1, action: 'ls -la', observation: expect.any(String) }],
      recordedSteps: 1,
      maxK: 1,
    })
  })

  it('refuses an arm that took a repair turn it never declared', async () => {
    const arm = stubArm('a', {
      repairTurns: 0,
      reply: { ...FINDING, repair: { attempted: true, succeeded: true } },
    })

    await expect(askRepairArm({ arm, row: ROW })).rejects.toThrow(
      /declares no bounded repair turn but took one/,
    )
  })

  it('refuses an arm that failed without stating why', async () => {
    const arm = stubArm('a', {
      reply: {
        status: 'failed',
        failure: '   ',
        answer: null,
        rejectedRows: [],
        repair: { attempted: false, succeeded: null },
        usage: { calls: null, inputTokens: null, outputTokens: null, costUsd: null },
      },
    })

    await expect(askRepairArm({ arm, row: ROW })).rejects.toThrow(/failed without stating why/)
  })

  it('refuses a comparison whose arms buy different action budgets', () => {
    const generous = { maxBytes: 65_536, maxStatements: 4, maxHeredocs: 4 }

    expect(() => repairArmAsymmetries([stubArm('a'), stubArm('b', { budget: generous })])).toThrow(
      /a difference in what was asked, not in what answered/,
    )
  })

  it('refuses a comparison whose arms get different repair turns', () => {
    expect(() => repairArmAsymmetries([stubArm('a'), stubArm('b', { repairTurns: 2 })])).toThrow(
      /a second sample the other arms never got/,
    )
  })

  it('refuses a comparison where an optimisation reached only some arms', () => {
    const certified = stubArm('b', {
      certification: {
        kind: 'certified',
        artifact: 'oht2-coverage-instructions.txt',
        benchmark: 'CodeTraceBench',
        contract: 'incorrect-step blocks',
      },
    })

    expect(() => repairArmAsymmetries([stubArm('a'), certified])).toThrow(
      /an optimisation applies to every arm or to none/,
    )
  })

  it('refuses two arms that answer under the same id', () => {
    expect(() => repairArmAsymmetries([stubArm('a'), stubArm('a')])).toThrow(/declared twice/)
  })

  it('records what each arm can do that the others cannot', () => {
    const report = repairArmAsymmetries([
      stubArm('bare-framing', { affordances: ['inline-trajectory'] }),
      stubArm('prime', { affordances: ['inline-trajectory', 'agent-loop'] }),
      stubArm('dspy-rlm', {
        affordances: ['inline-trajectory', 'code-interpreter', 'agent-loop'],
      }),
    ])

    expect(report.noArmCertified).toBe(true)
    expect(report.repairTurns).toBe(1)
    expect(report.budget).toEqual(SCAFFOLD_INTERVENTION_BUDGET)
    expect(report.sharedAffordances).toEqual(['inline-trajectory'])
    expect(report.asymmetries).toEqual([
      {
        armId: 'bare-framing',
        extraAffordances: [],
        missingAffordances: ['code-interpreter', 'agent-loop'],
        certification: UNCERTIFIED,
      },
      {
        armId: 'prime',
        extraAffordances: ['agent-loop'],
        missingAffordances: ['code-interpreter'],
        certification: UNCERTIFIED,
      },
      {
        armId: 'dspy-rlm',
        extraAffordances: ['code-interpreter', 'agent-loop'],
        missingAffordances: [],
        certification: UNCERTIFIED,
      },
    ])
  })

  it('refuses an arm that carries no certification and does not say why', () => {
    const silent = stubArm('a', { certification: { kind: 'none', reason: '  ' } })

    expect(() => repairArmAsymmetries([silent])).toThrow(/must say why in one sentence/)
  })
})

/** A clock that advances one millisecond per read. */
function counter(): () => number {
  let value = 0
  return () => {
    value += 1
    return value
  }
}
