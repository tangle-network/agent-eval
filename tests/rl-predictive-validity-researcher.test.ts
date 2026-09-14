import { describe, expect, it } from 'vitest'
import { InMemoryOutcomeStore } from '../src/meta-eval/outcome-store'
import {
  type OutcomeMetricSpec,
  rubricPredictiveValidity,
} from '../src/meta-eval/rubric-predictive-validity'
import type { ExperimentPlan } from '../src/researcher'
import { PredictiveValidityResearcher } from '../src/rl/predictive-validity-researcher'
import type { RunRecord } from '../src/run-record'

function rec(args: {
  runId: string
  candidateId: string
  scenarioId: string
  score: number
  rubrics?: Record<string, number>
}): RunRecord {
  return {
    runId: args.runId,
    experimentId: 'e',
    candidateId: args.candidateId,
    seed: 0,
    model: 'm@1',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abcd',
    wallMs: 1,
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
    outcome: { holdoutScore: args.score, raw: args.rubrics ?? {} },
    splitTag: 'holdout',
    scenarioId: args.scenarioId,
  }
}

describe('PredictiveValidityResearcher', () => {
  it('inspects failures by candidateId, packaging RunRecord ids as evidence', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'revenue', direction: 'higher-is-better' },
    })
    const runs = [
      rec({ runId: 'a-1', candidateId: 'A', scenarioId: 's', score: 0.2 }),
      rec({ runId: 'a-2', candidateId: 'A', scenarioId: 's', score: 0.3 }),
      rec({ runId: 'b-1', candidateId: 'B', scenarioId: 's', score: 0.9 }),
    ]
    const failures = await researcher.inspectFailures(runs)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.code).toBe('low-score-A')
    expect(failures[0]?.evidence.runIds).toEqual(['a-1', 'a-2'])
    expect(failures[0]?.evidence.samples).toBe(2)
  })

  it('proposes "collect-more-outcomes" until the first runValidityCheck has been done', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'x', direction: 'higher-is-better' },
    })
    const failures = [{ code: 'f', description: 'd', evidence: { runIds: ['r'], samples: 1 } }]
    const changes = await researcher.proposeChange(failures)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.kind).toBe('threshold')
    expect(changes[0]?.rationale).toMatch(/no prior report/)
  })

  it('proposes calibration evidence for weak rubrics instead of inventing a weight benefit', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs: RunRecord[] = []
    for (let i = 0; i < 12; i++) {
      runs.push(
        rec({
          runId: `r-${i}`,
          candidateId: 'A',
          scenarioId: `s-${i}`,
          score: i / 12,
          rubrics: { load_bearing: i / 12, decorative: ((i * 7) % 5) / 5 },
        }),
      )
      await outcomes.append({
        runId: `r-${i}`,
        capturedAt: Date.now(),
        metrics: { revenue: i * 10 },
      })
    }
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'revenue', direction: 'higher-is-better' },
      rubrics: ['load_bearing', 'decorative'],
    })
    const report = await researcher.runValidityCheck(runs)
    expect(report.ranked[0]?.rubric).toBe('load_bearing')
    const changes = await researcher.proposeChange([
      { code: 'f', description: 'd', evidence: { runIds: ['r-0'], samples: 1 } },
    ])
    const downweight = changes.find((c) => {
      const p = c.payload as { action?: string; rubric?: string }
      return p.action === 'collect-calibration-evidence'
    })
    expect(downweight).toBeDefined()
    expect(changes.every((change) => change.expectedDelta === undefined)).toBe(true)
  })

  it('applyChange merges proposed changes into the plan', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'x', direction: 'higher-is-better' },
    })
    const baseline: ExperimentPlan = {
      baselineCandidateId: 'A',
      proposedCandidateId: 'B',
      changes: [{ kind: 'budget', payload: { ceiling: 5 }, rationale: 'baseline budget' }],
      evaluationBudgetUsd: 10,
      splits: { search: ['s1'], holdout: ['s2'] },
    }
    const proposed = await researcher.applyChange(
      [{ kind: 'reviewer_prompt', payload: {}, rationale: 'add' }],
      baseline,
    )
    expect(proposed.changes).toHaveLength(2)
    expect(proposed.changes[0]?.kind).toBe('budget')
    expect(proposed.changes[1]?.kind).toBe('reviewer_prompt')
  })

  it('evaluateChange returns a no-op gate decision (caller drives the sweep)', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'x', direction: 'higher-is-better' },
    })
    const plan: ExperimentPlan = {
      baselineCandidateId: 'A',
      proposedCandidateId: 'B',
      changes: [],
      evaluationBudgetUsd: 0,
      splits: { search: [], holdout: [] },
    }
    const result = await researcher.evaluateChange(plan)
    expect(result.gateDecision.promote).toBe(false)
    expect(result.runs).toEqual([])
    expect(result.gateDecision.reason).toMatch(/does not execute plans/)
  })

  it('runValidityCheck caches the report so subsequent proposeChange calls have evidence', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs: RunRecord[] = Array.from({ length: 12 }, (_, i) =>
      rec({
        runId: `r-${i}`,
        candidateId: 'A',
        scenarioId: `s-${i}`,
        score: 0.5,
        rubrics: { rA: i / 12 },
      }),
    )
    for (let i = 0; i < 12; i++) {
      await outcomes.append({
        runId: `r-${i}`,
        capturedAt: Date.now(),
        metrics: { y: i },
      })
    }
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'y', direction: 'higher-is-better' },
      rubrics: ['rA'],
    })
    expect(researcher.getLastReport()).toBeNull()
    await researcher.runValidityCheck(runs)
    expect(researcher.getLastReport()).not.toBeNull()
  })

  it.each([
    { direction: 'higher-is-better', sign: -1, action: 'test-reverse-or-replace' },
    { direction: 'lower-is-better', sign: -1, action: 'test-up-weight' },
    { direction: 'higher-is-better', sign: 1, action: 'test-up-weight' },
    { direction: 'lower-is-better', sign: 1, action: 'test-reverse-or-replace' },
  ] as const)(
    'proposes $action for $direction with raw association sign $sign',
    async ({ direction, sign, action }) => {
      const outcomes = new InMemoryOutcomeStore()
      const runs = Array.from({ length: 12 }, (_, i) =>
        rec({
          runId: `r-${i}`,
          candidateId: 'A',
          scenarioId: `s-${i}`,
          score: i / 12,
          rubrics: { quality: i / 12 },
        }),
      )
      for (const [i, run] of runs.entries()) {
        await outcomes.append({ runId: run.runId, capturedAt: 1, metrics: { target: sign * i } })
      }
      const researcher = new PredictiveValidityResearcher({
        outcomes,
        targetOutcome: { id: 'target', direction },
      })
      const report = await researcher.runValidityCheck(runs)
      expect(report.pairs[0]?.spearman).toBe(sign)
      const changes = await researcher.proposeChange(await researcher.inspectFailures(runs))
      expect(changes).toHaveLength(1)
      expect(changes[0]?.payload).toMatchObject({
        action,
        targetOutcome: { id: 'target', direction },
        samples: 12,
      })
      expect(changes[0]?.expectedDelta).toBeUndefined()
      expect(changes[0]?.rationale).toMatch(/fresh evidence/)
    },
  )

  it('uses the declared target even when another outcome produces a better exploratory ranking', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs = Array.from({ length: 12 }, (_, i) =>
      rec({
        runId: `r-${i}`,
        candidateId: 'A',
        scenarioId: `s-${i}`,
        score: i / 12,
        rubrics: { quality: i },
      }),
    )
    for (const [i, run] of runs.entries()) {
      await outcomes.append({
        runId: run.runId,
        capturedAt: 1,
        metrics: { success: -i, distraction: i },
      })
    }
    const report = await rubricPredictiveValidity({
      runs,
      outcomes,
      outcomeMetrics: [
        { id: 'success', direction: 'higher-is-better' },
        { id: 'distraction', direction: 'higher-is-better' },
      ],
    })
    expect(report.ranked[0]?.bestOutcome).toBe('distraction')
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'success', direction: 'higher-is-better' },
    })
    researcher.setReport(report)
    const changes = await researcher.proposeChange(await researcher.inspectFailures(runs))
    expect(changes[0]?.payload).toMatchObject({
      action: 'test-reverse-or-replace',
      targetOutcome: { id: 'success', direction: 'higher-is-better' },
    })
  })

  it('refuses a cached report for a different target direction', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const report = await rubricPredictiveValidity({
      runs: [],
      outcomes,
      outcomeMetrics: [{ id: 'failure_rate', direction: 'higher-is-better' }],
    })
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'failure_rate', direction: 'lower-is-better' },
    })
    expect(() => researcher.setReport(report)).toThrow(/declared target outcome and direction/)
    expect(researcher.getLastReport()).toBeNull()
  })

  it('keeps the declared target and cached evidence isolated from callers, hooks, and proposal payloads', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs = Array.from({ length: 12 }, (_, i) =>
      rec({
        runId: `r-${i}`,
        candidateId: 'A',
        scenarioId: `s-${i}`,
        score: 0,
        rubrics: { quality: i },
      }),
    )
    for (const [i, run] of runs.entries()) {
      await outcomes.append({ runId: run.runId, capturedAt: 1, metrics: { success: i } })
    }
    const targetOutcome: OutcomeMetricSpec = { id: 'success', direction: 'higher-is-better' }
    const rubrics = ['quality']
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome,
      rubrics,
      onReport: (report) => {
        report.pairs.length = 0
        report.outcomeMetrics[0]!.direction = 'lower-is-better'
      },
    })
    targetOutcome.id = 'caller-mutated-target'
    rubrics[0] = 'caller-mutated-rubric'
    const report = await researcher.runValidityCheck(runs)
    report.pairs.length = 0
    researcher.getLastReport()!.pairs.length = 0
    const first = await researcher.proposeChange(await researcher.inspectFailures(runs))
    expect(first[0]?.payload).toMatchObject({
      action: 'test-up-weight',
      rubric: 'quality',
      targetOutcome: { id: 'success', direction: 'higher-is-better' },
    })
    const payload = first[0]!.payload as {
      targetOutcome: OutcomeMetricSpec
      alignedSpearmanCi95: { lower: number; upper: number }
    }
    payload.targetOutcome.id = 'payload-mutated-target'
    payload.alignedSpearmanCi95.lower = -1
    const second = await researcher.proposeChange(await researcher.inspectFailures(runs))
    expect(second[0]?.payload).toMatchObject({
      action: 'test-up-weight',
      targetOutcome: { id: 'success', direction: 'higher-is-better' },
      alignedSpearmanCi95: { lower: 1, upper: 1 },
    })
    expect(researcher.getLastReport()!.pairs).toHaveLength(1)
  })

  it('requests evidence after an unestimable report instead of treating constant data as a perfect predictor', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const runs = Array.from({ length: 12 }, (_, i) =>
      rec({
        runId: `r-${i}`,
        candidateId: 'A',
        scenarioId: `s-${i}`,
        score: 0,
        rubrics: { quality: 0 },
      }),
    )
    for (const run of runs)
      await outcomes.append({ runId: run.runId, capturedAt: 1, metrics: { success: 0 } })
    const researcher = new PredictiveValidityResearcher({
      outcomes,
      targetOutcome: { id: 'success', direction: 'higher-is-better' },
    })
    await researcher.runValidityCheck(runs)
    const changes = await researcher.proposeChange(await researcher.inspectFailures(runs))
    expect(changes).toHaveLength(1)
    expect(changes[0]?.payload).toMatchObject({ directive: 'researcher.collect-more-outcomes' })
    expect(changes[0]?.expectedDelta).toBeUndefined()
  })
})
