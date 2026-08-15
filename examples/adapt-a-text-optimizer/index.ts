/**
 * Let another package own the search, and keep the scoring here.
 *
 * Run with: pnpm tsx examples/adapt-a-text-optimizer/index.ts
 *
 * `externalTextOptimizationMethod()` wraps a package that already knows how to
 * search over text. Agent Eval supplies train and selection cases, executes
 * every candidate, counts evaluations, records cost, and scores the winner on
 * final cases the optimizer never saw.
 *
 * The optimizer below is a local hill climb so the example runs offline.
 * Replace its body with a call into the real package.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareOptimizationMethods,
  externalTextOptimizationMethod,
} from '../../src/campaign'
import type { JudgeConfig, Scenario } from '../../src/contract'

interface SupportCase extends Scenario {
  question: string
  wanted: string
}

interface SupportArtifact {
  answer: string
}

function caseOf(id: string, question: string, wanted: string): SupportCase {
  return { id, kind: 'support', question, wanted }
}

const trainScenarios = [
  caseOf('t1', 'Where is order 5512?', '5512'),
  caseOf('t2', 'Refund invoice 8841?', '8841'),
  caseOf('t3', 'Cancel ticket 2077?', '2077'),
]
const selectionScenarios = [
  caseOf('s1', 'Status of order 3310?', '3310'),
  caseOf('s2', 'Reship parcel 6644?', '6644'),
]
const testScenarios = [
  caseOf('f1', 'Return item 9901?', '9901'),
  caseOf('f2', 'Replace unit 4402?', '4402'),
  caseOf('f3', 'Escalate case 7150?', '7150'),
]

/** The agent under test. A surface that asks for the id makes it cite the id. */
async function dispatchWithSurface(
  surface: unknown,
  scenario: SupportCase,
): Promise<SupportArtifact> {
  const prompt = String(surface)
  const id = scenario.question.match(/\d+/)?.[0] ?? ''
  return { answer: prompt.includes('reference number') ? `Reference ${id}. On it.` : 'On it.' }
}

const judge: JudgeConfig<SupportArtifact, SupportCase> = {
  name: 'cites-the-id',
  dimensions: [{ key: 'cited', description: 'The answer repeats the reference number' }],
  score: ({ artifact, scenario }) => {
    const cited = artifact.answer.includes(scenario.wanted) ? 1 : 0
    return { dimensions: { cited }, composite: cited, notes: '' }
  },
}

/** Stand-in for the third-party package. Keeps the best of a few rewrites. */
async function hillClimb(options: {
  initial: string
  candidates: string[]
  evaluate: (candidate: string) => Promise<number>
}): Promise<{ best: string; evaluations: number }> {
  let best = options.initial
  let bestScore = await options.evaluate(best)
  let evaluations = 1
  for (const candidate of options.candidates) {
    const score = await options.evaluate(candidate)
    evaluations += 1
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return { best, evaluations }
}

const method = externalTextOptimizationMethod<SupportCase, SupportArtifact>({
  name: 'local-hill-climb',
  source: { kind: 'package', package: 'local-hill-climb', version: '0.0.0' },
  objective: 'Make the answer repeat the reference number.',
  // Identity of the execution and scoring behavior. Change it whenever that
  // behavior changes, so two runs are never compared across a silent edit.
  evaluationId: 'support-cites-id@1',
  maxEvaluations: 12,
  // A hard ceiling on optimizer-owned spend. It is required, so an adapter
  // cannot be wired up without stating what the search may cost.
  maxOptimizerCostUsd: 0,
  describeScenario: (scenario) => ({ question: scenario.question }),
  describeArtifact: (artifact) => ({ answer: artifact.answer }),
  run: async (context) => {
    const seed = String(context.seedCandidate)
    const outcome = await hillClimb({
      initial: seed,
      candidates: [
        `${seed}\nBe brief.`,
        `${seed}\nAlways quote the reference number.`,
        `${seed}\nQuote the reference number and confirm the next step.`,
      ],
      evaluate: async (candidate) => {
        // One call scores one candidate on one case, through the configured
        // execution and judges. Each call is counted against maxEvaluations
        // before it runs, and an unknown case id is rejected.
        let total = 0
        for (const example of context.trainSet) {
          const response = await context.evaluate({ candidate, exampleId: example.id })
          total += response.score
        }
        return total / Math.max(1, context.trainSet.length)
      },
    })
    return {
      bestCandidate: outcome.best,
      resumed: false,
      // This optimizer makes no paid calls, so there is nothing to meter.
      costAccounting: { kind: 'no-paid-work' },
    }
  },
})

const result = await compareOptimizationMethods({
  methods: [method],
  baselineSurface: 'Answer politely.',
  trainScenarios,
  selectionScenarios,
  testScenarios,
  dispatchWithSurface,
  judges: [judge],
  runDir: mkdtempSync(join(tmpdir(), 'agent-eval-optimizer-')),
  // The final scoring campaign makes no paid calls in this example.
  expectUsage: 'off',
  // Shared defaults for the train and selection campaigns each method runs.
  // They are separate campaigns, so the setting above does not reach them.
  optimizationRunOptions: { expectUsage: 'off' },
})

for (const score of result.scores) {
  console.log(`method:        ${score.name}`)
  console.log(`baseline:      ${score.baselineComposite.toFixed(3)}`)
  console.log(`winner:        ${score.winnerComposite.toFixed(3)}`)
  console.log(`final lift:    ${score.lift.toFixed(3)}`)
  console.log(`lift interval: [${score.liftCi.low.toFixed(3)}, ${score.liftCi.high.toFixed(3)}]`)
}
console.log('cost is a complete total:', result.totalCost.accountingComplete)
