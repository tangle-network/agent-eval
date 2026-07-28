/**
 * Shared fixture builder for the round-3 ground-truth probes.
 *
 * `build(before, after)` makes one paired RunRecord set whose SEARCH scores
 * mirror its HOLDOUT scores, so the overfit-gap check is 0 on both arms and the
 * paired-delta rule is the only thing under test.
 */
import type { RunRecord } from '../src/run-record'

export function rec(
  candidateId: string,
  scenarioId: string,
  split: 'search' | 'holdout',
  score: number,
): RunRecord {
  return {
    runId: `${candidateId}:${scenarioId}:${split}`,
    experimentId: 'exp',
    candidateId,
    seed: 7,
    model: 'fixture@2026-01-01',
    promptHash: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
    commitSha: 'c'.repeat(40),
    wallMs: 1000,
    costUsd: 0.01,
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 10, output: 10 },
    terminalOutcome: 'succeeded',
    outcome: split === 'search' ? { searchScore: score, raw: {} } : { holdoutScore: score, raw: {} },
    splitTag: split,
    scenarioId,
  } as RunRecord
}

export function build(before: number[], after: number[]) {
  const candidate: RunRecord[] = []
  const baseline: RunRecord[] = []
  for (let i = 0; i < before.length; i++) {
    const sid = `s${i}`
    candidate.push(rec('cand', sid, 'search', after[i]!), rec('cand', sid, 'holdout', after[i]!))
    baseline.push(rec('base', sid, 'search', before[i]!), rec('base', sid, 'holdout', before[i]!))
  }
  return { candidate, baseline }
}

// biome-ignore lint/suspicious/noExplicitAny: probes compare gate classes across versions
export function run(Gate: any, before: number[], after: number[], thr: number, conf = 0.95) {
  const { candidate, baseline } = build(before, after)
  const g = new Gate({
    baselineKey: 'base',
    pairedDeltaThreshold: thr,
    confidence: conf,
    seed: 1234,
    overfitGapThreshold: 1e9,
  })
  return g.evaluate(candidate, baseline)
}

export const f = (x: number | null | undefined) => (x == null ? '    null' : x.toFixed(4).padStart(8))
