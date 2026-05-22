/**
 * HeldOutGate — paired-Δ held-out promotion gate.
 *
 * The optimizer's best guess is one thing; what we should actually ship
 * is another. The gate is the line between them. A candidate promotes
 * iff:
 *   1. ≥ `minProductiveRuns` paired holdout observations.
 *   2. The bootstrap-CI lower bound on the median paired Δ exceeds the
 *      threshold (default 0 — the candidate is *significantly* better).
 *   3. The (search − holdout) overfit gap is no worse than baseline's
 *      by more than `overfitGapThreshold` (catches "wins search,
 *      regresses holdout").
 *
 * Run with:
 *   pnpm tsx examples/held-out-gate/index.ts
 */

import { HeldOutGate, type RunRecord } from '../../src/index'

function holdoutRun(
  experimentId: string,
  seed: number,
  candidateId: string,
  score: number,
): RunRecord {
  return {
    runId: `${experimentId}-${candidateId}-${seed}`,
    experimentId,
    candidateId,
    scenarioId: `${experimentId}-scenario`,
    seed,
    model: 'claude-sonnet-4-6@2025-04-15',
    promptHash: candidateId,
    configHash: 'cfg',
    commitSha: 'sha',
    wallMs: 1,
    costUsd: 0,
    tokenUsage: { input: 1, output: 1 },
    outcome: { holdoutScore: score, raw: { score } },
    splitTag: 'holdout',
  } as RunRecord
}

function searchRun(
  experimentId: string,
  seed: number,
  candidateId: string,
  score: number,
): RunRecord {
  return {
    ...holdoutRun(experimentId, seed, candidateId, score),
    splitTag: 'search',
    outcome: { searchScore: score, raw: { score } },
  }
}

const gate = new HeldOutGate({
  baselineKey: 'baseline-v1',
  minProductiveRuns: 3,
  pairedDeltaThreshold: 0,
  overfitGapThreshold: 0.15,
  bootstrapResamples: 500,
  seed: 42,
})

// ── Case 1: a real win — candidate clearly above baseline on holdout ─────
{
  const baseline = [
    holdoutRun('expA', 0, 'baseline-v1', 0.6),
    holdoutRun('expA', 1, 'baseline-v1', 0.62),
    holdoutRun('expA', 2, 'baseline-v1', 0.61),
    holdoutRun('expA', 3, 'baseline-v1', 0.59),
    searchRun('expA', 0, 'baseline-v1', 0.65),
  ]
  const candidate = [
    holdoutRun('expA', 0, 'cand-v2', 0.78),
    holdoutRun('expA', 1, 'cand-v2', 0.81),
    holdoutRun('expA', 2, 'cand-v2', 0.79),
    holdoutRun('expA', 3, 'cand-v2', 0.8),
    searchRun('expA', 0, 'cand-v2', 0.82),
  ]
  const decision = gate.evaluate(candidate, baseline)
  console.log('case 1 — clear win:')
  console.log('  promote:', decision.promote, decision.rejectionCode ?? '')
  console.log('  reason: ', decision.reason)
  console.log('  paired CI:', decision.evidence.pairedCI)
  console.log()
}

// ── Case 2: too few productive runs — rejection on coverage. ─────────────
{
  const decision = gate.evaluate(
    [holdoutRun('expB', 0, 'cand-v2', 0.9)],
    [holdoutRun('expB', 0, 'baseline-v1', 0.6)],
  )
  console.log('case 2 — too few runs:')
  console.log('  promote:', decision.promote, decision.rejectionCode)
  console.log('  reason: ', decision.reason)
  console.log()
}

// ── Case 3: classic overfit — candidate wins search big, loses holdout. ──
{
  const baseline = [
    holdoutRun('expC', 0, 'baseline-v1', 0.65),
    holdoutRun('expC', 1, 'baseline-v1', 0.66),
    holdoutRun('expC', 2, 'baseline-v1', 0.64),
    holdoutRun('expC', 3, 'baseline-v1', 0.65),
    searchRun('expC', 0, 'baseline-v1', 0.68),
  ]
  const candidate = [
    holdoutRun('expC', 0, 'cand-v2', 0.55),
    holdoutRun('expC', 1, 'cand-v2', 0.57),
    holdoutRun('expC', 2, 'cand-v2', 0.56),
    holdoutRun('expC', 3, 'cand-v2', 0.55),
    searchRun('expC', 0, 'cand-v2', 0.95), // search wildly higher
  ]
  const decision = gate.evaluate(candidate, baseline)
  console.log('case 3 — overfit (high search, low holdout):')
  console.log('  promote:', decision.promote, decision.rejectionCode ?? '')
  console.log('  reason: ', decision.reason)
  console.log('  overfitGap (candidate):', decision.evidence.overfitGap.toFixed(3))
  console.log('  overfitGap (baseline): ', decision.evidence.baselineOverfitGap.toFixed(3))
}
