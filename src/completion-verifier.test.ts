/**
 * The completion verifier is the eval's anti-proxy guarantee: a score only
 * means something if this oracle confirms the task was actually done. These
 * tests pin the regressions that would silently re-inflate scores —
 * structurally-absent deliverables passing, hallucinated artifacts passing,
 * pending work counting as complete.
 */

import type { TCloud } from '@tangle-network/tcloud'
import { describe, expect, it } from 'vitest'

import type { Artifact } from './artifact-validator'
import {
  type CompletionRequirement,
  type CorrectnessChecker,
  completionVerdict,
  createLlmCorrectnessChecker,
  createTokenRecallChecker,
  type ProducedState,
  parseCorrectnessResponse,
  type RequirementCheck,
  type TaskGold,
  verifyCompletion,
} from './completion-verifier'

const LONG = 'x'.repeat(120)

function artifact(path: string, content: string, kind = 'file'): Artifact {
  return { kind, path, content }
}

function emptyState(): ProducedState {
  return { artifacts: [], proposals: [], toolCalls: [] }
}

function gold(requirements: CompletionRequirement[]): TaskGold {
  return { taskId: 'wc-peg-stale', requirements }
}

const DISPUTE_REQ: CompletionRequirement = {
  reqId: 'wc-dispute',
  title: 'Working Capital Adjustment Dispute Notice',
  category: 'deal_diligence',
}

const alwaysCorrect: CorrectnessChecker = async () => ({ correct: true, reason: 'fulfils it' })
const alwaysIncorrect: CorrectnessChecker = async () => ({ correct: false, reason: 'only a plan' })

describe('verifyCompletion — structural + correctness', () => {
  it('fully complete: every requirement has a matching, correct artifact', async () => {
    const v = await verifyCompletion(
      gold([
        DISPUTE_REQ,
        { reqId: 'memo', title: 'Peg Staleness Risk Memo', category: 'deal_diligence' },
      ]),
      {
        ...emptyState(),
        artifacts: [
          artifact('vault/working-capital-dispute-notice.md', LONG),
          artifact('vault/peg-staleness-risk-memo.md', LONG),
        ],
      },
      alwaysCorrect,
    )
    expect(v.completionRate).toBe(1)
    expect(v.fullyComplete).toBe(true)
    expect(v.requirements.every((r) => r.satisfied)).toBe(true)
  })

  it('catches a hallucinated artifact — structurally present but not correct', async () => {
    const v = await verifyCompletion(
      gold([DISPUTE_REQ]),
      { ...emptyState(), artifacts: [artifact('vault/working-capital-dispute-notice.md', LONG)] },
      alwaysIncorrect,
    )
    const r = v.requirements[0]!
    expect(r.structurallyPresent).toBe(true)
    expect(r.correct).toBe(false)
    expect(r.satisfied).toBe(false)
    expect(v.completionRate).toBe(0)
    expect(v.fullyComplete).toBe(false)
  })

  it('catches an absent deliverable — no produced artifact matched', async () => {
    const v = await verifyCompletion(gold([DISPUTE_REQ]), emptyState(), alwaysCorrect)
    const r = v.requirements[0]!
    expect(r.structurallyPresent).toBe(false)
    expect(r.correct).toBeNull()
    expect(r.satisfied).toBe(false)
    expect(r.evidence.join(' ')).toContain('no produced')
  })

  it('reports a fractional completion rate on partial completion', async () => {
    const v = await verifyCompletion(
      gold([
        DISPUTE_REQ,
        { reqId: 'memo', title: 'Peg Staleness Risk Memo' },
        { reqId: 'model', title: 'Adjusted Working Capital Model' },
      ]),
      { ...emptyState(), artifacts: [artifact('vault/working-capital-dispute-notice.md', LONG)] },
      alwaysCorrect,
    )
    expect(v.completionRate).toBeCloseTo(1 / 3, 5)
    expect(v.fullyComplete).toBe(false)
  })

  it('ignores an artifact whose content is below the deliverable threshold', async () => {
    const v = await verifyCompletion(
      gold([DISPUTE_REQ]),
      { ...emptyState(), artifacts: [artifact('vault/working-capital-dispute-notice.md', 'TODO')] },
      alwaysCorrect,
    )
    expect(v.requirements[0]!.structurallyPresent).toBe(false)
  })

  it('does not run the correctness check when nothing matched', async () => {
    let calls = 0
    const counting: CorrectnessChecker = async () => {
      calls++
      return { correct: true, reason: '' }
    }
    await verifyCompletion(gold([DISPUTE_REQ]), emptyState(), counting)
    expect(calls).toBe(0)
  })

  it('throws on a gold spec with no requirements', async () => {
    await expect(verifyCompletion(gold([]), emptyState(), alwaysCorrect)).rejects.toThrow(
      /no requirements/,
    )
  })
})

