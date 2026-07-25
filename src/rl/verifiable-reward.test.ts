import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../run-record'
import {
  extractVerifiableRewardsFromRecords,
  filterDeterministicallyRewarded,
} from './verifiable-reward'

// The deterministic layer is the highest-credibility channel this module emits
// (`determinism: 'deterministic'`, `confidence: 1`) and the module header calls
// it "the RL training signal". It used to be the ONLY branch with no realness
// gate — the judge fallback gated and the deterministic path did not — which is
// backwards: `realness.gated` means the run's success signal was faked, and a
// test suite reporting green on a stubbed integration is exactly the deterministic
// layer being the thing that got faked.

function rec(args: {
  runId: string
  score: number
  layers?: Record<string, number>
  gated?: boolean
}): RunRecord {
  return {
    runId: args.runId,
    experimentId: 'exp',
    candidateId: 'cand',
    seed: 0,
    model: 'm@1',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abcd',
    wallMs: 1,
    costUsd: 0,
    costProvenance: { kind: 'observed', usd: 0 },
    tokenUsage: { input: 0, output: 0 },
    terminalOutcome: 'succeeded',
    splitTag: 'holdout',
    scenarioId: 'scenario-1',
    outcome: {
      holdoutScore: args.score,
      raw: Object.fromEntries(
        Object.entries(args.layers ?? {}).map(([name, v]) => [`layer.${name}`, v]),
      ),
      ...(args.gated === true
        ? { realness: { score: 0, gated: true, reason: 'stubbed the integration' } }
        : {}),
    },
  }
}

describe('extractVerifiableRewardsFromRecords — the realness gate on the deterministic channel', () => {
  it('zeroes a single deterministic layer on a gated run and says why', () => {
    const [signal] = extractVerifiableRewardsFromRecords([
      rec({ runId: 'gamed', score: 1, layers: { test: 1 }, gated: true }),
    ])
    expect(signal?.reward?.value).toBe(0)
    expect(signal?.reward?.determinism).toBe('deterministic')
    expect(signal?.reward?.realnessGated).toBe(true)
    // `components` is the per-source surface an RL consumer re-weights from.
    // Leaving the raw 1.0 there would let that re-weighting reconstruct the
    // exact reward the gate just refused.
    expect(signal?.reward?.components).toEqual({ test: 0 })
  })

  it('zeroes every component of a composite deterministic reward on a gated run', () => {
    const [signal] = extractVerifiableRewardsFromRecords([
      rec({ runId: 'gamed', score: 1, layers: { test: 1, typecheck: 1 }, gated: true }),
    ])
    expect(signal?.reward?.value).toBe(0)
    expect(signal?.reward?.source).toBe('composite')
    expect(signal?.reward?.components).toEqual({ test: 0, typecheck: 0 })
    expect(signal?.reward?.breakdown).toEqual({ test: 0, typecheck: 0 })
    expect(signal?.reward?.realnessGated).toBe(true)
  })

  it('leaves an ungated deterministic layer untouched', () => {
    const [signal] = extractVerifiableRewardsFromRecords([
      rec({ runId: 'honest', score: 0.9, layers: { test: 1 } }),
    ])
    expect(signal?.reward?.value).toBe(1)
    expect(signal?.reward?.components).toEqual({ test: 1 })
    expect(signal?.reward?.realnessGated).toBe(false)
  })

  it('gates the probabilistic judge fallback too', () => {
    const [signal] = extractVerifiableRewardsFromRecords([
      rec({ runId: 'gamed', score: 1, gated: true }),
    ])
    expect(signal?.reward?.determinism).toBe('probabilistic')
    expect(signal?.reward?.value).toBe(0)
    expect(signal?.reward?.realnessGated).toBe(true)
  })

  it('keeps a gated run in the deterministic training set at 0, flagged, never dropped', () => {
    const kept = filterDeterministicallyRewarded([
      rec({ runId: 'honest', score: 0.9, layers: { test: 1 } }),
      rec({ runId: 'gamed', score: 1, layers: { test: 1 }, gated: true }),
    ])
    expect(kept.map((k) => k.run.runId)).toEqual(['honest', 'gamed'])
    expect(kept.map((k) => k.reward.value)).toEqual([1, 0])
    expect(kept[1]?.reward.realnessGated).toBe(true)
  })
})

describe('applyRealnessGate: false — the detection opt-out', () => {
  // `rl/reward-hacking.ts` measures the GAP between the judge reward and the
  // deterministic one. A deterministic reward another gate already forced to 0
  // opens that gap by construction on exactly the gamed population, so the
  // detector would fire on its own input instead of on evidence it found.
  it('returns the observed deterministic number, with the flag still set', () => {
    const [signal] = extractVerifiableRewardsFromRecords(
      [rec({ runId: 'gamed', score: 1, layers: { test: 1 }, gated: true })],
      { applyRealnessGate: false },
    )
    expect(signal?.reward?.value).toBe(1)
    expect(signal?.reward?.components).toEqual({ test: 1 })
    expect(signal?.reward?.realnessGated).toBe(true)
  })

  it('returns the observed judge number on the fallback branch', () => {
    const [signal] = extractVerifiableRewardsFromRecords(
      [rec({ runId: 'gamed', score: 1, gated: true })],
      { applyRealnessGate: false },
    )
    expect(signal?.reward?.value).toBe(1)
    expect(signal?.reward?.realnessGated).toBe(true)
  })

  it('is opt-in — the default and an empty options object both gate', () => {
    const run = rec({ runId: 'gamed', score: 1, layers: { test: 1 }, gated: true })
    expect(extractVerifiableRewardsFromRecords([run])[0]?.reward?.value).toBe(0)
    expect(extractVerifiableRewardsFromRecords([run], {})[0]?.reward?.value).toBe(0)
  })
})
