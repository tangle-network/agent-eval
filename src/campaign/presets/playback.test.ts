
import { describe, expect, it } from 'vitest'



import {
  type ScoreboardRow,
  scoreboardSummary,
} from './playback'














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


