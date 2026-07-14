/**
 * The simulated user is the eval's difficulty knob. These tests pin the
 * adversarial contract of the driver system prompt so a future edit cannot
 * quietly soften it back into a passive script-reader — a regression that
 * would inflate every downstream agent score with no real improvement.
 */

import type { TCloud } from '@tangle-network/tcloud'
import { describe, expect, it } from 'vitest'
import { CostLedger } from './cost-ledger'
import {
  buildDriverSystemPrompt,
  buildWorkerDriverSystemPrompt,
  decideNextUserTurn,
} from './driver'
import type { DriverState, PersonaConfig } from './types'

const STATE: DriverState = {
  tasks: 2,
  events: 5,
  proposals: { pending: 1, approved: 3, rejected: 0 },
  vaultFiles: ['brief.md', 'analysis.md'],
  codeBlocks: 0,
  generations: 1,
}

function persona(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    id: 'p1',
    role: 'M&A partner',
    goal: 'get a defensible working-capital dispute notice',
    completionCriteria: [
      { name: 'dispute-notice-drafted', check: (s) => s.vaultFiles.includes('dispute.md') },
    ],
    maxTurns: 8,
    ...overrides,
  }
}

describe('buildDriverSystemPrompt — adversarial contract', () => {
  it('frames the simulated user as a skeptic who assumes the work is inadequate', () => {
    const p = buildDriverSystemPrompt(persona(), STATE)
    expect(p).toContain('M&A partner')
    expect(p).toContain('stake your professional reputation')
    expect(p).toMatch(/Assume it is not/i)
  })

  it('instructs the driver to refuse vague answers and force specifics', () => {
    const p = buildDriverSystemPrompt(persona(), STATE)
    expect(p).toMatch(/do NOT move on/i)
    expect(p).toContain('"It depends" is not an answer')
    expect(p).toMatch(/challenge it/i)
  })

  it('makes sign-off strict — nominal completion is explicitly insufficient', () => {
    const p = buildDriverSystemPrompt(persona(), STATE)
    expect(p).toContain('Nominal task completion is NOT sign-off')
    expect(p).toMatch(/never sign off on weak work/i)
    // the DONE sentinel the run loop keys on must still be specified
    expect(p).toContain('"DONE"')
  })

  it('does NOT contain the old passive-simulator language', () => {
    const p = buildDriverSystemPrompt(persona(), STATE)
    expect(p).not.toMatch(/push for the next deliverable/i)
    expect(p).not.toMatch(/if completion is 100%/i)
  })
})

describe('buildDriverSystemPrompt — rigor scaling', () => {
  it('defaults to the demanding stance when rigor is unset', () => {
    const p = buildDriverSystemPrompt(persona(), STATE)
    expect(p).toMatch(/experienced professional with no time to waste/i)
  })

  it('cooperative rigor produces a forgiving stance', () => {
    const p = buildDriverSystemPrompt(persona({ rigor: 'cooperative' }), STATE)
    expect(p).toMatch(/pragmatic early adopter/i)
    expect(p).not.toMatch(/interrogate every claim/i)
  })

  it('relentless rigor produces a litigation-grade stance', () => {
    const p = buildDriverSystemPrompt(persona({ rigor: 'relentless' }), STATE)
    expect(p).toMatch(/interrogate every claim/i)
    expect(p).toMatch(/weakest point/i)
    expect(p).toMatch(/litigate/i)
  })

  it('the three rigor levels are genuinely distinct prompts', () => {
    const c = buildDriverSystemPrompt(persona({ rigor: 'cooperative' }), STATE)
    const d = buildDriverSystemPrompt(persona({ rigor: 'demanding' }), STATE)
    const r = buildDriverSystemPrompt(persona({ rigor: 'relentless' }), STATE)
    expect(new Set([c, d, r]).size).toBe(3)
  })
})

describe('buildDriverSystemPrompt — pressure points', () => {
  it('embeds pressure points but instructs the driver NOT to reveal them', () => {
    const p = buildDriverSystemPrompt(
      persona({
        pressurePoints: [
          'deferred-revenue removed from the working-capital schedule',
          'AR inflated by a billing-cadence switch',
        ],
      }),
      STATE,
    )
    expect(p).toContain('deferred-revenue removed from the working-capital schedule')
    expect(p).toContain('AR inflated by a billing-cadence switch')
    expect(p).toMatch(/Do NOT hand these to the agent/i)
    expect(p).toMatch(/surfaces them itself/i)
  })

  it('omits the pressure-point block entirely when none are given', () => {
    const p = buildDriverSystemPrompt(persona(), STATE)
    expect(p).not.toMatch(/MUST get the agent to address/i)
  })
})

describe('buildDriverSystemPrompt — curveballs', () => {
  it('embeds curveballs as new developments, not quizzes', () => {
    const p = buildDriverSystemPrompt(
      persona({ curveballs: ['seller threatens to walk if the dispute notice is filed'] }),
      STATE,
    )
    expect(p).toContain('seller threatens to walk if the dispute notice is filed')
    expect(p).toMatch(/never as a quiz/i)
  })

  it('omits the curveball block when none are given', () => {
    const p = buildDriverSystemPrompt(persona(), STATE)
    expect(p).not.toMatch(/coasting on easy answers/i)
  })
})

describe('buildDriverSystemPrompt — context embedding', () => {
  it('weaves in declared expertise', () => {
    const p = buildDriverSystemPrompt(
      persona({ expertise: 'a 15-year M&A partner who knows GAAP working-capital mechanics cold' }),
      STATE,
    )
    expect(p).toContain('15-year M&A partner who knows GAAP working-capital mechanics cold')
  })

  it('reflects nominal completion state and product context', () => {
    const p = buildDriverSystemPrompt(persona(), STATE, 'Tangle legal workspace product')
    expect(p).toContain('Tangle legal workspace product')
    expect(p).toContain('0/1')
    expect(p).toContain('dispute-notice-drafted: NOT MET')
  })
})

