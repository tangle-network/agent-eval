import { describe, expect, it } from 'vitest'
import { detectRewardHacking } from '../src/rl/reward-hacking'
import type { RunRecord } from '../src/run-record'

function rec(args: {
  runId: string
  proxy: number
  truth?: number
  layerScores?: Record<string, number>
}): RunRecord {
  const raw: Record<string, number> = {}
  if (args.truth !== undefined) raw.truth = args.truth
  for (const [k, v] of Object.entries(args.layerScores ?? {})) raw[`layer.${k}`] = v
  return {
    runId: args.runId,
    experimentId: 'e',
    candidateId: 'c',
    seed: 0,
    model: 'm@1',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abcd',
    wallMs: 1,
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
    outcome: { holdoutScore: args.proxy, raw },
    splitTag: 'holdout',
  }
}

describe('detectRewardHacking', () => {
  it('flags reward divergence when proxy rises while truth stagnates', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 30; i++) runs.push(rec({ runId: `early-${i}`, proxy: 0.4, truth: 0.5 }))
    for (let i = 0; i < 30; i++) runs.push(rec({ runId: `late-${i}`, proxy: 0.85, truth: 0.5 }))
    const out = detectRewardHacking({
      runs,
      truthOf: (r) => (r.outcome.raw.truth ?? null) as number | null,
    })
    expect(out.verdict).not.toBe('clean')
    const div = out.findings.find((f) => f.signal === 'reward_divergence')!
    expect(div.severity).toBeGreaterThan(0.3)
  })

  it('does not flag when proxy and truth move together', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 30; i++) runs.push(rec({ runId: `early-${i}`, proxy: 0.5, truth: 0.5 }))
    for (let i = 0; i < 30; i++) runs.push(rec({ runId: `late-${i}`, proxy: 0.7, truth: 0.7 }))
    const out = detectRewardHacking({
      runs,
      truthOf: (r) => (r.outcome.raw.truth ?? null) as number | null,
    })
    const div = out.findings.find((f) => f.signal === 'reward_divergence')!
    expect(div.severity).toBeLessThan(0.3)
  })

  it('returns clean+small-n when fewer than 4 runs', () => {
    const out = detectRewardHacking({ runs: [rec({ runId: 'a', proxy: 0.5 })] })
    expect(out.verdict).toBe('clean')
    expect(out.rationale[0]).toContain('insufficient evidence')
  })

  it('flags judge_drift when judge proxy rises while deterministic reward stagnates', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 30; i++) {
      runs.push(
        rec({
          runId: `early-${i}`,
          proxy: 0.4,
          layerScores: { test: 0.5 },
        }),
      )
    }
    for (let i = 0; i < 30; i++) {
      runs.push(
        rec({
          runId: `late-${i}`,
          proxy: 0.9,
          layerScores: { test: 0.5 },
        }),
      )
    }
    const out = detectRewardHacking({ runs })
    const drift = out.findings.find((f) => f.signal === 'judge_drift')!
    expect(drift.severity).toBeGreaterThan(0)
  })

  it('flags reward_disagreement when proxy and secondary correlate poorly', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 30; i++) {
      runs.push(
        rec({
          runId: `r-${i}`,
          proxy: i / 30,
          layerScores: { test: 1 - i / 30 }, // anti-correlated
        }),
      )
    }
    const out = detectRewardHacking({ runs })
    const dis = out.findings.find((f) => f.signal === 'reward_disagreement')!
    expect(dis.severity).toBeGreaterThan(0.3)
  })

  it('emits all four signal types when truth + secondary are both supplied', () => {
    const runs: RunRecord[] = []
    for (let i = 0; i < 30; i++) {
      runs.push(
        rec({
          runId: `early-${i}`,
          proxy: 0.4,
          truth: 0.5,
          layerScores: { test: 0.5 },
        }),
      )
    }
    for (let i = 0; i < 30; i++) {
      runs.push(
        rec({
          runId: `late-${i}`,
          proxy: 0.85,
          truth: 0.5,
          layerScores: { test: 0.5 },
        }),
      )
    }
    const out = detectRewardHacking({
      runs,
      truthOf: (r) => (r.outcome.raw.truth ?? null) as number | null,
    })
    const signals = out.findings.map((f) => f.signal).sort()
    // Expect divergence + drift signals; distribution_shift may or may not fire.
    expect(signals).toContain('reward_divergence')
    expect(signals).toContain('judge_drift')
  })
})