describe('verifyCompletion — satisfiedBy routing', () => {
  it('an approved proposal satisfies a requirement; a pending one does not', async () => {
    const req: CompletionRequirement = {
      reqId: 'dispute',
      title: 'Working Capital Dispute Notice',
      satisfiedBy: 'proposal',
    }
    const approved = await verifyCompletion(
      gold([req]),
      {
        ...emptyState(),
        proposals: [{ id: 'p1', title: 'Working Capital Dispute Notice', status: 'approved' }],
      },
      alwaysCorrect,
    )
    expect(approved.requirements[0]!.satisfied).toBe(true)

    const pending = await verifyCompletion(
      gold([req]),
      {
        ...emptyState(),
        proposals: [{ id: 'p1', title: 'Working Capital Dispute Notice', status: 'pending' }],
      },
      alwaysCorrect,
    )
    expect(pending.requirements[0]!.structurallyPresent).toBe(false)
  })

  it('a content-less match (tool call) is satisfied structurally, correctness unassessed', async () => {
    const v = await verifyCompletion(
      gold([{ reqId: 'file', title: 'create vault filing', satisfiedBy: 'tool-call' }]),
      { ...emptyState(), toolCalls: ['create_vault_filing'] },
      alwaysIncorrect, // must NOT be consulted — no content to assess
    )
    const r = v.requirements[0]!
    expect(r.structurallyPresent).toBe(true)
    expect(r.correct).toBeNull()
    expect(r.satisfied).toBe(true)
    expect(r.evidence.join(' ')).toContain('not assessed')
  })

  it("satisfiedBy 'artifact' ignores an otherwise-matching proposal", async () => {
    const v = await verifyCompletion(
      gold([
        { reqId: 'dispute', title: 'Working Capital Dispute Notice', satisfiedBy: 'artifact' },
      ]),
      {
        ...emptyState(),
        proposals: [{ id: 'p1', title: 'Working Capital Dispute Notice', status: 'approved' }],
      },
      alwaysCorrect,
    )
    expect(v.requirements[0]!.structurallyPresent).toBe(false)
  })
})

describe('verifyCompletion — content-aware structural matching', () => {
  // Requirements are worded as descriptive sentences; a correct proposal/artifact
  // often carries a short label and a full body. Matching the BODY (not just the
  // title/path) credits the real deliverable, while MATCH_THRESHOLD + the
  // requirement's distinctive tokens keep an off-topic item from matching.
  const REFUSAL_REQ: CompletionRequirement = {
    reqId: 'threshold-statement',
    title: 'Statement of N and a refusal to optimize below threshold, with a data-gathering plan',
    category: 'refusal',
  }

  it('matches a proposal whose label title misses but whose body covers the requirement', async () => {
    const v = await verifyCompletion(
      gold([REFUSAL_REQ]),
      {
        ...emptyState(),
        proposals: [
          {
            id: 'p1',
            title: 'Hold',
            status: 'approved',
            content:
              'Statement of N: only 4 leads completed the sequence. I refuse to optimize the cadence below the data threshold — N=4 is insufficient. Data-gathering plan: collect outcomes until N reaches 30 before proposing any timing changes.',
          },
        ],
      },
      alwaysCorrect,
    )
    expect(v.requirements[0]!.structurallyPresent).toBe(true)
  })

  it('does NOT match an off-topic proposal even with a body (anti-game)', async () => {
    const v = await verifyCompletion(
      gold([REFUSAL_REQ]),
      {
        ...emptyState(),
        proposals: [
          {
            id: 'p1',
            title: 'B2B outreach to Galil Foods',
            status: 'approved',
            content:
              'Draft a free-consultation outreach email to the employer about group insurance options.',
          },
        ],
      },
      alwaysCorrect,
    )
    expect(v.requirements[0]!.structurallyPresent).toBe(false)
  })

  it('matches a generated artifact by its content when the path is generic', async () => {
    const v = await verifyCompletion(
      gold([
        {
          reqId: 'openui-comparison',
          title: 'Generated swap comparison view of current versus proposed premiums',
          category: 'generated_ui',
        },
      ]),
      {
        ...emptyState(),
        artifacts: [
          {
            kind: 'json',
            path: 'ui/view-1.json',
            content:
              '{"type":"table","title":"Swap comparison: current versus proposed premiums","rows":[{"current":6800},{"proposed":5900}]}',
          },
        ],
      },
      alwaysCorrect,
    )
    expect(v.requirements[0]!.structurallyPresent).toBe(true)
  })
})