describe('decideNextUserTurn', () => {
  interface CapturedRequest {
    model: string
    system: string
    user: string
  }

  function mockTc(reply: string): { tc: TCloud; captured: CapturedRequest[] } {
    const captured: CapturedRequest[] = []
    const tc = {
      chat: async (req: { model: string; messages: { role: string; content: string }[] }) => {
        captured.push({
          model: req.model,
          system: req.messages.find((m) => m.role === 'system')?.content ?? '',
          user: req.messages.find((m) => m.role === 'user')?.content ?? '',
        })
        return { choices: [{ message: { content: reply } }] }
      },
    } as unknown as TCloud
    return { tc, captured }
  }

  it('drives the adversarial system prompt and returns the next turn', async () => {
    const { tc, captured } = mockTc('  What is your authority for that?  ')
    const turn = await decideNextUserTurn(tc, {
      persona: persona({ rigor: 'relentless' }),
      state: STATE,
      history: [
        { role: 'user', content: 'draft the dispute notice' },
        { role: 'assistant', content: 'It depends on several factors.' },
      ],
    })
    expect(turn).toBe('What is your authority for that?')
    expect(captured[0]!.system).toMatch(/interrogate every claim/i)
    expect(captured[0]!.user).toContain('It depends on several factors.')
  })

  it('opens with a first-message prompt when there is no history', async () => {
    const { tc, captured } = mockTc('We are buying Acme for $120M.')
    await decideNextUserTurn(tc, { persona: persona(), state: STATE, history: [] })
    expect(captured[0]!.user).toMatch(/no conversation yet/i)
  })

  it('passes the DONE sign-off sentinel through verbatim', async () => {
    const { tc } = mockTc('DONE')
    const turn = await decideNextUserTurn(tc, {
      persona: persona(),
      state: STATE,
      history: [{ role: 'assistant', content: 'Here is the finished, defensible notice.' }],
    })
    expect(turn).toBe('DONE')
  })

  it('honors the configured driver model', async () => {
    const { tc, captured } = mockTc('next')
    await decideNextUserTurn(tc, {
      persona: persona(),
      state: STATE,
      history: [],
      model: 'gpt-5.4',
    })
    expect(captured[0]!.model).toBe('gpt-5.4')
  })

  it('attributes driver-model usage and rejects unbounded capped calls before dispatch', async () => {
    let calls = 0
    const tc = {
      chat: async () => {
        calls++
        return {
          model: 'gpt-4o',
          choices: [{ message: { content: 'next' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }
      },
    } as unknown as TCloud
    const ledger = new CostLedger()

    await decideNextUserTurn(tc, {
      persona: persona(),
      state: STATE,
      history: [],
      model: 'gpt-4o',
      costLedger: ledger,
      costTags: { driverRunId: 'driver-a' },
    })

    expect(ledger.summary()).toMatchObject({
      totalCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      accountingComplete: true,
      byChannel: [{ channel: 'driver', calls: 1 }],
    })
    expect(ledger.summary({ tags: { driverRunId: 'driver-a' } }).totalCalls).toBe(1)
    expect(ledger.summary({ tags: { driverRunId: 'driver-b' } }).totalCalls).toBe(0)

    await expect(
      decideNextUserTurn(tc, {
        persona: persona(),
        state: STATE,
        history: [],
        model: 'gpt-4o',
        costLedger: new CostLedger(1),
      }),
    ).rejects.toThrow(/hard maximumCharge/)
    expect(calls).toBe(1)
  })
})

describe('buildWorkerDriverSystemPrompt — harness-aware driving contract', () => {
  const GOAL = 'make the failing test suite pass without touching the public API'

  it('weaves in the goal, the named harness, and its capability brief', () => {
    const p = buildWorkerDriverSystemPrompt({
      goal: GOAL,
      harness: 'claude-code',
      harnessBrief: '- parallel Task sub-agents (~10)\n- native WebSearch + MCP',
    })
    expect(p).toContain(GOAL)
    expect(p).toContain('claude-code')
    expect(p).toContain('parallel Task sub-agents')
  })

  it('demands rich, high-signal instructions and forbids thin steers', () => {
    const p = buildWorkerDriverSystemPrompt({ goal: GOAL })
    expect(p).toMatch(/dense, specific/i)
    expect(p).toMatch(/thin steer/i)
    expect(p).toMatch(/out-drive a human/i)
  })

  it('drives the worker to exploit its harness — parallelize, sub-agents, run-to-completion', () => {
    const p = buildWorkerDriverSystemPrompt({ goal: GOAL })
    expect(p).toMatch(/parallel/i)
    expect(p).toMatch(/sub-agent/i)
    expect(p).toMatch(/run to completion/i)
  })

  it('requires verification and refuses self-declared completion', () => {
    const p = buildWorkerDriverSystemPrompt({ goal: GOAL })
    expect(p).toMatch(/verif/i)
    expect(p).toMatch(/never accept "done" without the check/i)
    expect(p).toMatch(/the deliverable's checker does/i)
  })

  it('handles the first turn (no progress) and a resumed turn (with progress) distinctly', () => {
    const first = buildWorkerDriverSystemPrompt({ goal: GOAL })
    const resumed = buildWorkerDriverSystemPrompt({
      goal: GOAL,
      progress: 'wrote stub, 3/10 tests pass',
    })
    expect(first).toMatch(/has not started yet/i)
    expect(resumed).toContain('3/10 tests pass')
  })
})
