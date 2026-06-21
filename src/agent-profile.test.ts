import { describe, expect, it } from 'vitest'
import { type AgentProfile, agentProfileHash } from './agent-profile'

const base: AgentProfile = {
  name: 'sonnet-baseline',
  version: 'v3',
  model: { default: 'claude-sonnet-4-6@2025-04-15' },
  resources: {
    skills: [
      { kind: 'inline', name: 'intake', content: 'intake skill' },
      { kind: 'inline', name: 'drafting', content: 'drafting skill' },
    ],
  },
  tools: { vault: true, search: true },
}

describe('agentProfileHash', () => {
  it('is deterministic for the same profile', () => {
    expect(agentProfileHash(base)).toBe(agentProfileHash({ ...base }))
  })

  it('is insensitive to tag order', () => {
    expect(agentProfileHash({ ...base, tags: ['drafting', 'intake'] })).toBe(
      agentProfileHash({ ...base, tags: ['intake', 'drafting'] }),
    )
  })

  it('ignores human-facing name and description', () => {
    expect(agentProfileHash({ ...base, name: 'a-different-label', description: 'docs' })).toBe(
      agentProfileHash(base),
    )
  })

  it('changes when the model changes', () => {
    expect(
      agentProfileHash({ ...base, model: { default: 'claude-opus-4-6@2025-04-15' } }),
    ).not.toBe(agentProfileHash(base))
  })

  it('changes when a skill resource is added — the primary behaviour lever', () => {
    expect(
      agentProfileHash({
        ...base,
        resources: {
          ...base.resources,
          skills: [
            ...(base.resources?.skills ?? []),
            { kind: 'inline', name: 'redline', content: 'redline skill' },
          ],
        },
      }),
    ).not.toBe(agentProfileHash(base))
  })

  it('changes when the profile version changes', () => {
    expect(agentProfileHash({ ...base, version: 'v4' })).not.toBe(agentProfileHash(base))
  })

  it('treats an absent optional field and an empty one identically', () => {
    const a: AgentProfile = { name: 'a', model: { default: 'm@2025-01-01' } }
    const b: AgentProfile = { name: 'b', model: { default: 'm@2025-01-01' } }
    expect(agentProfileHash(a)).toBe(agentProfileHash(b))
  })

  it('throws on a profile with no default model — an unkeyable profile fails loud', () => {
    expect(() => agentProfileHash({ name: 'broken', model: { default: '  ' } })).toThrow(
      /model.default/,
    )
  })
})
