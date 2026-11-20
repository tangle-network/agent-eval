import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compareOptimizationMethods,
  inMemoryCampaignStorage,
  type MutableSurface,
  type OptimizationMethod,
  sequentialOptimizationMethod,
} from '../../src/campaign'
import { selfImprove } from '../../src/contract'
import {
  completeCost,
  fixedMethod,
  PARTITIONS,
  solveJudge,
  type TestArtifact,
  type TestScenario,
} from './optimization-method-test-fixtures'

// A method wrapper that describes artifacts to its optimizer itself, the way a
// wrapper that redacts its evidence and binds it into an evaluation identity
// does. It records whatever artifact descriptor its input carries.
function selfDescribingMethod(seen: unknown[]): OptimizationMethod<TestScenario, TestArtifact> {
  return {
    name: 'self-describing',
    ownsArtifactDescription: true,
    optimize: async (input) => {
      seen.push(input.describeArtifact)
      return { winnerSurface: input.baselineSurface, cost: completeCost(0), durationMs: 1 }
    },
  }
}

const callerDescriptor = (artifact: TestArtifact) => ({ unredacted: artifact.text })

function countingDispatch() {
  const calls = { count: 0 }
  const dispatchWithSurface = async (
    surface: MutableSurface,
    scenario: TestScenario,
  ): Promise<TestArtifact> => {
    calls.count += 1
    return { text: `${String(surface)} SOLVE_${scenario.id}` }
  }
  return { calls, dispatchWithSurface }
}

function comparison(
  methods: OptimizationMethod<TestScenario, TestArtifact>[],
  dispatchWithSurface: ReturnType<typeof countingDispatch>['dispatchWithSurface'],
  describeArtifact?: typeof callerDescriptor,
) {
  return compareOptimizationMethods<TestScenario, TestArtifact>({
    methods,
    baselineSurface: 'baseline',
    ...PARTITIONS,
    dispatchWithSurface,
    judges: [solveJudge],
    ...(describeArtifact ? { describeArtifact } : {}),
    runDir: mkdtempSync(join(tmpdir(), 'owned-description-')),
    storage: inMemoryCampaignStorage(),
    resamples: 40,
    expectUsage: 'off',
  })
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )

describe('a method that owns artifact description never receives its caller’s describeArtifact', () => {
  it('compareOptimizationMethods refuses the caller’s hook beside it before any spend', async () => {
    const seen: unknown[] = []
    const { calls, dispatchWithSurface } = countingDispatch()

    const error = await settle(
      comparison([selfDescribingMethod(seen)], dispatchWithSurface, callerDescriptor),
    )

    expect(seen).toEqual([])
    expect(calls.count).toBe(0)
    expect(String(error)).toMatch(
      /compareOptimizationMethods: method 'self-describing' describes its own artifacts, and its caller also set describeArtifact; set it once/,
    )
  })

  it('refuses it when the method is a stage of a sequential composition', async () => {
    const seen: unknown[] = []
    const { calls, dispatchWithSurface } = countingDispatch()
    const pipeline = sequentialOptimizationMethod<TestScenario, TestArtifact>({
      name: 'pipeline',
      methods: [fixedMethod('native', 'native winner', 0), selfDescribingMethod(seen)],
    })

    const error = await settle(comparison([pipeline], dispatchWithSurface, callerDescriptor))

    expect(seen).toEqual([])
    expect(calls.count).toBe(0)
    expect(String(error)).toMatch(/method 'pipeline' describes its own artifacts/)
  })

  it('runs the method when only the method describes artifacts', async () => {
    const seen: unknown[] = []
    const { dispatchWithSurface } = countingDispatch()

    const result = await comparison([selfDescribingMethod(seen)], dispatchWithSurface)

    expect(seen).toEqual([undefined])
    expect(result.scores.map((score) => score.name)).toEqual(['self-describing'])
  })

  it('selfImprove refuses the caller’s hook beside it before any spend', async () => {
    const seen: unknown[] = []
    const { calls, dispatchWithSurface } = countingDispatch()
    const scenarios = [
      ...PARTITIONS.trainScenarios,
      ...PARTITIONS.selectionScenarios,
      ...PARTITIONS.testScenarios,
    ]

    const error = await settle(
      selfImprove<TestScenario, TestArtifact>({
        agent: dispatchWithSurface,
        scenarios,
        judge: solveJudge,
        baselineSurface: 'baseline',
        model: 'gpt-4.1-2025-04-14',
        expectUsage: 'off',
        storage: inMemoryCampaignStorage(),
        runDir: 'mem://owned-description-self-improve',
        selectionScenarios: PARTITIONS.selectionScenarios,
        budget: { holdoutScenarios: PARTITIONS.testScenarios },
        describeArtifact: callerDescriptor,
        method: selfDescribingMethod(seen),
      }),
    )

    expect(seen).toEqual([])
    expect(calls.count).toBe(0)
    expect(String(error)).toMatch(
      /selfImprove: method 'self-describing' describes its own artifacts, and its caller also set describeArtifact; set it once/,
    )
  })
})
