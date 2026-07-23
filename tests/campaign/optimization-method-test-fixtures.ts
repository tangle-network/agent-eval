import type {
  CompareOptimizationMethodsOptions,
  OptimizationMethod,
} from '../../src/campaign/presets/compare-optimization-methods'
import type { JudgeConfig, Scenario } from '../../src/campaign/types'

export interface TestScenario extends Scenario {
  id: string
  kind: string
}

export interface TestArtifact {
  text: string
}

export const TRAIN: TestScenario[] = [
  { id: 't1', kind: 'q' },
  { id: 't2', kind: 'q' },
  { id: 't3', kind: 'q' },
]

export const SELECTION: TestScenario[] = [
  { id: 's1', kind: 'q' },
  { id: 's2', kind: 'q' },
  { id: 's3', kind: 'q' },
  { id: 's4', kind: 'q' },
]

export const TEST: TestScenario[] = [
  { id: 'h1', kind: 'q' },
  { id: 'h2', kind: 'q' },
  { id: 'h3', kind: 'q' },
  { id: 'h4', kind: 'q' },
]

export const PARTITIONS = {
  trainScenarios: TRAIN,
  selectionScenarios: SELECTION,
  testScenarios: TEST,
}

export const solveJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'solves',
  dimensions: [{ key: 'solved', description: 'scenario solved' }],
  score: ({ artifact, scenario }) => {
    const value = artifact.text.includes(`SOLVE_${scenario.id}`) ? 1 : 0
    return { dimensions: { solved: value }, composite: value, notes: '' }
  },
}

export const completeCost = (totalCostUsd: number) => ({
  totalCostUsd,
  accountingComplete: true,
  incompleteReasons: [],
})

/** A complete method that returns a fixed surface without a model call. */
export function fixedMethod(
  name: string,
  winnerSurface: string,
  totalCostUsd: number,
): OptimizationMethod<TestScenario, TestArtifact> {
  return {
    name,
    optimize: async () => ({ winnerSurface, cost: completeCost(totalCostUsd), durationMs: 1 }),
  }
}

export function incompleteCostMethod(
  name: string,
  winnerSurface: string,
  reason: string,
): OptimizationMethod<TestScenario, TestArtifact> {
  return {
    name,
    optimize: async () => ({
      winnerSurface,
      cost: { totalCostUsd: 0, accountingComplete: false, incompleteReasons: [reason] },
    }),
  }
}

export function paidDispatch(
  onExecute: () => void = () => {},
): CompareOptimizationMethodsOptions<TestScenario, TestArtifact>['dispatchWithSurface'] {
  return async (surface, _scenario, ctx) => {
    const paid = await ctx.cost.runPaidCall({
      actor: 'test-worker',
      model: 'test-model',
      maximumCharge: { externallyEnforcedMaximumUsd: 0.01 },
      execute: async () => {
        onExecute()
        return { text: String(surface) }
      },
      receipt: () => ({
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 1,
        actualCostUsd: 0.01,
      }),
    })
    if (!paid.succeeded) throw paid.error
    return paid.value
  }
}
