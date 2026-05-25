import { describe, expect, it } from 'vitest'
import {
  AGENT_PROFILE_KINDS,
  type AgentProfileCellInput,
  AgentProfileCellValidationError,
  agentProfileCellKey,
  assertRunAgentProfileCell,
  buildAgentProfileCell,
  buildSandboxAgentProfileCell,
  groupRunsByAgentProfileCell,
  requireAgentProfileCell,
  toAgentProfileJson,
  validateAgentProfileCell,
  verifyAgentProfileCell,
} from '../src/agent-profile-cell'

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
  sourceProfile: { kind: 'sandbox-agent-profile', profile: SOURCE_PROFILE },
  harness: { id: 'gtm-agent-eval', version: '0.3.0' },
  model: 'claude-sonnet-4-6@2025-04-15',
  promptHash: 'p'.repeat(64),
  dimensions: { personaSuite: 'business-owner', approvalsEnabled: true },
}

describe('agent profile cells', () => {
  it('hashes the full source profile and builds a stable cell id', async () => {
    const a = await buildAgentProfileCell(INPUT)
    const b = await buildAgentProfileCell({
      ...INPUT,
      dimensions: { approvalsEnabled: true, personaSuite: 'business-owner' },
    })

    expect(a.cellId).toMatch(/^agent-profile-cell:sha256:[0-9a-f]{64}$/)
    expect(a.sourceProfile.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.cellId).toBe(b.cellId)
    expect(await verifyAgentProfileCell(a)).toBe(true)
  })

  it('changes the cell id when the source profile changes outside the projection', async () => {
    const baseline = await buildAgentProfileCell(INPUT)
    const changedPermission = await buildAgentProfileCell({
      ...INPUT,
      sourceProfile: {
        kind: 'sandbox-agent-profile',
        profile: { ...SOURCE_PROFILE, permissions: { bash: 'allow' } },
      },
    })

    expect(changedPermission.sourceProfile.hash).not.toBe(baseline.sourceProfile.hash)
    expect(changedPermission.cellId).not.toBe(baseline.cellId)
  })

  it('rejects ambiguous or malformed source profile inputs', async () => {
    await expect(
      buildAgentProfileCell({
        ...INPUT,
        sourceProfile: { kind: 'sandbox-agent-profile' },
      }),
    ).rejects.toThrow(/hash or profile/)
    await expect(
      buildAgentProfileCell({
        ...INPUT,
        sourceProfile: { kind: 'sandbox-agent-profile', hash: 'h', profile: SOURCE_PROFILE },
      }),
    ).rejects.toThrow(/either hash or profile/)
    await expect(
      buildAgentProfileCell({
        ...INPUT,
        sourceProfile: { kind: 'sandbox-agent-profile', hash: 'not-a-sha' },
      }),
    ).rejects.toThrow(/sha256/)
  })

  it('rejects malformed cells and tampered cell ids', async () => {
    const cell = await buildAgentProfileCell(INPUT)
    expect(() => validateAgentProfileCell({ ...cell, profileId: '' })).toThrow(
      AgentProfileCellValidationError,
    )
    expect(() => validateAgentProfileCell({ ...cell, cellId: `${cell.cellId}0` })).toThrow(/cellId/)
    const tamperedCellId = `${cell.cellId.slice(0, -1)}${cell.cellId.endsWith('0') ? '1' : '0'}`
    expect(await verifyAgentProfileCell({ ...cell, cellId: tamperedCellId })).toBe(false)
  })

  it('requires explicit profile identity for cell grouping', async () => {
    const cell = await buildAgentProfileCell(INPUT)
    const records = [
      { runId: 'r1', agentProfile: cell, score: 0.7 },
      { runId: 'r2', agentProfile: cell, score: 0.8 },
    ]
    expect(agentProfileCellKey(records[0]!)).toBe(cell.cellId)
    expect(groupRunsByAgentProfileCell(records).get(cell.cellId)).toHaveLength(2)
    expect(() => requireAgentProfileCell({ runId: 'missing' })).toThrow(/missing agentProfile/)
  })

  it('asserts stored run records against the profile content hash and run fields', async () => {
    const cell = await buildAgentProfileCell(INPUT)
    const record = {
      runId: 'r1',
      model: 'claude-sonnet-4-6@2025-04-15',
      promptHash: 'p'.repeat(64),
      agentProfile: cell,
    }

    await expect(assertRunAgentProfileCell(record)).resolves.toBe(cell)
    await expect(
      assertRunAgentProfileCell({
        ...record,
        agentProfile: {
          ...cell,
          cellId: `${cell.cellId.slice(0, -1)}${cell.cellId.endsWith('0') ? '1' : '0'}`,
        },
      }),
    ).rejects.toThrow(/does not match its content/)
    await expect(
      assertRunAgentProfileCell({ ...record, model: 'gpt-4o-2024-11-20' }),
    ).rejects.toThrow(/does not match model/)
  })
})

