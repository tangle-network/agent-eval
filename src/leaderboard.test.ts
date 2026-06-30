import { describe, expect, it } from 'vitest'
import { leaderboard } from './leaderboard'
import type { RunRecord } from './run-record'

// Minimal RunRecord stub — only the fields leaderboard reads, plus a pass flag.
function rec(
  cell: string,
  harness: string,
  model: string,
  passed: boolean,
  costUsd: number,
  tin: number,
  tout: number,
  wallMs: number,
): RunRecord {
  return {
    model,
    wallMs,
    costUsd,
    tokenUsage: { input: tin, output: tout },
    agentProfile: { cellId: cell, harness: { id: harness }, model },
    __passed: passed,
  } as unknown as RunRecord
}

describe('leaderboard', () => {
  const recs = [
    rec('c:cc', 'claude-code', 'opus', true, 0.4, 100, 50, 1000),
    rec('c:cc', 'claude-code', 'opus', true, 0.5, 120, 60, 1100),
    rec('c:cc', 'claude-code', 'opus', false, 0.3, 90, 40, 900),
    rec('c:oc', 'opencode', 'glm', false, 0.1, 200, 80, 1500),
    rec('c:oc', 'opencode', 'glm', true, 0.1, 180, 70, 1400),
  ]
  const lb = leaderboard(recs, { passed: (r) => (r as unknown as { __passed: boolean }).__passed })

  it('groups by agent-profile cell and ranks by pass-rate', () => {
    expect(lb).toHaveLength(2)
    expect(lb[0]!.harness).toBe('claude-code') // 2/3 > 1/2
    expect(lb[0]!.rank).toBe(1)
    expect(lb[0]!.n).toBe(3)
    expect(lb[0]!.passRate).toBeCloseTo(2 / 3, 5)
    expect(lb[1]!.harness).toBe('opencode')
    expect(lb[1]!.passRate).toBeCloseTo(0.5, 5)
  })

  it('carries a Wilson CI and the observability rollup', () => {
    const cc = lb[0]!
    expect(cc.passRateCi95[0]).toBeLessThan(cc.passRate)
    expect(cc.passRateCi95[1]).toBeGreaterThan(cc.passRate)
    expect(cc.meanCostUsd).toBeCloseTo((0.4 + 0.5 + 0.3) / 3, 5)
    expect(cc.meanTokensIn).toBeCloseTo((100 + 120 + 90) / 3, 5)
    expect(cc.meanWallMs).toBeCloseTo((1000 + 1100 + 900) / 3, 5)
    expect(cc.label).toBe('claude-code · opus')
  })

  it('honors a custom groupBy', () => {
    const byHarness = leaderboard(recs, {
      passed: (r) => (r as unknown as { __passed: boolean }).__passed,
      groupBy: (r) => r.agentProfile?.harness?.id ?? 'unknown',
    })
    expect(byHarness.map((r) => r.key).sort()).toEqual(['claude-code', 'opencode'])
  })
})
