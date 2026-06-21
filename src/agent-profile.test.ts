import { describe, expect, it } from 'vitest'
import {
  type AgentProfile,
  agentProfileHash,
  agentProfileId,
  agentProfileModelId,
} from './agent-profile'

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

  it('treats resource array order as behavior-bearing', () => {
    const first = {
      ...base,
      resources: {
        skills: [
          { kind: 'inline', name: 'first', content: 'first skill' },
          { kind: 'inline', name: 'second', content: 'second skill' },
        ],
      },
    } satisfies AgentProfile
    const second = {
      ...base,
      resources: {
        skills: [
          { kind: 'inline', name: 'second', content: 'second skill' },
          { kind: 'inline', name: 'first', content: 'first skill' },
        ],
      },
    } satisfies AgentProfile

    expect(agentProfileHash(first)).not.toBe(agentProfileHash(second))
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

describe('agentProfileId', () => {
  it('uses the trimmed profile name plus a behavior hash suffix', () => {
    const id = agentProfileId({ ...base, name: '  sonnet-baseline  ' })

    expect(id).toMatch(/^sonnet-baseline-[0-9a-f]{16}$/)
  })

  it('sanitizes the label before using it in run ids and paths', () => {
    const id = agentProfileId({ ...base, name: '  sonnet/legal: v1  ' })

    expect(id).toMatch(/^sonnet-legal-v1-[0-9a-f]{16}$/)
  })

  it('uses version as the human label when name is absent', () => {
    const id = agentProfileId({ ...base, name: undefined, version: '  v3  ' })

    expect(id).toMatch(/^v3-[0-9a-f]{16}$/)
  })

  it('falls back to a profile hash label when no name or version is present', () => {
    const id = agentProfileId({ ...base, name: undefined, version: undefined })

    expect(id).toMatch(/^profile-[0-9a-f]{16}$/)
  })

  it('fails loudly instead of inventing a fallback id for an unrecordable profile', () => {
    expect(() => agentProfileId({ name: 'model-less-profile' })).toThrow(
      /model-less-profile.*model\.default/,
    )
  })

  it('does not collapse distinct profiles that share the same version label', () => {
    const first = agentProfileId({
      ...base,
      name: undefined,
      version: 'v3',
      model: { default: 'claude-sonnet-4-6@2025-04-15' },
    })
    const second = agentProfileId({
      ...base,
      name: undefined,
      version: 'v3',
      model: { default: 'claude-opus-4-6@2025-04-15' },
    })

    expect(first).not.toBe(second)
  })
})

describe('agentProfileModelId', () => {
  it('returns the trimmed default model id', () => {
    expect(agentProfileModelId({ ...base, model: { default: '  model@2026-01-01  ' } })).toBe(
      'model@2026-01-01',
    )
  })

  it('names the broken profile when the default model is missing', () => {
    expect(() => agentProfileModelId({ name: 'broken-profile', model: { default: '  ' } })).toThrow(
      /broken-profile.*model\.default/,
    )
  })
})
