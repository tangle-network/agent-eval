import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { type AgentProfile, agentProfileId } from '../../agent-profile'
import { fsCampaignStorage } from '../storage'
import type { DispatchContext, JudgeConfig, Scenario } from '../types'
import {
  createProfileMatrixPlan,
  finalizeProfileMatrix,
  type ProfileMatrixPlan,
  runProfileMatrixSegment,
} from './segmented-profile-matrix'

const roots: string[] = []

const profiles: AgentProfile[] = [
  { name: 'alpha', model: { default: 'fixture/model@2026-08-01' } },
  { name: 'beta', model: { default: 'fixture/model@2026-08-01' } },
]

const scenarios: Scenario[] = [
  { id: 'one', kind: 'fixture' },
  { id: 'two', kind: 'fixture' },
]

const judge: JudgeConfig<{ score: number }, Scenario> = {
  name: 'score',
  judgeVersion: 'segmented-matrix-fixture/1',
  dimensions: [{ key: 'score', description: 'fixture score' }],
  score: ({ artifact }) => ({
    dimensions: { score: artifact.score },
    composite: artifact.score,
    notes: '',
  }),
}

function plan(): ProfileMatrixPlan<Scenario, { score: number }> {
  return createProfileMatrixPlan({
    profiles,
    scenarios,
    judges: [judge],
    commitSha: 'fixture-commit',
    dispatchRef: 'segmented-matrix-fixture/1',
    reps: 2,
    seed: 19,
    integrity: 'assert',
  })
}

function runDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-segmented-matrix-'))
  roots.push(root)
  return root
}

function dispatchFor(args: { failCell?: string; calls: string[] }) {
  return async (
    _profile: AgentProfile,
    scenario: Scenario,
    context: DispatchContext,
  ): Promise<{ score: number }> => {
    args.calls.push(context.cellId)
    if (args.failCell === context.cellId) throw new Error('fixture dispatch failure')
    const artifact = { score: context.cellId === 'one:0' ? 0 : scenario.id === 'one' ? 1 : 0.5 }
    const paid = await context.cost.runPaidCall({
      actor: 'fixture-agent',
      model: 'fixture/model@2026-08-01',
      execute: async () => artifact,
      receipt: () => ({
        model: 'fixture/model@2026-08-01',
        inputTokens: 11,
        outputTokens: 7,
        actualCostUsd: 0.01,
      }),
    })
    if (!paid.succeeded) throw paid.error
    return paid.value
  }
}

function firstHalf(current: ProfileMatrixPlan<Scenario, { score: number }>) {
  return current.rows.slice(0, current.rows.length / 2)
}