describe('parseCorrectnessResponse', () => {
  it('parses a bare JSON object', () => {
    expect(parseCorrectnessResponse('{"correct": true, "reason": "ok"}')).toEqual({
      correct: true,
      reason: 'ok',
    })
  })

  it('parses JSON embedded in prose / fences', () => {
    const r = parseCorrectnessResponse(
      'Here is my verdict:\n```json\n{"correct": false, "reason": "stub"}\n```',
    )
    expect(r.correct).toBe(false)
  })

  it('throws when no JSON object is present', () => {
    expect(() => parseCorrectnessResponse('the artifact looks fine')).toThrow(/no JSON object/)
  })

  it("throws when 'correct' is not a boolean", () => {
    expect(() => parseCorrectnessResponse('{"correct": "yes"}')).toThrow(/not a boolean/)
  })
})

describe('createLlmCorrectnessChecker', () => {
  function mockTc(content: string): TCloud {
    return { chat: async () => ({ choices: [{ message: { content } }] }) } as unknown as TCloud
  }

  it('returns the parsed verdict from the model response', async () => {
    const check = createLlmCorrectnessChecker(mockTc('{"correct": true, "reason": "fulfils it"}'))
    const r = await check(DISPUTE_REQ, LONG)
    expect(r).toEqual({ correct: true, reason: 'fulfils it' })
  })

  it('fails loud on an unparseable model response', async () => {
    const check = createLlmCorrectnessChecker(mockTc('I could not decide'))
    await expect(check(DISPUTE_REQ, LONG)).rejects.toThrow(/no JSON object/)
  })
})

describe('createTokenRecallChecker — deterministic content checker', () => {
  const check = createTokenRecallChecker()

  it('rejects content too thin to be the deliverable', async () => {
    const r = await check(DISPUTE_REQ, 'too short')
    expect(r.correct).toBe(false)
    expect(r.reason).toMatch(/too thin/)
  })

  it('passes when content recalls enough requirement tokens', async () => {
    const body = `This working capital adjustment dispute notice contests the peg. ${LONG}`
    const r = await check(DISPUTE_REQ, body)
    expect(r.correct).toBe(true)
    expect(r.reason).toMatch(/recalls \d+\/\d+ requirement tokens/)
  })

  it('fails substantive-but-off-topic content (low recall)', async () => {
    const r = await check(
      DISPUTE_REQ,
      `Completely unrelated prose about something else entirely. ${LONG}`,
    )
    expect(r.correct).toBe(false)
    expect(r.reason).toMatch(/recalls only/)
  })

  it('accepts structurally when the title has no significant tokens', async () => {
    const r = await check({ reqId: 'r', title: 'Review the new update' }, LONG)
    expect(r.correct).toBe(true)
    expect(r.reason).toMatch(/no significant tokens/)
  })

  it('respects a custom minRecall threshold', async () => {
    const strict = createTokenRecallChecker({ minRecall: 1 })
    // recalls 'working' + 'capital' but not 'adjustment'/'dispute'/'notice' → < 1.0
    const r = await strict(DISPUTE_REQ, `working capital only. ${LONG}`)
    expect(r.correct).toBe(false)
  })

  it('plugs into verifyCompletion as the checker', async () => {
    const v = await verifyCompletion(
      gold([DISPUTE_REQ]),
      {
        artifacts: [
          artifact(
            'vault/working-capital-dispute-notice.md',
            `Working Capital Adjustment Dispute Notice — formal objection to the peg. ${LONG}`,
          ),
        ],
        proposals: [],
        toolCalls: [],
      },
      check,
    )
    expect(v.fullyComplete).toBe(true)
  })
})

describe('completionVerdict — spine derivation', () => {
  const check = (reqId: string, satisfied: boolean): RequirementCheck => ({
    reqId,
    title: reqId,
    structurallyPresent: satisfied,
    correct: satisfied ? true : null,
    satisfied,
    evidence: [],
  })

  it('derives completionRate/fullyComplete and the spine fields together', () => {
    const v = completionVerdict({
      taskId: 't1',
      requirements: [check('a', true), check('b', false)],
    })
    expect(v.completionRate).toBeCloseTo(0.5, 5)
    expect(v.fullyComplete).toBe(false)
    expect(v.valid).toBe(false)
    expect(v.score).toBeCloseTo(0.5, 5)
  })

  it('valid mirrors fullyComplete when everything is satisfied', () => {
    const v = completionVerdict({
      taskId: 't1',
      requirements: [check('a', true), check('b', true)],
    })
    expect(v.fullyComplete).toBe(true)
    expect(v.valid).toBe(true)
    expect(v.score).toBe(1)
  })

  it('throws on zero requirement checks', () => {
    expect(() => completionVerdict({ taskId: 't1', requirements: [] })).toThrow(
      /no requirement checks/,
    )
  })

  it('verifyCompletion verdicts carry the spine fields by construction', async () => {
    const v = await verifyCompletion(gold([DISPUTE_REQ]), emptyState(), alwaysCorrect)
    expect(v.valid).toBe(v.fullyComplete)
    expect(v.score).toBe(v.completionRate)
    expect(v.valid).toBe(false)
    expect(v.score).toBe(0)
  })
})
