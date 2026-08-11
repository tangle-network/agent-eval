/**
 * The pure-profile multishot path: `MultishotShape`'s callbacks are optional,
 * and omitted ones derive from the AgentProfile + persona payload. This is the
 * MultishotShape half of the "profile beside required role-builder callbacks"
 * mixed abstraction named in tangle-network/agent-runtime#694.
 */

import type { AgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import {
  defaultMultishotDriverSystemPrompt,
  defaultMultishotOpener,
  defaultShapeFromProfile,
  type MultishotPersona,
  type MultishotTransportRequest,
  type MultishotTransportResponse,
  renderPersonaFacts,
  runMultishot,
} from '../../src/multishot/index'

const PROFILE: AgentProfile = {
  name: 'tax-agent',
  description: 'a senior tax-preparation agent',
  prompt: { systemPrompt: 'You are a senior tax preparer.' },
}

interface TestPersona extends MultishotPersona {
  id: string
  name: string
  filingStatus: string
}

const PERSONA: TestPersona = { id: 'alice', name: 'Alice', filingStatus: 'single' }

describe('shape defaults — pure functions of profile + persona', () => {
  it('renderPersonaFacts serializes the whole payload except id, dropping nothing', () => {
    const facts = renderPersonaFacts({
      id: 'x',
      name: 'Bo',
      dependents: 2,
      w2: { employer: 'ACME' },
    })
    expect(facts).toContain('- name: Bo')
    expect(facts).toContain('- dependents: 2')
    expect(facts).toContain('- w2: {"employer":"ACME"}')
    expect(facts).not.toContain('- id:')
  })

  it('the derived opener introduces the persona and addresses the profiled agent', () => {
    const opener = defaultMultishotOpener(PROFILE, PERSONA)
    expect(opener).toContain('Alice')
    expect(opener).toContain('single')
    expect(opener).toContain('a senior tax-preparation agent')
  })

  it('the derived driver prompt sets character, pushback, and the never-go-silent rule', () => {
    const prompt = defaultMultishotDriverSystemPrompt(PROFILE, PERSONA)
    expect(prompt).toContain('persona "alice"')
    expect(prompt).toContain('Alice')
    expect(prompt).toMatch(/push back/i)
    expect(prompt).toMatch(/never go silent/i)
    expect(prompt).toMatch(/only your next message/i)
  })

  it('caller-provided callbacks override the derived ones; omitted ones fill in', () => {
    const shape = defaultShapeFromProfile<TestPersona>(PROFILE, {
      buildOpener: () => 'custom opener',
    })
    expect(shape.buildOpener(PERSONA)).toBe('custom opener')
    expect(shape.buildDriverSystemPrompt(PERSONA)).toContain('persona "alice"')
  })
})

describe('runMultishot — pure-profile call (no shape)', () => {
  it('runs with profile + persona only; derived opener and driver prompt reach the wire', async () => {
    const agentRequests: MultishotTransportRequest[] = []
    const driverRequests: MultishotTransportRequest[] = []
    const agentTransport = async (
      req: MultishotTransportRequest,
    ): Promise<MultishotTransportResponse> => {
      agentRequests.push(req)
      return { message: { content: 'Here is my first answer.' } }
    }
    const driverTransport = async (
      req: MultishotTransportRequest,
    ): Promise<MultishotTransportResponse> => {
      driverRequests.push(req)
      return { message: { content: 'I need more specifics about my filing.' } }
    }

    const result = await runMultishot<TestPersona>({
      profile: PROFILE,
      persona: PERSONA,
      maxTurns: 2,
      agentTransport,
      driverTransport,
      apiKey: 'test-key',
      baseUrl: 'http://localhost:0',
    })

    // The derived opener is the first user message the agent sees.
    const opener = String(agentRequests[0]!.messages[1]!.content)
    expect(opener).toBe(defaultMultishotOpener(PROFILE, PERSONA))
    expect(opener).toContain('Alice')

    // The derived driver system prompt steers the simulated user.
    const driverSystem = String(driverRequests[0]!.messages[0]!.content)
    expect(driverSystem).toBe(defaultMultishotDriverSystemPrompt(PROFILE, PERSONA))
    expect(driverSystem).toMatch(/never go silent/i)

    // The loop completed: opener + assistant turns + one driver turn.
    expect(result.transcript.filter((m) => m.role === 'assistant')).toHaveLength(2)
    expect(result.transcript[0]!.content).toBe(opener)
  })
})