function secondHalf(current: ProfileMatrixPlan<Scenario, { score: number }>) {
  return current.rows.slice(current.rows.length / 2)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('segmented profile matrix ownership', () => {
  it('claims disjoint rows, resumes failed cells, and finalizes zero scores distinctly', async () => {
    const current = plan()
    const root = runDir()
    const storage = fsCampaignStorage()
    const calls: string[] = []
    const first = firstHalf(current)
    const failedCell = `${first[0]!.scenarioId}:${first[0]!.rep}`

    const failed = await runProfileMatrixSegment({
      plan: current,
      segmentId: 'grant-a',
      rows: first,
      dispatch: dispatchFor({ failCell: failedCell, calls }),
      runDir: root,
      storage,
    })
    expect(failed.matrix.records).toHaveLength(first.length)
    expect(failed.coverage.failed).toContain(first[0]!.rowId)
    expect(failed.coverage.present).toBe(first.length)

    const callsAfterFailure = calls.length
    const resumed = await runProfileMatrixSegment({
      plan: current,
      segmentId: 'grant-a',
      rows: first,
      dispatch: dispatchFor({ calls }),
      runDir: root,
      storage,
    })
    expect(calls.length).toBeGreaterThan(callsAfterFailure)
    expect(resumed.coverage.failed).toEqual([])

    const second = secondHalf(current)
    await runProfileMatrixSegment({
      plan: current,
      segmentId: 'grant-b',
      rows: second,
      dispatch: dispatchFor({ calls }),
      runDir: root,
      storage,
    })
    const final = await finalizeProfileMatrix({ plan: current, runDir: root, storage })
    expect(final.records).toHaveLength(current.rows.length)
    expect(Object.keys(final.campaigns)).toHaveLength(profiles.length)
    expect(final.coverage).toMatchObject({
      expected: current.rows.length,
      present: current.rows.length,
      missing: [],
      failed: [],
    })
    expect(final.coverage.zeroScore.length).toBeGreaterThan(0)
    expect(final.byScenario.one?.n).toBe(4)
    expect(final.byScenario.two?.n).toBe(4)
  })

  it('rejects duplicate and overlapping row claims', async () => {
    const current = plan()
    const root = runDir()
    const first = firstHalf(current)
    await expect(
      runProfileMatrixSegment({
        plan: current,
        segmentId: 'duplicate',
        rows: [first[0]!, first[0]!],
        dispatch: dispatchFor({ calls: [] }),
        runDir: root,
      }),
    ).rejects.toThrow(/duplicate row/)

    await runProfileMatrixSegment({
      plan: current,
      segmentId: 'owner-a',
      rows: [first[0]!],
      dispatch: dispatchFor({ calls: [] }),
      runDir: root,
    })
    await expect(
      runProfileMatrixSegment({
        plan: current,
        segmentId: 'owner-b',
        rows: [first[0]!],
        dispatch: dispatchFor({ calls: [] }),
        runDir: root,
      }),
    ).rejects.toThrow(/overlap/)
  })

  it('refuses finalization while a declared row is missing', async () => {
    const current = plan()
    const root = runDir()
    const selected = [current.rows[0]!]
    await runProfileMatrixSegment({
      plan: current,
      segmentId: 'only-one',
      rows: selected,
      dispatch: dispatchFor({ calls: [] }),
      runDir: root,
    })
    await expect(finalizeProfileMatrix({ plan: current, runDir: root })).rejects.toThrow(
      /every row is claimed/,
    )
  })

  it('rejects changed plan inputs against the persisted identity', async () => {
    const current = plan()
    const root = runDir()
    await runProfileMatrixSegment({
      plan: current,
      segmentId: 'identity-a',
      rows: [current.rows[0]!],
      dispatch: dispatchFor({ calls: [] }),
      runDir: root,
    })
    const changed = createProfileMatrixPlan({
      profiles,
      scenarios: [{ ...scenarios[0]!, tags: ['changed'] }, scenarios[1]!],
      judges: [judge],
      commitSha: 'fixture-commit',
      dispatchRef: 'segmented-matrix-fixture/1',
      reps: 2,
      seed: 19,
      integrity: 'assert',
    })
    await expect(
      runProfileMatrixSegment({
        plan: changed,
        segmentId: 'identity-b',
        rows: [changed.rows[0]!],
        dispatch: dispatchFor({ calls: [] }),
        runDir: root,
      }),
    ).rejects.toThrow(/persisted plan identity/)
  })

  it('rejects corrupt and stale cell records before dispatching finalization', async () => {
    const current = plan()
    const root = runDir()
    await runProfileMatrixSegment({
      plan: current,
      segmentId: 'all',
      rows: current.rows,
      dispatch: dispatchFor({ calls: [] }),
      runDir: root,
    })
    const first = current.rows[0]!
    const profileDir = agentProfileId(
      profiles.find((profile) => agentProfileId(profile) === first.profileId)!,
    )
    const cachePath = join(
      root,
      profileDir,
      `${first.scenarioId}_${first.rep}`,
      'cached-result.json',
    )
    const original = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
    writeFileSync(cachePath, '{corrupt')
    await expect(finalizeProfileMatrix({ plan: current, runDir: root })).rejects.toThrow(
      /corrupt JSON/,
    )
    writeFileSync(cachePath, JSON.stringify({ ...original, manifestHash: 'stale' }))
    await expect(finalizeProfileMatrix({ plan: current, runDir: root })).rejects.toThrow(
      /cached cell|manifest|identity/,
    )
    unlinkSync(cachePath)
  })
})
