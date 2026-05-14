/**
 * Production-loop tests.
 *
 * Regression coverage:
 *   - cluster → evolve → propose-PR is deterministic with a fake-fetch
 *     + fake-gh-api client
 *   - the loop short-circuits to `no_actionable_failures` when no
 *     cluster crosses the severity threshold
 *   - the loop short-circuits to `gate_failed` when the held-out gate
 *     rejects (fail-closed: a passing evolve does not auto-ship)
 *   - the loop returns `proposed_change` when no `ship` is wired
 *     (consumers may persist artifacts without opening a PR)
 *   - PR body renders cluster details + gate evidence (regression: a
 *     PR with no context is unreviewable)
 *   - `AutoPrClient.proposeChange` is called exactly once on success
 *
 * No network. No `gh` shell-out. Fake clients verify the contract.
 */
import { describe, expect, it } from 'vitest'

import type {
  AutoPrClient,
  ProposeAutomatedPullRequestInput,
  ProposeAutomatedPullRequestResult,
} from '../src/auto-pr'
import { InMemoryFeedbackTrajectoryStore } from '../src/feedback-trajectory'
import type {
  MultiShotMutateAdapter,
  MultiShotRunner,
  MultiShotScorer,
} from '../src/multi-shot-optimization'
import { runProductionLoop } from '../src/production-loop'
import { InMemoryTraceStore } from '../src/trace/store'
import type { Scenario } from '../src/types'

interface Payload {
  systemPrompt: string
}

function scenario(id: string): Scenario {
  return {
    id,
    persona: 'tax-filer',
    label: id,
    thesis: `Scenario ${id}`,
    dimensions: ['correctness'],
    turns: [{ user: 'Help me file my taxes', expectedBehaviors: ['gather state'] }],
    artifactChecks: [],
  }
}

/**
 * Deterministic runner: scoring is a pure function of (systemPrompt
 * length × scenarioId). A longer prompt wins, modeling the intuition
 * that the evolve step is exploring richer prompts.
 */
function makeRunner(): MultiShotRunner<Payload> {
  return {
    run: ({ variant, scenarioId }) => ({
      trace: {
        scenarioId,
        turns: [
          { role: 'user', content: 'help' },
          { role: 'assistant', content: variant.payload.systemPrompt },
        ],
        transcript: variant.payload.systemPrompt,
      },
      costUsd: 0.01,
      durationMs: 5,
    }),
  }
}

function makeScorer(): MultiShotScorer<Payload> {
  return {
    score: ({ variant }) => {
      const score = Math.min(1, variant.payload.systemPrompt.length / 200)
      return { score, ok: score >= 0.6 }
    },
  }
}

function makeImprovementMutator(): MultiShotMutateAdapter<Payload> {
  return {
    mutate: async ({ parent, childCount, generation }) => {
      const longer = `${parent.payload.systemPrompt} `
        + 'Always cite the source statute by section number. '
        + 'Refuse to answer if the FTC rule cited is not in the active corpus. '
      return Array.from({ length: childCount }, (_, i) => ({
        id: `${parent.id}-improved-${generation}-${i}`,
        label: 'improved',
        generation,
        parentId: parent.id,
        payload: { systemPrompt: longer },
      }))
    },
  }
}

function makeIdentityMutator(): MultiShotMutateAdapter<Payload> {
  return {
    mutate: async () => [],
  }
}

function makeFailedRun(traceStore: InMemoryTraceStore, runId: string, scenarioId: string): void {
  traceStore.appendRun({
    runId,
    scenarioId,
    startedAt: Date.now(),
    endedAt: Date.now() + 1,
    status: 'failed',
    outcome: { pass: false, score: 0.1, failureClass: 'reasoning_error' },
  })
}

