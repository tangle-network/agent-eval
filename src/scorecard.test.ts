import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentProfile } from './agent-profile'
import { agentProfileHash, agentProfileModelId } from './agent-profile'
import type { RunRecord } from './run-record'
import {
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  recordRuns,
  recordRunsToScorecard,
} from './scorecard'

const profile: AgentProfile = {
  name: 'sonnet-v3',
  version: 'v3',
  model: { default: 'claude-sonnet-4-6@2025-04-15' },
  resources: {
    skills: [
      { kind: 'inline', name: 'intake', content: 'intake skill' },
      { kind: 'inline', name: 'drafting', content: 'drafting skill' },
    ],
  },
}

/** Minimal RunRecord-shaped object — only the fields the scorecard reads. */
function makeRun(scenarioId: string, seed: number, score: number): RunRecord {
  return {
    runId: `${scenarioId}-seed${seed}`,
    experimentId: 'test',
    candidateId: 'cand',
    scenarioId,
    seed,
    model: agentProfileModelId(profile),
    promptHash: 'p',
    configHash: 'c',
    commitSha: 'sha',
    wallMs: 1,
    costUsd: 0,
    tokenUsage: { input: 1, output: 1 },
    outcome: { holdoutScore: score, raw: { score } },
    splitTag: 'holdout',
  } as RunRecord
}

const tmpDirs: string[] = []
function tmpLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-'))
  tmpDirs.push(dir)
  return join(dir, 'scorecard.jsonl')
}

afterEach(() => {
  tmpDirs.length = 0
})

describe('recordRuns', () => {
  it('groups runs by scenario into one entry per cell', () => {
    const runs = [
      makeRun('persona-a', 0, 0.8),
      makeRun('persona-a', 1, 0.9),
      makeRun('persona-b', 0, 0.5),
    ]
    const lines = recordRuns(runs, { profile, commitSha: 'abc123' })
    expect(lines).toHaveLength(2)
    const a = lines.find((l) => l.scenarioId === 'persona-a')!
    expect(a.entry.scores).toEqual([0.8, 0.9])
    expect(a.entry.composite).toBeCloseTo(0.85, 6) // median of [0.8, 0.9]
    expect(a.entry.runIds).toEqual(['persona-a-seed0', 'persona-a-seed1'])
    expect(a.profileHash).toBe(agentProfileHash(profile))
    expect(a.model).toBe(agentProfileModelId(profile))
  })
})

describe('loadScorecard', () => {
  it('returns an empty scorecard for a missing file', () => {
    expect(loadScorecard(join(tmpdir(), 'does-not-exist-xyz.jsonl'))).toEqual({
      cells: [],
      profiles: {},
    })
  })

  it('round-trips appended runs and sorts each timeline chronologically', () => {
    const log = tmpLog()
    recordRunsToScorecard(log, [makeRun('persona-a', 0, 0.7)], {
      profile,
      commitSha: 'c1',
      timestamp: '2026-05-20T00:00:00Z',
    })
    recordRunsToScorecard(log, [makeRun('persona-a', 0, 0.9)], {
      profile,
      commitSha: 'c2',
      timestamp: '2026-05-21T00:00:00Z',
    })
    const card = loadScorecard(log)
    expect(card.cells).toHaveLength(1)
    expect(card.cells[0]!.timeline.map((e) => e.commitSha)).toEqual(['c1', 'c2'])
    expect(card.profiles[agentProfileHash(profile)]?.name).toBe('sonnet-v3')
  })

  it('skips a malformed line rather than failing the whole read', () => {
    const log = tmpLog()
    recordRunsToScorecard(log, [makeRun('persona-a', 0, 0.7)], { profile, commitSha: 'c1' })
    writeFileSync(log, `not json at all\n{"partial":true}\n${readFileSync(log, 'utf8')}`)
    const card = loadScorecard(log)
    expect(card.cells).toHaveLength(1)
  })
})

describe('diffScorecard', () => {
  function build(commits: Array<{ sha: string; scores: number[] }>) {
    const log = tmpLog()
    for (const [i, commit] of commits.entries()) {
      recordRunsToScorecard(
        log,
        commit.scores.map((s, seed) => makeRun('persona-a', seed, s)),
        { profile, commitSha: commit.sha, timestamp: `2026-05-${20 + i}T00:00:00Z` },
      )
    }
    return loadScorecard(log)
  }

  it('marks a cell with only one entry as new', () => {
    const diff = diffScorecard(build([{ sha: 'c1', scores: [0.8, 0.81, 0.82] }]))
    expect(diff.cells[0]!.verdict).toBe('new')
    expect(diff.summary.new).toBe(1)
  })

  it('flags a real regression — large effect, significant', () => {
    const diff = diffScorecard(
      build([
        { sha: 'c1', scores: [0.88, 0.91, 0.9, 0.89] },
        { sha: 'c2', scores: [0.58, 0.62, 0.6, 0.59] },
      ]),
    )
    const cell = diff.cells[0]!
    expect(cell.verdict).toBe('regressed')
    expect(cell.delta).toBeLessThan(0)
    expect(cell.cohensD).not.toBeNull()
    expect(diff.summary.regressed).toBe(1)
  })

  it('flags a real improvement', () => {
    const diff = diffScorecard(
      build([
        { sha: 'c1', scores: [0.58, 0.62, 0.6, 0.59] },
        { sha: 'c2', scores: [0.88, 0.91, 0.9, 0.89] },
      ]),
    )
    expect(diff.cells[0]!.verdict).toBe('improved')
  })

  it('calls an overlapping, tiny move flat — not a regression', () => {
    const diff = diffScorecard(
      build([
        { sha: 'c1', scores: [0.8, 0.82, 0.81, 0.8] },
        { sha: 'c2', scores: [0.81, 0.79, 0.8, 0.81] },
      ]),
    )
    expect(diff.cells[0]!.verdict).toBe('flat')
    expect(diff.summary.regressed).toBe(0)
  })

  it('can diff against a named baseline commit, not just the predecessor', () => {
    const card = build([
      { sha: 'c1', scores: [0.88, 0.91, 0.9, 0.89] },
      { sha: 'c2', scores: [0.87, 0.9, 0.89, 0.88] },
      { sha: 'c3', scores: [0.58, 0.62, 0.6, 0.59] },
    ])
    const diff = diffScorecard(card, { baselineCommit: 'c1' })
    expect(diff.cells[0]!.baselineCommit).toBe('c1')
    expect(diff.cells[0]!.verdict).toBe('regressed')
  })

  it('formatScorecardDiff surfaces a regression in the report', () => {
    const diff = diffScorecard(
      build([
        { sha: 'c1', scores: [0.88, 0.91, 0.9, 0.89] },
        { sha: 'c2', scores: [0.58, 0.62, 0.6, 0.59] },
      ]),
    )
    const report = formatScorecardDiff(diff)
    expect(report).toMatch(/1 regressed/)
    expect(report).toMatch(/REGRESSED.*persona-a/)
  })
})
