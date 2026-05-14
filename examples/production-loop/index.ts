/**
 * Production loop — runnable end-to-end demo.
 *
 * What this shows:
 *   - Feed 8 synthetic production failures into a TraceStore + matching
 *     user-feedback labels into a FeedbackTrajectoryStore.
 *   - Configure a `runProductionLoop` cycle:
 *       cluster threshold = 5 runs / 5% severity,
 *       evolve = 2 generations × 2 reps over 3 holdout scenarios,
 *       gate = paired-Δ > 0 over 3 productive runs,
 *       ship = a fake `AutoPrClient` that captures the PR plan.
 *   - Print the loop's decision, the gate evidence, and the
 *     PR-shaped artifact.
 *
 * No network. No credentials. Run with:
 *
 *   pnpm tsx examples/production-loop/index.ts
 *
 * In a real wiring you would:
 *   - Replace the in-memory stores with a `FileSystemTraceStore` and
 *     `FileSystemFeedbackTrajectoryStore` shared with the production
 *     runtime (or wire the HTTP ingestion endpoints).
 *   - Replace the deterministic runner with your actual agent driver.
 *   - Replace the deterministic scorer with a calibrated judge
 *     (`callLlmJson` + a Rubric, or any `MultiShotScorer`).
 *   - Wire a real `AutoPrClient`: `httpGithubClient({ token: GITHUB_TOKEN })`
 *     in CI, or `ghCliClient()` for developer machines.
 *   - Trigger the loop via a `workflow_dispatch` or scheduled GitHub
 *     Action — the primitive runs ONE cycle; cron is the consumer's job.
 */

import type {
  AutoPrClient,
  ProposeAutomatedPullRequestInput,
  ProposeAutomatedPullRequestResult,
} from '../../src/auto-pr'
import { InMemoryFeedbackTrajectoryStore } from '../../src/feedback-trajectory'
import { runProductionLoop } from '../../src/production-loop'
import { InMemoryTraceStore } from '../../src/trace/store'
import type { Scenario } from '../../src/types'

// ── 1. Domain types ──────────────────────────────────────────────────

interface TaxAgentPayload {
  systemPrompt: string
}

function scenario(id: string, persona: string): Scenario {
  return {
    id,
    persona,
    label: id,
    thesis: `Filing scenario: ${id}`,
    dimensions: ['correctness', 'citation_quality'],
    turns: [
      {
        user: 'Help me file my taxes given my W-2 + 1099-NEC for 2025.',
        expectedBehaviors: ['gather state', 'cite a statute', 'flag missing forms'],
      },
    ],
    artifactChecks: [],
  }
}

// ── 2. Seed production telemetry into the stores ─────────────────────

