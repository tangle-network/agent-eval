import { describe, expect, it } from 'vitest'
import {
  type HarnessAdapter,
  type HarnessRunRequest,
  runHarnessExperiment,
  selectHarnessVariant,
  summarizeHarnessResults,
} from '../src/harness-optimizer'
import type { RunTrace } from '../src/run-critic'
import type { RunScore } from '../src/run-score'

describe('harness optimizer', () => {
  it('runs the full variant x scenario x trial matrix and promotes the best topology', async () => {
    const seen: string[] = []
    const adapter: HarnessAdapter = {
      async run(request) {
        seen.push(`${request.variant.id}:${request.scenario.id}:${request.trialIndex}`)
        return traceFor(request)
      },
    }

    const result = await runHarnessExperiment({
      adapter,
      variants: [
        { id: 'linear', topology: { id: 'linear', interventions: ['continue', 'verify'] } },
        {
          id: 'adaptive',
          topology: { id: 'adaptive', interventions: ['audit', 'repair', 'final_gate'] },
        },
      ],
      scenarios: [
        { id: 'privacy', task: 'remove local PII' },
        { id: 'site-rip', task: 'extract component library' },
      ],
      trialsPerScenario: 2,
      parallelism: 3,
    })

    expect(seen).toHaveLength(8)
    expect(result.results).toHaveLength(8)
    expect(result.selection.winner.variant.id).toBe('adaptive')
    expect(result.selection.reports[0]?.variant.id).toBe('adaptive')
  })

  it('keeps cost/latency tradeoffs on the Pareto frontier while choosing highest aggregate', () => {
    const reports = summarizeHarnessResults([
      run('accurate', 0.95, 0.8, 0.4, 120),
      run('cheap', 0.7, 0.7, 0.01, 10),
      run('weak', 0.2, 0.2, 1, 300),
    ])

    const selection = selectHarnessVariant(reports.flatMap((r) => r.runs))
    expect(selection.winner.variant.id).toBe('accurate')
    expect(selection.frontier.frontier.map((r) => r.variant.id).sort()).toEqual([
      'accurate',
      'cheap',
    ])
    expect(selection.frontier.dominated.map((r) => r.variant.id)).toEqual(['weak'])
  })
})

function traceFor(request: HarnessRunRequest): RunTrace {
  const strong = request.variant.id === 'adaptive'
  return {
    run: {
      runId: `${request.variant.id}-${request.scenario.id}-${request.trialIndex}`,
      scenarioId: request.scenario.id,
      variantId: request.variant.id,
      startedAt: 1_000,
      endedAt: 2_000,
      status: 'completed',
      outcome: { pass: strong, score: strong ? 0.95 : 0.55 },
    },
    spans: [
      {
        runId: 'r',
        spanId: 'tool',
        kind: 'tool',
        name: 'apply_patch',
        toolName: 'apply_patch',
        args: {},
        startedAt: 1,
        status: 'ok',
      },
      {
        runId: 'r',
        spanId: 'test',
        kind: 'sandbox',
        name: 'pnpm test',
        command: 'pnpm test',
        testsTotal: 10,
        testsPassed: strong ? 10 : 6,
        startedAt: 2,
      },
    ],
    events: [],
    artifacts: [
      { artifactId: 'patch', runId: 'r', contentType: 'text/x-diff', sizeBytes: 10, hash: 'abc' },
    ],
    budget: [
      {
        runId: 'r',
        dimension: 'usd',
        limit: 1,
        consumed: strong ? 0.2 : 0.1,
        remaining: 0.8,
        timestamp: 3,
        breached: false,
      },
    ],
  }
}

function run(id: string, success: number, progress: number, costUsd: number, wallSeconds: number) {
  const score: RunScore = {
    success,
    goalProgress: progress,
    repoGroundedness: progress,
    driftPenalty: 1 - progress,
    toolUseQuality: progress,
    patchQuality: progress,
    testReality: success,
    finalGate: success,
    reviewerBlockers: success > 0.5 ? 0 : 1,
    costUsd,
    wallSeconds,
  }
  return {
    variant: { id },
    scenario: { id: 's', task: 'task' },
    trialIndex: 0,
    trace: {
      run: {
        runId: id,
        scenarioId: 's',
        startedAt: 0,
        status: 'completed',
        outcome: { pass: success > 0.5, score: progress },
      },
      spans: [],
      events: [],
      artifacts: [],
      budget: [],
    },
    score,
    aggregate: success * 4 + progress,
  }
}
