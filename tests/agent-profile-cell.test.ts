import { describe, expect, it } from 'vitest'
import {
  type AgentProfileCellInput,
  AgentProfileCellValidationError,
  agentProfileCellKey,
  assertRunAgentProfileCell,
  buildAgentProfileCell,
  groupRunsByAgentProfileCell,
  requireAgentProfileCell,
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
