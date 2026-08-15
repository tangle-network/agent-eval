/**
 * Read a report out of runs you already captured. No agent runs here.
 *
 * Run with: pnpm tsx examples/analyze-existing-runs/index.ts
 *
 * A `RunRecord` is the analysis-time projection of one run: who ran, on what,
 * with which seed and cost, and what it scored. `analyzeRuns()` turns a list
 * of them into score distributions, paired lift, cost, and recommendations.
 */

import { analyzeRuns } from '../../src/contract'
import type { RunRecord } from '../../src/run-record'

/** One row per (candidate, case). Both arms answer the same six cases. */
function record(candidateId: string, scenarioId: string, score: number): RunRecord {
  return {
    runId: `${candidateId}-${scenarioId}`,
    experimentId: 'support-reply-v3',
    candidateId,
    seed: 42,
    model: 'openai/gpt-4.1@2025-04-14',
    promptHash: candidateId === 'baseline' ? 'a'.repeat(64) : 'b'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: 1_200,
    costUsd: 0.004,
    costProvenance: { kind: 'observed', usd: 0.004 },
    tokenUsage: { input: 820, output: 240 },
    terminalOutcome: 'succeeded',
    outcome: { holdoutScore: score, raw: { holdoutScore: score } },
    splitTag: 'holdout',
    scenarioId,
  }
}

const cases = ['refund', 'shipping', 'cancel', 'address', 'invoice', 'warranty']
const baselineScores = [0.51, 0.62, 0.48, 0.55, 0.6, 0.44]
const candidateScores = [0.68, 0.71, 0.63, 0.66, 0.7, 0.59]

const runs: RunRecord[] = [
  ...cases.map((id, i) => record('baseline', id, baselineScores[i]!)),
  ...cases.map((id, i) => record('cite-the-ticket', id, candidateScores[i]!)),
]

const report = await analyzeRuns({
  runs,
  // Naming both sides pairs the rows by (experimentId, scenarioId, seed).
  baselineCandidateId: 'baseline',
  candidateCandidateId: 'cite-the-ticket',
})

console.log('runs analyzed:  ', report.n)
console.log('mean score:     ', report.composite.mean)
console.log('paired lift:    ', report.lift?.delta)
console.log('lift interval:  ', report.lift?.ci95)
console.log('paired n:       ', report.lift?.n)
console.log('recommendations:', report.recommendations.length)
