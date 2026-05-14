/**
 * Worked-example regression: runs the same shape as
 * `examples/production-loop/index.ts` against the in-memory stores and
 * verifies a PR-shaped output. If the example breaks, this test fails
 * — which means CI catches example rot without spawning a tsx process.
 */
import { describe, expect, it } from 'vitest'

import type {
  AutoPrClient,
  ProposeAutomatedPullRequestInput,
  ProposeAutomatedPullRequestResult,
} from '../src/auto-pr'
import { InMemoryFeedbackTrajectoryStore } from '../src/feedback-trajectory'
import { runProductionLoop } from '../src/production-loop'
import { InMemoryTraceStore } from '../src/trace/store'
import type { Scenario } from '../src/types'

interface TaxAgentPayload {
  systemPrompt: string
}

function scenario(id: string, persona: string): Scenario {
  return {
    id,
    persona,
    label: id,
    thesis: `Filing scenario: ${id}`,
    dimensions: ['correctness'],
    turns: [{ user: 'Help me file my taxes', expectedBehaviors: ['cite a statute'] }],
    artifactChecks: [],
  }
}

describe('worked example: production-loop demo end-to-end', () => {
  it('fires the loop on a synthetic prod failure cluster and produces a PR-shaped output', async () => {
    const traceStore = new InMemoryTraceStore()
    const feedbackStore = new InMemoryFeedbackTrajectoryStore()
    // Seed 8 prod failures in the same cluster.
    for (let i = 0; i < 8; i++) {
      await traceStore.appendRun({
        runId: `prod-run-${i}`,
        scenarioId: 'ftc-noncompete-edge',
        startedAt: Date.now() - 3_600_000 + i * 10_000,
        endedAt: Date.now() - 3_600_000 + i * 10_000 + 500,
        status: 'failed',
        outcome: { pass: false, score: 0.2, failureClass: 'instruction_following' },
      })
      await feedbackStore.save({
        id: `ft-${i}`,
        scenarioId: 'ftc-noncompete-edge',
        task: { intent: 'FTC question' },
        attempts: [],
        labels: [
          {
            source: 'user',
            kind: 'reject',
            value: { thumb: 'down' },
            severity: 'error',
            createdAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
      })
    }

    const captured: ProposeAutomatedPullRequestInput[] = []
    const prClient: AutoPrClient = {
      proposeChange(input): Promise<ProposeAutomatedPullRequestResult> {
        captured.push(input)
        return Promise.resolve({
          prUrl: `https://github.com/o/r/pull/synthetic-1`,
          branchName: input.branchName,
          headSha: 'cafe1234'.padEnd(40, '0'),
          dryRun: false,
        })
      },
    }

    const baselinePrompt =
      'You are a tax assistant. Be helpful and concise. ' +
      'Answer questions about US tax forms and rules.'

    const result = await runProductionLoop<TaxAgentPayload>({
      runId: 'worked-example-prod-loop',
      target: 'tax-agent',
      traceStore,
      feedbackStore,
      cluster: { minClusterSize: 5, minSeverityRatio: 0.05, maxClustersPerCycle: 1 },
      evolve: {
        baselinePrompt: { systemPrompt: baselinePrompt },
        holdoutScenarios: [
          scenario('ftc-noncompete-edge', 'small-biz-owner'),
          scenario('schedule-c-self-employed', 'freelancer'),
          scenario('w2-multistate', 'remote-worker'),
        ],
        searchScenarios: [scenario('basic-w2', 'salaried'), scenario('joint-return', 'married')],
        runner: {
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
        },
        scorer: {
          score: ({ variant }) => {
            const lengthSignal = Math.min(1, variant.payload.systemPrompt.length / 300)
            const citationBonus = /cite/i.test(variant.payload.systemPrompt) ? 0.3 : 0
            const refuseBonus = /refuse/i.test(variant.payload.systemPrompt) ? 0.15 : 0
            const score = Math.min(1, 0.3 + lengthSignal * 0.4 + citationBonus + refuseBonus)
            return { score, ok: score >= 0.6 }
          },
        },
        mutator: {
          mutate: async ({ parent, childCount, generation }) =>
            Array.from({ length: childCount }, (_, i) => ({
              id: `${parent.id}-cite-${generation}-${i}`,
              label: 'cite-required',
              generation,
              parentId: parent.id,
              payload: {
                systemPrompt:
                  `${parent.payload.systemPrompt} ` +
                  'When the question concerns a contested rule, you MUST cite the statute by section number, ' +
                  'and you MUST refuse to answer if the rule is not in your active corpus.',
              },
            })),
        },
        gate: {
          baselineKey: 'baseline',
          minProductiveRuns: 3,
          pairedDeltaThreshold: 0,
          overfitGapThreshold: 0.5,
          seed: 1234,
        },
        reps: 2,
        generations: 2,
        populationSize: 2,
      },
      releaseThresholds: {
        requireCorpus: false,
        minPassRate: 0.5,
        minMeanScore: 0.5,
        minSearchRuns: 1,
        minHoldoutRuns: 1,
        requireAsiForFailures: false,
      },
      ship: {
        client: prClient,
        repo: { owner: 'tangle-network', name: 'tax-agent' },
        branchPrefix: 'eval/auto-improve',
        promptFilePath: 'prompts/tax-agent-system.txt',
        reviewers: ['drew'],
        labels: ['production-loop'],
      },
      cron: { cadence: 'weekly' },
    })

    expect(result.decision).toBe('pr_opened')
    expect(result.observedRunCount).toBe(8)
    expect(result.observedFeedbackCount).toBe(8)
    expect(result.actedOnCluster).not.toBeNull()
    expect(result.actedOnCluster?.runCount).toBe(8)
    expect(result.gate?.promote).toBe(true)
    expect(result.release?.status).toBe('pass')
    expect(result.pullRequest).not.toBeNull()
    expect(captured).toHaveLength(1)

    const pr = captured[0]
    expect(pr).toBeDefined()
    expect(pr?.fileChanges).toHaveLength(1)
    expect(pr?.fileChanges[0]?.path).toBe('prompts/tax-agent-system.txt')
    expect(pr?.fileChanges[0]?.contents).toContain('cite the statute')
    expect(pr?.body).toContain('Triggering failure cluster')
    expect(pr?.body).toContain('Held-out promotion gate')
    expect(pr?.body).toContain('Release confidence')
    expect(pr?.title).toContain('tax-agent: production-loop prompt update')
  })
})