// ── Consumer helpers ─────────────────────────────────────────────────

describe('AGENT_PROFILE_KINDS', () => {
  it('exposes the canonical sandbox-agent-profile kind', () => {
    expect(AGENT_PROFILE_KINDS.SANDBOX_AGENT_PROFILE).toBe('sandbox-agent-profile')
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

describe('buildSandboxAgentProfileCell', () => {
  const profile = {
    name: 'test-agent',
    version: '0.1.0',
    prompt: { system: 'You are a test agent.' },
    capabilities: { code: true },
  }

  it('hard-codes profileId = `${name}@${version}` and the sandbox-agent-profile kind', async () => {
    const cell = await buildSandboxAgentProfileCell(profile, {
      harness: { id: 'test-harness', version: 'v1' },
      model: 'claude-sonnet-4-6',
      promptHash: 'p'.repeat(64),
      dimensions: { backend: 'opencode' },
    })
    expect(cell.profileId).toBe('test-agent@0.1.0')
    expect(cell.sourceProfile.kind).toBe(AGENT_PROFILE_KINDS.SANDBOX_AGENT_PROFILE)
    expect(cell.sourceProfile.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(cell.harness?.id).toBe('test-harness')
    expect(cell.dimensions?.backend).toBe('opencode')
    expect(await verifyAgentProfileCell(cell)).toBe(true)
  })

  it('produces a cell whose sourceProfile.hash + cellId equal a hand-rolled buildAgentProfileCell of the documented recipe', async () => {
    // The whole point — every consumer using the helper agrees on the
    // canonical hash. A hand-rolled call following the README recipe
    // MUST produce the same hash.
    const handCell = await buildAgentProfileCell({
      profileId: `${profile.name}@${profile.version}`,
      sourceProfile: {
        kind: AGENT_PROFILE_KINDS.SANDBOX_AGENT_PROFILE,
        profile: toAgentProfileJson(profile),
      },
      model: 'claude-sonnet-4-6',
      promptHash: 'p'.repeat(64),
    })
    const helperCell = await buildSandboxAgentProfileCell(profile, {
      model: 'claude-sonnet-4-6',
      promptHash: 'p'.repeat(64),
    })
    expect(helperCell.sourceProfile.hash).toBe(handCell.sourceProfile.hash)
    expect(helperCell.cellId).toBe(handCell.cellId)
  })

  it('rejects profiles missing `name` or `version`', async () => {
    await expect(buildSandboxAgentProfileCell({ name: '', version: '0.1.0' }, {})).rejects.toThrow(
      /non-empty `name`/,
    )
    await expect(buildSandboxAgentProfileCell({ name: 'x', version: '' }, {})).rejects.toThrow(
      /non-empty `version`/,
    )
  })

  it('rejects non-object input', async () => {
    await expect(buildSandboxAgentProfileCell(null as never, {})).rejects.toThrow(
      /must be an object/,
    )
    await expect(buildSandboxAgentProfileCell('a profile' as never, {})).rejects.toThrow(
      /must be an object/,
    )
  })

  it('passes through harness, model, promptHash, dimensions verbatim', async () => {
    const cell = await buildSandboxAgentProfileCell(profile, {
      harness: { id: 'h1', version: 'v2.3' },
      model: 'gpt-5-1',
      promptHash: 'q'.repeat(64),
      dimensions: { backend: 'codex', verticalSlug: 'biz', cliBridge: true },
    })
    expect(cell.harness).toEqual({ id: 'h1', version: 'v2.3' })
    expect(cell.model).toBe('gpt-5-1')
    expect(cell.promptHash).toBe('q'.repeat(64))
    expect(cell.dimensions).toEqual({ backend: 'codex', cliBridge: true, verticalSlug: 'biz' })
  })

  it('two callers fingerprinting the SAME profile object share `sourceProfile.hash` (cross-product join)', async () => {
    // Property test for the cross-product cell join — the entire reason
    // this helper exists. Two products MUST hash identically.
    const a = await buildSandboxAgentProfileCell(profile, {
      model: 'm',
      promptHash: 'a'.repeat(64),
      dimensions: { backend: 'x' },
    })
    const b = await buildSandboxAgentProfileCell(profile, {
      model: 'm2',
      promptHash: 'b'.repeat(64),
      dimensions: { backend: 'y' },
    })
    expect(a.sourceProfile.hash).toBe(b.sourceProfile.hash)
    expect(a.cellId).not.toBe(b.cellId)
  })
})