async function seedProductionState() {
  const traceStore = new InMemoryTraceStore()
  const feedbackStore = new InMemoryFeedbackTrajectoryStore()

  // 8 prod runs that all blew up on the same root cause: the agent
  // failed to cite a statute when an FTC rule was contested.
  for (let i = 0; i < 8; i++) {
    await traceStore.appendRun({
      runId: `prod-run-${i}`,
      scenarioId: 'ftc-noncompete-edge',
      startedAt: Date.now() - 3_600_000 + i * 10_000,
      endedAt: Date.now() - 3_600_000 + i * 10_000 + 500,
      status: 'failed',
      outcome: {
        pass: false,
        score: 0.2,
        failureClass: 'instruction_following',
        notes: 'Cited no statute; rubric requires section number on contested rules.',
      },
    })
    // Matching 👎 feedback from the user.
    await feedbackStore.save({
      id: `ft-${i}`,
      scenarioId: 'ftc-noncompete-edge',
      task: { intent: 'Explain whether the FTC non-compete rule applies to my contract.' },
      attempts: [],
      labels: [
        {
          source: 'user',
          kind: 'reject',
          value: { thumb: 'down', complaint: 'No citation. Made things up.' },
          severity: 'error',
          createdAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
    })
  }

  return { traceStore, feedbackStore }
}

// ── 3. Fake AutoPrClient that captures the PR plan ──────────────────

function captureAutoPrClient(): {
  client: AutoPrClient
  captured: ProposeAutomatedPullRequestInput[]
} {
  const captured: ProposeAutomatedPullRequestInput[] = []
  const client: AutoPrClient = {
    proposeChange(input): Promise<ProposeAutomatedPullRequestResult> {
      captured.push(input)
      return Promise.resolve({
        prUrl: `https://github.com/${input.repo.owner}/${input.repo.name}/pull/synthetic-1`,
        branchName: input.branchName,
        headSha: 'face-cafe-beef-1234'.padEnd(40, '0'),
        dryRun: false,
      })
    },
  }
  return { client, captured }
}

// ── 4. The loop ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { traceStore, feedbackStore } = await seedProductionState()
  const { client: prClient, captured: prCaptured } = captureAutoPrClient()

  const baselinePrompt =
    'You are a tax assistant. Be helpful and concise. ' +
    'Answer questions about US tax forms and rules.'

  const holdoutScenarios = [
    scenario('ftc-noncompete-edge', 'small-biz-owner'),
    scenario('schedule-c-self-employed', 'freelancer'),
    scenario('w2-multistate', 'remote-worker'),
  ]
  const searchScenarios = [
    scenario('basic-w2', 'salaried'),
    scenario('joint-return', 'married'),
  ]

  const result = await runProductionLoop<TaxAgentPayload>({
    runId: `prod-loop-demo-${Date.now()}`,
    target: 'tax-agent',
    traceStore,
    feedbackStore,
    cluster: {
      minClusterSize: 5,
      minSeverityRatio: 0.05,
      maxClustersPerCycle: 1,
    },
    evolve: {
      baselinePrompt: { systemPrompt: baselinePrompt },
      holdoutScenarios,
      searchScenarios,
      // Deterministic runner: trace length scales with prompt length, modeling
      // "longer prompts elicit more deliberate reasoning."
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
      // Deterministic scorer: a prompt that mentions "cite" scores higher.
      scorer: {
        score: ({ variant }) => {
          const lengthSignal = Math.min(1, variant.payload.systemPrompt.length / 300)
          const citationBonus = /cite/i.test(variant.payload.systemPrompt) ? 0.3 : 0
          const refuseBonus = /refuse/i.test(variant.payload.systemPrompt) ? 0.15 : 0
          const score = Math.min(1, 0.3 + lengthSignal * 0.4 + citationBonus + refuseBonus)
          return { score, ok: score >= 0.6 }
        },
      },
      // Addendum-style mutator: append a citation directive.
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
                'When the question concerns a contested rule (FTC, IRS, state tax authority), ' +
                'you MUST cite the statute or regulation by section number, and you MUST refuse ' +
                'to answer if the rule is not present in your active corpus.',
            },
            rationale: 'Address `instruction_following` failure cluster: missing citations.',
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
      baseBranch: 'main',
      reviewers: ['drew'],
      labels: ['production-loop', 'auto-improve'],
    },
    cron: { cadence: 'weekly', jitterSec: 600 },
  })

  // ── Render ──────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('production-loop demo · synthetic prod data → improved prompt')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`runId          : ${result.runId}`)
  console.log(`target         : ${result.target}`)
  console.log(`decision       : ${result.decision}`)
  console.log(`observed runs  : ${result.observedRunCount}`)
  console.log(`observed feedback: ${result.observedFeedbackCount}`)
  console.log(`clusters seen  : ${result.clusters.length}`)
  if (result.actedOnCluster) {
    console.log(`acted-on       : class=${result.actedOnCluster.failureClass} `
      + `runs=${result.actedOnCluster.runCount} `
      + `scenarios=${result.actedOnCluster.scenarioIds.length}`)
  }
  if (result.gate) {
    console.log(`gate           : promote=${result.gate.promote} `
      + `medianΔ=${result.gate.evidence.medianPairedDelta.toFixed(3)} `
      + `CI=[${result.gate.evidence.pairedCI.low.toFixed(3)}, `
      + `${result.gate.evidence.pairedCI.high.toFixed(3)}]`)
  }
  if (result.release) {
    console.log(`release status : ${result.release.status} `
      + `(passRate=${result.release.metrics.passRate.toFixed(3)} `
      + `meanScore=${result.release.metrics.meanScore.toFixed(3)})`)
  }
  if (result.pullRequest) {
    console.log('───────────────────────────────────────────────────────────────')
    console.log(`PR opened      : ${result.pullRequest.prUrl}`)
    console.log(`branch         : ${result.pullRequest.branchName}`)
    console.log(`head SHA       : ${result.pullRequest.headSha}`)
    console.log('───────────────────────────────────────────────────────────────')
    const pr = prCaptured[0]
    if (pr) {
      console.log('PR title:', pr.title)
      console.log('PR file:', pr.fileChanges[0]?.path)
      console.log('PR body preview:')
      console.log(
        pr.body
          .split('\n')
          .slice(0, 20)
          .map((line) => `  ${line}`)
          .join('\n'),
      )
      console.log('  ...')
    }
  }
  console.log('═══════════════════════════════════════════════════════════════')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
