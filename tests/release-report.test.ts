import { describe, expect, it } from 'vitest'
import { evaluateReleaseConfidence } from '../src/release-confidence'
import { renderReleaseReport } from '../src/release-report'
import type { RunRecord } from '../src/run-record'

function rec(
  candidateId: string,
  score: number,
  splitTag: 'search' | 'holdout' = 'holdout',
): RunRecord {
  return {
    runId: `${candidateId}-${splitTag}`,
    experimentId: 'exp-1',
    candidateId,
    seed: 1,
    model: 'gpt-4o-2024-11-20',
    promptHash: 'prompt',
    configHash: 'config',
    commitSha: 'abc',
    wallMs: 1000,
    costUsd: 0.01,
    tokenUsage: { input: 10, output: 10 },
    outcome:
      splitTag === 'holdout'
        ? { holdoutScore: score, raw: { score } }
        : { searchScore: score, raw: { score } },
    splitTag,
  }
}

describe('release report rendering', () => {
  it('combines scorecard, runs, issues, and TraceAnalyst findings', () => {
    const runs = [rec('baseline', 0.7), rec('candidate', 0.9), rec('candidate', 0.8, 'search')]
    const scorecard = evaluateReleaseConfidence({
      target: 'agent-builder',
      candidateId: 'candidate',
      baselineId: 'baseline',
      scenarios: [{ id: 's1', input: 'x', expected: 'y', split: 'holdout' }],
      runs,
      thresholds: { minSearchRuns: 1, minHoldoutRuns: 1 },
    })
    const markdown = renderReleaseReport(scorecard, {
      runs,
      traceAnalystFindings: ['integration failures cluster around missing scopes'],
    })

    expect(markdown).toContain('# Release Report: agent-builder')
    expect(markdown).toContain('## Metrics')
    expect(markdown).toContain('Summary Table')
    expect(markdown).toContain('TraceAnalyst Findings')
  })
})
