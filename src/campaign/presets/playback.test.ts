import type { AgentProfile } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import type { CorrectnessChecker } from '../../completion-verifier'
import type { RuntimeEventLike } from '../../produced-state'
import type { DispatchContext } from '../types'
import {
  makePlaybackDispatch,
  type PlaybackContext,
  type PlaybackDriver,
  renderScoreboardMarkdown,
  type ScoreboardRow,
  scoreboardSummary,
  scoreUserStory,
  type UserStory,
  type UserStoryVerdict,
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
const profile = {
  name: 'haiku',
  model: { default: 'anthropic/claude-haiku-4-5' },
} satisfies AgentProfile

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
    expect(seen?.profile.model?.default).toBe('anthropic/claude-haiku-4-5')
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

// Two stories: s1 fully passes (2/2), s2 fails its only requirement. A pipe in
// s2's requirement title exercises markdown-cell escaping.
const ROWS: ScoreboardRow[] = [
  {
    storyId: 's1',
    storyTitle: 'Form a Delaware C-Corp',
    reqId: 'r1',
    reqTitle: 'certificate of incorporation',
    status: 'PASS',
    evidence: ["artifact 'formation/cert.md' matched (token recall 1.00)"],
  },
  {
    storyId: 's1',
    storyTitle: 'Form a Delaware C-Corp',
    reqId: 'r2',
    reqTitle: 'corporate bylaws',
    status: 'PASS',
    evidence: ['correctness: pass'],
  },
  {
    storyId: 's2',
    storyTitle: 'Redline an NDA',
    reqId: 'r3',
    reqTitle: 'redlined NDA | with rationale',
    status: 'FAIL',
    evidence: ['no produced artifact/proposal/tool-call matched this requirement'],
  },
]

describe('scoreboardSummary', () => {
  it('rolls per-requirement rows into the launch headline counts', () => {
    expect(scoreboardSummary(ROWS)).toEqual({
      stories: 2,
      storiesFullyComplete: 1,
      requirements: 3,
      passed: 2,
      failed: 1,
      passRate: 2 / 3,
    })
  })

  it('empty board is all-zero with passRate 0 (no divide-by-zero)', () => {
    expect(scoreboardSummary([])).toEqual({
      stories: 0,
      storiesFullyComplete: 0,
      requirements: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
    })
  })
})

describe('renderScoreboardMarkdown', () => {
  it('headlines shipped / passing / open counts', () => {
    const md = renderScoreboardMarkdown(ROWS)
    expect(md).toContain('**1/2** user stories fully shipped')
    expect(md).toContain('**2/3** requirements passing (67%)')
    expect(md).toContain('**1** open')
  })

  it('lists FAIL rows under Open tickets before the per-story tables, escaping cell pipes', () => {
    const md = renderScoreboardMarkdown(ROWS)
    const openIdx = md.indexOf('## Open tickets')
    const perStoryIdx = md.indexOf('## Per-story tick-off')
    expect(openIdx).toBeGreaterThan(-1)
    // the failing requirement surfaces in the open-tickets section, ahead of per-story
    const failIdx = md.indexOf('redlined NDA')
    expect(failIdx).toBeGreaterThan(openIdx)
    expect(failIdx).toBeLessThan(perStoryIdx)
    // the pipe in the requirement title is escaped so the table stays parseable
    expect(md).toContain('redlined NDA \\| with rationale')
  })

  it('marks fully-complete stories ✅ and incomplete ⚠️ with PASS/FAIL cells', () => {
    const md = renderScoreboardMarkdown(ROWS)
    expect(md).toContain('### Form a Delaware C-Corp — 2/2 ✅')
    expect(md).toContain('### Redline an NDA — 0/1 ⚠️')
    expect(md).toContain('✅ PASS')
    expect(md).toContain('❌ FAIL')
  })

  it('renders the title + run metadata when provided', () => {
    const md = renderScoreboardMarkdown(ROWS, {
      title: 'Legal launch readiness',
      meta: { runId: 'run-1', backend: 'tcloud', model: 'openai/gpt-4o-mini' },
    })
    expect(md.startsWith('# Legal launch readiness')).toBe(true)
    expect(md).toContain('- **runId:** run-1')
    expect(md).toContain('- **model:** openai/gpt-4o-mini')
  })

  it('reports no open tickets when every requirement passes', () => {
    const allPass: ScoreboardRow[] = ROWS.map((r) => ({ ...r, status: 'PASS' as const }))
    const md = renderScoreboardMarkdown(allPass)
    expect(md).toContain('_All requirements passing — no open tickets._')
    expect(md).not.toContain('## Open tickets')
    expect(md).toContain('**2/2** user stories fully shipped')
  })

  it('is pure — identical rows render byte-identical output', () => {
    expect(renderScoreboardMarkdown(ROWS)).toBe(renderScoreboardMarkdown(ROWS))
  })

  it('drives the full verdict → scoreboard → markdown chain', async () => {
    const produced = await makePlaybackDispatch(fakeDriver)(profile, STORY, ctx)
    const verdict: UserStoryVerdict = await scoreUserStory(STORY, produced, passingChecker)
    const md = renderScoreboardMarkdown(userStoryScoreboard([verdict]), { title: 'Tax playback' })
    expect(md.startsWith('# Tax playback')).toBe(true)
    // r1 (artifact) passes, r2 (proposal) fails → story is not fully shipped
    expect(md).toContain('**0/1** user stories fully shipped')
    expect(md).toContain('✅ PASS')
    expect(md).toContain('❌ FAIL')
  })
})
