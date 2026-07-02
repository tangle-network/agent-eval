import { describe, expect, it } from 'vitest'
import {
  type AgentProfile,
  agentProfileHash,
  agentProfileId,
  agentProfileModelId,
  CODING_HARNESSES,
  expandProfileAxes,
  HARNESS_NATIVE_MODEL,
  harnessAxisOf,
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

describe('CODING_HARNESSES', () => {
  it('is the canonical primary coding-harness set', () => {
    expect([...CODING_HARNESSES]).toEqual(['opencode', 'claude-code', 'codex', 'kimi-code'])
  })
})

describe('expandProfileAxes', () => {
  const axisBase: AgentProfile = { name: 'agent', model: { default: 'deepseek-v4-flash' } }

  it('defaults to CODING_HARNESSES × the base model — one compatible cell per harness', () => {
    const profiles = expandProfileAxes({ base: axisBase })
    // An unprefixed model id is compatible with every harness → one cell each.
    expect(profiles).toHaveLength(CODING_HARNESSES.length)
    expect(profiles.map((p) => harnessAxisOf(p)?.harness).sort()).toEqual(
      [...CODING_HARNESSES].sort(),
    )
    for (const p of profiles) expect(p.model?.default).toBe('deepseek-v4-flash')
  })

  it('crosses harnesses × models with a distinct id per cell (no collapse)', () => {
    const profiles = expandProfileAxes({
      base: axisBase,
      harnesses: ['opencode', 'codex'],
      models: ['m-a', 'm-b'],
    })
    expect(profiles).toHaveLength(4)
    expect(new Set(profiles.map((p) => agentProfileId(p))).size).toBe(4)
  })

  it('drops (harness, model) pairs a vendor-locked harness cannot run', () => {
    const pairs = expandProfileAxes({
      base: axisBase,
      harnesses: ['claude-code', 'codex'],
      models: ['anthropic/claude-x', 'openai/gpt-x'],
    })
      .map((p) => harnessAxisOf(p))
      .filter(Boolean)
    expect(pairs).toContainEqual({ harness: 'claude-code', model: 'anthropic/claude-x' })
    expect(pairs).toContainEqual({ harness: 'codex', model: 'openai/gpt-x' })
    expect(pairs).not.toContainEqual({ harness: 'claude-code', model: 'openai/gpt-x' })
    expect(pairs).toHaveLength(2)
  })

  it('snaps a vendor-locked harness to its native default when it supports none of the swept models', () => {
    // Sweeping only a deepseek model must NOT drop kimi-code — it snaps to its own
    // Kimi model (the native sentinel), so the harness still appears in the sweep.
    const pairs = expandProfileAxes({
      base: axisBase,
      harnesses: ['kimi-code'],
      models: ['deepseek/deepseek-v3.2'],
    })
      .map((p) => harnessAxisOf(p))
      .filter(Boolean)
    expect(pairs).toEqual([{ harness: 'kimi-code', model: HARNESS_NATIVE_MODEL }])
  })

  it('produces a real head-to-head: universal harness on the swept model, locked harness on its native model', () => {
    // The leaderboard case — `opencode vs kimi-code` on a single deepseek sweep:
    // opencode runs deepseek, kimi-code snaps to its own model. Two harnesses, no drop.
    const byHarness = new Map(
      expandProfileAxes({
        base: axisBase,
        harnesses: ['opencode', 'kimi-code'],
        models: ['deepseek/deepseek-v3.2'],
      }).map((p) => [harnessAxisOf(p)?.harness, harnessAxisOf(p)?.model]),
    )
    expect(byHarness.get('opencode')).toBe('deepseek/deepseek-v3.2')
    expect(byHarness.get('kimi-code')).toBe(HARNESS_NATIVE_MODEL)
    expect(byHarness.size).toBe(2)
  })

  it('router-backed harness (opencode) accepts any provider', () => {
    expect(
      expandProfileAxes({
        base: axisBase,
        harnesses: ['opencode'],
        models: ['anthropic/x', 'openai/y'],
      }),
    ).toHaveLength(2)
  })

  it('keepIncompatible retains an otherwise-dropped pair', () => {
    expect(
      expandProfileAxes({
        base: axisBase,
        harnesses: ['claude-code'],
        models: ['openai/gpt-x'],
        keepIncompatible: true,
      }),
    ).toHaveLength(1)
  })

  it('carries harness + model in metadata and round-trips via harnessAxisOf', () => {
    const [p] = expandProfileAxes({ base: axisBase, harnesses: ['opencode'], models: ['m1'] })
    expect(p?.metadata?.harness).toBe('opencode')
    expect(p?.metadata?.harnessModel).toBe('m1')
    expect(harnessAxisOf(p as AgentProfile)).toEqual({ harness: 'opencode', model: 'm1' })
  })

  it('fails loud on no harnesses / no models — but snaps (never throws) on all-incompatible', () => {
    expect(() => expandProfileAxes({ base: axisBase, harnesses: [] })).toThrow(/no harnesses/)
    expect(() => expandProfileAxes({ base: { name: 'x' } })).toThrow(/no models/)
    // A locked harness with no compatible swept model snaps to its native default —
    // it is never dropped and the call never throws (that was the old drop behaviour).
    const [snapped] = expandProfileAxes({
      base: axisBase,
      harnesses: ['claude-code'],
      models: ['openai/gpt-x'],
    })
    expect(harnessAxisOf(snapped as AgentProfile)).toEqual({
      harness: 'claude-code',
      model: HARNESS_NATIVE_MODEL,
    })
  })
})

describe('harnessAxisOf', () => {
  it('returns undefined for a profile not produced by expandProfileAxes', () => {
    expect(harnessAxisOf({ metadata: undefined })).toBeUndefined()
    expect(harnessAxisOf({ metadata: { foo: 'bar' } })).toBeUndefined()
  })
})
