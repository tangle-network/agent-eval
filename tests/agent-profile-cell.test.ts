import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AGENT_PROFILE_KINDS, type AgentProfileCellInput, AgentProfileCellValidationError, buildAgentProfileCell, toAgentProfileJson, validateAgentProfileCell, verifyAgentProfileCell } from '../src/agent-profile-cell'

const SOURCE_PROFILE = {
  name: 'gtm-agent',
  version: '1.0.0',
  permissions: { bash: 'ask' },
  subagents: {
    icp: { prompt: 'icp specialist', permissions: { web: 'allow' } },
  },
  resources: {
    files: [{ path: 'knowledge/icp.md', resource: { kind: 'inline', name: 'icp', content: 'x' } }],
  },
}

const INPUT: AgentProfileCellInput = {
  profileId: 'gtm-founder-v1',
  sourceProfile: { kind: 'agent-interface-profile', profile: SOURCE_PROFILE },
  harness: { id: 'gtm-agent-eval', version: '0.3.0' },
  model: 'claude-sonnet-4-6@2025-04-15',
  promptHash: 'p'.repeat(64),
  dimensions: { personaSuite: 'business-owner', approvalsEnabled: true },
}

// ── Consumer helpers ─────────────────────────────────────────────────

describe('AGENT_PROFILE_KINDS', () => {
  it('exposes the canonical agent-interface-profile kind', () => {
    expect(AGENT_PROFILE_KINDS.AGENT_INTERFACE_PROFILE).toBe('agent-interface-profile')
  })
})

describe('toAgentProfileJson', () => {
  it('round-trips a JSON-serializable object', () => {
    const profile = { name: 'x', version: '1.0', nested: { arr: [1, 'a', null, true] } }
    expect(toAgentProfileJson(profile)).toEqual({
      name: 'x',
      version: '1.0',
      nested: { arr: [1, 'a', null, true] },
    })
  })

  it('throws AgentProfileCellValidationError when the value is not JSON-serializable (function at top level)', () => {
    expect(() => toAgentProfileJson(() => 1)).toThrow(AgentProfileCellValidationError)
    expect(() => toAgentProfileJson(() => 1)).toThrow(/JSON-serializable/)
  })

  it('throws on a circular reference', () => {
    const cyclic: Record<string, unknown> = { name: 'x', version: '1.0' }
    cyclic.self = cyclic
    expect(() => toAgentProfileJson(cyclic)).toThrow(AgentProfileCellValidationError)
  })

  it('throws on a BigInt anywhere in the payload', () => {
    expect(() => toAgentProfileJson({ n: 1n })).toThrow(AgentProfileCellValidationError)
  })
})

describe('cell ids minted before the RFC 8785 scheme', () => {
  it('refuses a correctly hashed retired id instead of selecting another encoder', async () => {
    const cell = await buildAgentProfileCell(INPUT)
    const { cellId: _cellId, ...material } = cell
    void _cellId
    const legacyDigest = createHash('sha256')
      .update(JSON.stringify(sortKeysDeep(material)), 'utf8')
      .digest('hex')
    const legacyCell = { ...material, cellId: `agent-profile-cell:sha256:${legacyDigest}` }

    expect(() => validateAgentProfileCell(legacyCell)).toThrow(/sha256-rfc8785/)
    await expect(verifyAgentProfileCell(legacyCell)).rejects.toThrow(
      AgentProfileCellValidationError,
    )
  })
})

/** Produce a correctly hashed retired record to exercise scheme rejection. */
function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}
