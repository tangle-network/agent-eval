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

import { strict as assert } from 'node:assert'
import { HeldOutGate, type RunRecord } from '../../src/index'

function value(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3)
}

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
    model: 'deepseek-v4-flash@2026-07-01',
    promptHash: candidateId,
    configHash: 'cfg',
    commitSha: 'sha',
    wallMs: 1,
    costUsd: 0,
    costProvenance: { kind: 'observed', usd: 0 },
    tokenUsage: { input: 1, output: 1 },
    terminalOutcome: 'succeeded',
    outcome: { holdoutScore: score, raw: { score } },
    splitTag: 'holdout',
  }
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

function holdoutRuns(experimentId: string, candidateId: string, scores: number[]): RunRecord[] {
  return scores.map((score, seed) => holdoutRun(experimentId, seed, candidateId, score))
}

const gate = new HeldOutGate({
  baselineKey: 'baseline-v1',
  minProductiveRuns: 20,
  pairedDeltaThreshold: 0,
  overfitGapThreshold: 0.15,
  bootstrapResamples: 500,
  seed: 42,
})

// ── Case 1: a real win — candidate clearly above baseline on holdout ─────
{
  const baselineScores = Array.from({ length: 20 }, (_, seed) => 0.58 + (seed % 8) * 0.01)
  const candidateScores = baselineScores.map((score, seed) => score + 0.15 + (seed % 3) * 0.01)
  const baseline = [
    ...holdoutRuns('expA', 'baseline-v1', baselineScores),
    searchRun('expA', 0, 'baseline-v1', 0.65),
  ]
  const candidate = [
    ...holdoutRuns('expA', 'cand-v2', candidateScores),
    searchRun('expA', 0, 'cand-v2', 0.82),
  ]
  const decision = gate.evaluate(candidate, baseline)
  assert.equal(decision.promote, true, `clear win should promote: ${decision.reason}`)
  console.log('case 1 — clear win:')
  console.log('  promote:', decision.promote, decision.rejectionCode ?? '')
  console.log('  reason: ', decision.reason)
  console.log('  paired CI:', decision.evidence.pairedCI)
  console.log()
}

// ── Case 2: too few productive runs — rejection on coverage. ─────────────
{
  const decision = gate.evaluate(
    [holdoutRun('expB', 0, 'cand-v2', 0.9), searchRun('expB', 0, 'cand-v2', 0.92)],
    [holdoutRun('expB', 0, 'baseline-v1', 0.6), searchRun('expB', 0, 'baseline-v1', 0.65)],
  )
  assert.equal(decision.rejectionCode, 'few_runs')
  console.log('case 2 — too few runs:')
  console.log('  promote:', decision.promote, decision.rejectionCode)
  console.log('  reason: ', decision.reason)
  console.log()
}

// ── Case 3: search gain dwarfs the real holdout gain. ────────────────
{
  const baselineScores = Array.from({ length: 20 }, (_, seed) => 0.63 + (seed % 5) * 0.01)
  const candidateScores = baselineScores.map((score, seed) => score + 0.04 + (seed % 3) * 0.01)
  const baseline = [
    ...holdoutRuns('expC', 'baseline-v1', baselineScores),
    searchRun('expC', 0, 'baseline-v1', 0.68),
  ]
  const candidate = [
    ...holdoutRuns('expC', 'cand-v2', candidateScores),
    searchRun('expC', 0, 'cand-v2', 0.95), // search wildly higher
  ]
  const decision = gate.evaluate(candidate, baseline)
  assert.equal(decision.rejectionCode, 'overfit_gap')
  console.log('case 3 — overfit (search gain exceeds holdout gain):')
  console.log('  promote:', decision.promote, decision.rejectionCode ?? '')
  console.log('  reason: ', decision.reason)
  console.log('  overfitGap (candidate):', value(decision.evidence.overfitGap))
  console.log('  overfitGap (baseline): ', value(decision.evidence.baselineOverfitGap))
}
