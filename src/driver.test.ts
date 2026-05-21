/**
 * The simulated user is the eval's difficulty knob. These tests pin the
 * adversarial contract of the driver system prompt so a future edit cannot
 * quietly soften it back into a passive script-reader — a regression that
 * would inflate every downstream agent score with no real improvement.
 */

import { describe, expect, it } from 'vitest'

import { buildDriverSystemPrompt } from './driver'
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
