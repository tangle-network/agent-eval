import { describe, expect, it } from 'vitest'

import type { AgentProfile } from '../../agent-profile'
import type { CorrectnessChecker } from '../../completion-verifier'
import type { RuntimeEventLike } from '../../produced-state'
import type { DispatchContext } from '../types'
import {
  makePlaybackDispatch,
  type PlaybackContext,
  type PlaybackDriver,
  scoreUserStory,
  type UserStory,
  userStoryScoreboard,
} from './playback'

// A story whose first requirement the agent produces (an artifact) and whose
// second it does NOT (an approval proposal) — so the scoreboard must show one
// PASS and one FAIL, the core Jira tick-off behaviour.
const STORY: UserStory = {
  id: 'tax-filing-flow',
  kind: 'user-story',
  title: 'Produce a tax filing and route it for approval',
  steps: [{ action: 'open a new return' }, { action: 'send: prepare the 1065 for the LLC' }],
  requirements: [
    { reqId: 'r1', title: 'tax filing artifact', satisfiedBy: 'artifact' },
    { reqId: 'r2', title: 'approval proposal', satisfiedBy: 'proposal' },
  ],
}

// Driver that emits the artifact (satisfies r1) but no proposal (fails r2).
const fakeDriver: PlaybackDriver = {
  async run(): Promise<readonly RuntimeEventLike[]> {
    return [
      {
        type: 'artifact',
        artifactId: 'a1',
        name: 'tax-filing-1065.md',
        mimeType: 'text/markdown',
        content:
          'A complete tax filing: Form 1065 for the LLC with partner capital ' +
          'account allocations, Schedule K-1s, and the balance sheet reconciled.',
      },
    ]
  },
}

// Deterministic checker — a structurally-present artifact with content passes.
const passingChecker: CorrectnessChecker = async () => ({ correct: true, reason: 'stub' })

const ctx = {
  cellId: 'c0',
  rep: 0,
  seed: 1,
  signal: new AbortController().signal,
} as unknown as DispatchContext
const profile = { id: 'haiku', model: 'anthropic/claude-haiku-4-5' } as unknown as AgentProfile

describe('makePlaybackDispatch', () => {
  it('pipes driver events through extractProducedState into ProducedState', async () => {
    const dispatch = makePlaybackDispatch(fakeDriver)
    const produced = await dispatch(profile, STORY, ctx)
    expect(produced.artifacts).toHaveLength(1)
    expect(produced.artifacts[0]!.path).toBe('tax-filing-1065.md')
    expect(produced.proposals).toHaveLength(0)
  })

  it('forwards the profile to the driver as PlaybackContext', async () => {
    let seen: PlaybackContext | undefined
    const spy: PlaybackDriver = {
      async run(_story, c) {
        seen = c
        return []
      },
    }
    await makePlaybackDispatch(spy)(profile, STORY, ctx)
    expect(seen?.profile.model).toBe('anthropic/claude-haiku-4-5')
    expect(seen?.cellId).toBe('c0')
  })
})

describe('scoreUserStory + userStoryScoreboard', () => {
  it('produces a per-requirement PASS/FAIL tick-off', async () => {
    const dispatch = makePlaybackDispatch(fakeDriver)
    const produced = await dispatch(profile, STORY, ctx)
    const verdict = await scoreUserStory(STORY, produced, passingChecker)

    expect(verdict.title).toBe(STORY.title)
    expect(verdict.fullyComplete).toBe(false)
    expect(verdict.completionRate).toBeCloseTo(0.5)

    const board = userStoryScoreboard([verdict])
    expect(board).toHaveLength(2)
    const byReq = Object.fromEntries(board.map((r) => [r.reqId, r.status]))
    expect(byReq).toEqual({ r1: 'PASS', r2: 'FAIL' })
    expect(board.every((r) => r.storyId === 'tax-filing-flow')).toBe(true)
  })

  it('every row carries evidence for the verdict', async () => {
    const produced = await makePlaybackDispatch(fakeDriver)(profile, STORY, ctx)
    const board = userStoryScoreboard([await scoreUserStory(STORY, produced, passingChecker)])
    for (const row of board) expect(Array.isArray(row.evidence)).toBe(true)
  })
})