function fakeAutoPrClient(): { client: AutoPrClient; calls: ProposeAutomatedPullRequestInput[] } {
  const calls: ProposeAutomatedPullRequestInput[] = []
  const client: AutoPrClient = {
    proposeChange(input): Promise<ProposeAutomatedPullRequestResult> {
      calls.push(input)
      return Promise.resolve({
        prUrl: `https://github.com/${input.repo.owner}/${input.repo.name}/pull/42`,
        branchName: input.branchName,
        headSha: 'cafe1234'.padEnd(40, '0'),
        dryRun: false,
      })
    },
  }
  return { client, calls }
}

describe('runProductionLoop', () => {
  it('returns no_actionable_failures when the failure cluster is below the severity threshold', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    // 1 failure out of 1 run, but minClusterSize=5 forces no action.
    makeFailedRun(traceStore, 'r-1', 'noisy')

    const result = await runProductionLoop<Payload>({
      runId: 'prod-loop-quiet',
      target: 'tax-agent',
      traceStore,
      feedbackStore,
      cluster: { minClusterSize: 5, minSeverityRatio: 0.5 },
      evolve: {
        runner: makeRunner(),
        scorer: makeScorer(),
        mutator: makeImprovementMutator(),
        baselinePrompt: { systemPrompt: 'You are a tax assistant.' },
        holdoutScenarios: [scenario('hold-a'), scenario('hold-b')],
        gate: { baselineKey: 'baseline', minProductiveRuns: 1, pairedDeltaThreshold: 0 },
      },
    })

    expect(result.decision).toBe('no_actionable_failures')
    expect(result.evolution).toBeNull()
    expect(result.pullRequest).toBeNull()
    expect(result.promotedPrompt).toEqual({ systemPrompt: 'You are a tax assistant.' })
    expect(result.observedRunCount).toBe(1)
  })

  it('runs evolve and returns proposed_change when ship is not wired', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    // 5 failed runs in the same cluster — crosses minClusterSize=5.
    for (let i = 0; i < 5; i++) makeFailedRun(traceStore, `r-${i}`, 'tax-edge')

    const result = await runProductionLoop<Payload>({
      runId: 'prod-loop-evolve',
      target: 'tax-agent',
      traceStore,
      feedbackStore,
      cluster: { minClusterSize: 5, minSeverityRatio: 0 },
      evolve: {
        runner: makeRunner(),
        scorer: makeScorer(),
        mutator: makeImprovementMutator(),
        baselinePrompt: { systemPrompt: 'Short.' },
        holdoutScenarios: [scenario('hold-a'), scenario('hold-b'), scenario('hold-c')],
        searchScenarios: [scenario('search-a'), scenario('search-b')],
        gate: {
          baselineKey: 'baseline',
          minProductiveRuns: 1,
          pairedDeltaThreshold: -1,
          overfitGapThreshold: 1,
          seed: 7,
        },
        reps: 1,
        generations: 2,
        populationSize: 2,
      },
      releaseThresholds: {
        minPassRate: 0.0,
        minMeanScore: 0.0,
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        maxOverfitGap: 1,
        requireAsiForFailures: false,
        requireCorpus: false,
      },
    })

    expect(result.decision).toBe('proposed_change')
    expect(result.evolution).not.toBeNull()
    expect(result.actedOnCluster).not.toBeNull()
    expect(result.pullRequest).toBeNull()
    // The mutator extends the prompt — promoted must differ from baseline.
    expect((result.promotedPrompt as Payload).systemPrompt).not.toBe('Short.')
    expect((result.promotedPrompt as Payload).systemPrompt.length).toBeGreaterThan(
      (result.baselinePrompt as Payload).systemPrompt.length,
    )
  })

  it('opens a PR when ship is wired, gate passes, and release is green', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    for (let i = 0; i < 5; i++) makeFailedRun(traceStore, `r-${i}`, 'tax-edge')
    const { client, calls } = fakeAutoPrClient()

    const result = await runProductionLoop<Payload>({
      runId: 'prod-loop-ship',
      target: 'tax-agent',
      traceStore,
      feedbackStore,
      cluster: { minClusterSize: 5, minSeverityRatio: 0 },
      evolve: {
        runner: makeRunner(),
        scorer: makeScorer(),
        mutator: makeImprovementMutator(),
        baselinePrompt: { systemPrompt: 'Short.' },
        holdoutScenarios: [scenario('hold-a'), scenario('hold-b'), scenario('hold-c')],
        searchScenarios: [scenario('search-a'), scenario('search-b')],
        gate: {
          baselineKey: 'baseline',
          minProductiveRuns: 1,
          pairedDeltaThreshold: -1,
          overfitGapThreshold: 1,
          seed: 7,
        },
        reps: 1,
        generations: 2,
        populationSize: 2,
      },
      releaseThresholds: {
        minPassRate: 0.0,
        minMeanScore: 0.0,
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        maxOverfitGap: 1,
        requireAsiForFailures: false,
        requireCorpus: false,
      },
      ship: {
        client,
        repo: { owner: 'tangle-network', name: 'tax-agent' },
        branchPrefix: 'eval/auto-improve',
        promptFilePath: 'prompts/system.txt',
        reviewers: ['drew'],
        labels: ['production-loop'],
      },
      cron: { cadence: 'weekly' },
    })

    expect(result.decision).toBe('pr_opened')
    expect(result.pullRequest).not.toBeNull()
    expect(result.pullRequest?.prUrl).toContain('/pull/42')
    expect(result.pullRequest?.branchName).toBe('eval/auto-improve/prod-loop-ship')
    // The PR must carry the prompt file diff + cluster context.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.fileChanges).toHaveLength(1)
    expect(calls[0]?.fileChanges[0]?.path).toBe('prompts/system.txt')
    expect(calls[0]?.body).toContain('Held-out promotion gate')
    expect(calls[0]?.body).toContain('Release confidence')
    expect(calls[0]?.body).toContain('Triggering failure cluster')
    expect(calls[0]?.reviewers).toEqual(['drew'])
    expect(calls[0]?.labels).toEqual(['production-loop'])
    expect(result.cron?.cadence).toBe('weekly')
  })

  it('fails closed: when the held-out gate rejects, no PR is opened', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    for (let i = 0; i < 5; i++) makeFailedRun(traceStore, `r-${i}`, 'tax-edge')
    const { client, calls } = fakeAutoPrClient()

    // Mutator returns variants that SCORE WORSE — the gate will reject.
    const worseMutator: MultiShotMutateAdapter<Payload> = {
      mutate: async ({ parent, childCount, generation }) =>
        Array.from({ length: childCount }, (_, i) => ({
          id: `${parent.id}-worse-${generation}-${i}`,
          label: 'worse',
          generation,
          parentId: parent.id,
          payload: { systemPrompt: '' },
        })),
    }

    const result = await runProductionLoop<Payload>({
      runId: 'prod-loop-reject',
      target: 'tax-agent',
      traceStore,
      feedbackStore,
      cluster: { minClusterSize: 5, minSeverityRatio: 0 },
      evolve: {
        runner: makeRunner(),
        scorer: makeScorer(),
        mutator: worseMutator,
        baselinePrompt: {
          systemPrompt:
            'You are a tax assistant. Cite sources. Refuse unsupported claims. Walk through state-by-state.',
        },
        holdoutScenarios: [scenario('hold-a'), scenario('hold-b'), scenario('hold-c')],
        searchScenarios: [scenario('search-a'), scenario('search-b')],
        gate: {
          baselineKey: 'baseline',
          minProductiveRuns: 1,
          pairedDeltaThreshold: 0,
          overfitGapThreshold: 1,
          seed: 7,
        },
        reps: 1,
        generations: 2,
        populationSize: 2,
      },
      releaseThresholds: {
        minPassRate: 0.0,
        minMeanScore: 0.0,
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        maxOverfitGap: 1,
        requireAsiForFailures: false,
        requireCorpus: false,
      },
      ship: {
        client,
        repo: { owner: 'tangle-network', name: 'tax-agent' },
        branchPrefix: 'eval/auto-improve',
        promptFilePath: 'prompts/system.txt',
      },
    })

    // Either evolve_yielded_no_improvement (when search-best stays baseline)
    // or gate_failed (when search-best wins search but holdout fails). Both
    // mean: no PR opened. That's the load-bearing assertion.
    expect(['gate_failed', 'evolve_yielded_no_improvement']).toContain(result.decision)
    expect(result.pullRequest).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('returns evolve_yielded_no_improvement when the mutator returns no children', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    for (let i = 0; i < 5; i++) makeFailedRun(traceStore, `r-${i}`, 'tax-edge')

    const result = await runProductionLoop<Payload>({
      runId: 'prod-loop-noop',
      target: 'tax-agent',
      traceStore,
      feedbackStore,
      cluster: { minClusterSize: 5, minSeverityRatio: 0 },
      evolve: {
        runner: makeRunner(),
        scorer: makeScorer(),
        mutator: makeIdentityMutator(),
        baselinePrompt: { systemPrompt: 'baseline-only.' },
        holdoutScenarios: [scenario('hold-a'), scenario('hold-b'), scenario('hold-c')],
        searchScenarios: [scenario('search-a'), scenario('search-b')],
        gate: { baselineKey: 'baseline', minProductiveRuns: 1, pairedDeltaThreshold: 0, seed: 7 },
        reps: 1,
        generations: 1,
        populationSize: 1,
      },
      releaseThresholds: { requireCorpus: false, requireAsiForFailures: false },
    })

    expect(result.decision).toBe('evolve_yielded_no_improvement')
    expect(result.pullRequest).toBeNull()
  })

  it('validates inputs (regression: empty runId, empty holdout, conflicting search/holdout)', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()

    await expect(
      runProductionLoop<Payload>({
        runId: '   ',
        target: 'tax-agent',
        traceStore,
        feedbackStore,
        cluster: {},
        evolve: {
          runner: makeRunner(),
          scorer: makeScorer(),
          mutator: makeImprovementMutator(),
          baselinePrompt: { systemPrompt: 'x' },
          holdoutScenarios: [scenario('h-a')],
          gate: { baselineKey: 'baseline' },
        },
      }),
    ).rejects.toThrow(/runId required/)

    await expect(
      runProductionLoop<Payload>({
        runId: 'r',
        target: '   ',
        traceStore,
        feedbackStore,
        cluster: {},
        evolve: {
          runner: makeRunner(),
          scorer: makeScorer(),
          mutator: makeImprovementMutator(),
          baselinePrompt: { systemPrompt: 'x' },
          holdoutScenarios: [scenario('h-a')],
          gate: { baselineKey: 'baseline' },
        },
      }),
    ).rejects.toThrow(/target required/)

    await expect(
      runProductionLoop<Payload>({
        runId: 'r',
        target: 'tax-agent',
        traceStore,
        feedbackStore,
        cluster: {},
        evolve: {
          runner: makeRunner(),
          scorer: makeScorer(),
          mutator: makeImprovementMutator(),
          baselinePrompt: { systemPrompt: 'x' },
          holdoutScenarios: [],
          gate: { baselineKey: 'baseline' },
        },
      }),
    ).rejects.toThrow(/holdoutScenarios must not be empty/)

    // Search/holdout overlap.
    for (let i = 0; i < 5; i++) makeFailedRun(traceStore, `r-${i}`, 'tax-edge')
    await expect(
      runProductionLoop<Payload>({
        runId: 'r',
        target: 'tax-agent',
        traceStore,
        feedbackStore,
        cluster: { minClusterSize: 5, minSeverityRatio: 0 },
        evolve: {
          runner: makeRunner(),
          scorer: makeScorer(),
          mutator: makeImprovementMutator(),
          baselinePrompt: { systemPrompt: 'x' },
          holdoutScenarios: [scenario('a')],
          searchScenarios: [scenario('a')],
          gate: { baselineKey: 'baseline' },
        },
      }),
    ).rejects.toThrow(/disjoint/)
  })
})
