import { describe, expect, it } from 'vitest'
import { type AgentProfile, agentProfileHash } from './agent-profile'

const base: AgentProfile = {
  id: 'sonnet-baseline',
  model: 'claude-sonnet-4-6@2025-04-15',
  skills: ['intake', 'drafting'],
  promptVersion: 'v3',
  tools: ['vault', 'search'],
}

describe('agentProfileHash', () => {
  it('is deterministic for the same profile', () => {
    expect(agentProfileHash(base)).toBe(agentProfileHash({ ...base }))
  })

  it('is insensitive to skill + tool order', () => {
    expect(
      agentProfileHash({ ...base, skills: ['drafting', 'intake'], tools: ['search', 'vault'] }),
    ).toBe(agentProfileHash(base))
  })

  it('ignores the human-facing id label — behaviour identity, not name', () => {
    expect(agentProfileHash({ ...base, id: 'a-different-label' })).toBe(agentProfileHash(base))
  })

  it('changes when the model changes', () => {
    expect(agentProfileHash({ ...base, model: 'claude-opus-4-6@2025-04-15' })).not.toBe(
      agentProfileHash(base),
    )
  })

  it('changes when a skill is added — the primary behaviour lever', () => {
    expect(agentProfileHash({ ...base, skills: ['intake', 'drafting', 'redline'] })).not.toBe(
      agentProfileHash(base),
    )
  })

  it('changes when the prompt version changes', () => {
    expect(agentProfileHash({ ...base, promptVersion: 'v4' })).not.toBe(agentProfileHash(base))
  })

  it('treats an absent optional field and an empty one identically', () => {
    const a: AgentProfile = { id: 'a', model: 'm@2025-01-01' }
    const b: AgentProfile = { id: 'b', model: 'm@2025-01-01', skills: [], tools: [] }
    expect(agentProfileHash(a)).toBe(agentProfileHash(b))
  })

  it('throws on a profile with no model — an unkeyable profile fails loud', () => {
    expect(() => agentProfileHash({ id: 'broken', model: '  ' })).toThrow(/no model/)
  })
})
