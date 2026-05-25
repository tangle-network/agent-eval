import { describe, expect, it } from 'vitest'
import { InMemoryOutcomeStore } from '../src/meta-eval/outcome-store'
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
    const researcher = new PredictiveValidityResearcher({ outcomes, outcomeMetrics: ['revenue'] })
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
    const researcher = new PredictiveValidityResearcher({ outcomes, outcomeMetrics: ['x'] })
    const failures = [{ code: 'f', description: 'd', evidence: { runIds: ['r'], samples: 1 } }]
    const changes = await researcher.proposeChange(failures)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.kind).toBe('threshold')
    expect(changes[0]?.rationale).toMatch(/no prior report/)
  })

  it('proposes down-weight changes for decorative rubrics after a validity report', async () => {
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
      outcomeMetrics: ['revenue'],
      rubrics: ['load_bearing', 'decorative'],
    })
    const report = await researcher.runValidityCheck(runs)
    expect(report.ranked[0]?.rubric).toBe('load_bearing')
    const changes = await researcher.proposeChange([
      { code: 'f', description: 'd', evidence: { runIds: ['r-0'], samples: 1 } },
    ])
    const downweight = changes.find((c) => {
      const p = c.payload as { action?: string; rubric?: string }
      return p.action === 'down-weight'
    })
    expect(downweight).toBeDefined()
  })

  it('applyChange merges proposed changes into the plan', async () => {
    const outcomes = new InMemoryOutcomeStore()
    const researcher = new PredictiveValidityResearcher({ outcomes, outcomeMetrics: ['x'] })
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
    const researcher = new PredictiveValidityResearcher({ outcomes, outcomeMetrics: ['x'] })
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
      outcomeMetrics: ['y'],
      rubrics: ['rA'],
    })
    expect(researcher.getLastReport()).toBeNull()
    await researcher.runValidityCheck(runs)
    expect(researcher.getLastReport()).not.toBeNull()
  })
})
