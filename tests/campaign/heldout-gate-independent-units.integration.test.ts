/**
 * Decision points taken from one historical run share that run's state, so
 * they are one independent unit however many cells they fill. These tests
 * replay baseline and candidate arms through `runCampaign` with a deterministic
 * dispatcher and judge, then decide the lift with the composable `heldOutGate`.
 */
import { describe, expect, it } from 'vitest'
import {
  type CampaignResult,
  type GateContext,
  heldOutGate,
  inMemoryCampaignStorage,
  type JudgeConfig,
  runCampaign,
  type Scenario,
} from '../../src/campaign/index'

interface WakeScenario extends Scenario {
  id: string
  kind: string
  runId: string
}

interface Decision {
  correct: boolean
}

/** `wakes` decision points from each historical run. */
function wakesOf(runIds: string[], wakes: number): WakeScenario[] {
  return runIds.flatMap((runId) =>
    Array.from({ length: wakes }, (_, wake) => ({
      id: `${runId}/wake-${wake}`,
      kind: 'decision-point',
      runId,
    })),
  )
}

function unitByWake(scenarios: WakeScenario[]): Map<string, string> {
  return new Map(scenarios.map((scenario) => [scenario.id, scenario.runId]))
}

const correctness: JudgeConfig<Decision, WakeScenario> = {
  name: 'correctness',
  dimensions: [{ key: 'correct', description: 'the decision matches the recorded outcome' }],
  judgeVersion: 'correctness-v1',
  score: ({ artifact }) => {
    const value = artifact.correct ? 1 : 0
    return { dimensions: { correct: value }, composite: value, notes: '' }
  },
}

async function replay(
  arm: string,
  scenarios: WakeScenario[],
  correct: (scenario: WakeScenario) => boolean,
): Promise<CampaignResult<Decision, WakeScenario>> {
  const campaign = await runCampaign<WakeScenario, Decision>({
    scenarios,
    dispatch: async (scenario) => ({ correct: correct(scenario) }),
    dispatchRef: `replay-${arm}`,
    judges: [correctness],
    runDir: `/heldout-independent-units/${arm}`,
    storage: inMemoryCampaignStorage(),
    labeledStore: 'off',
    tracing: 'off',
    expectUsage: 'off',
  })
  expect(campaign.aggregates.cellsFailed).toBe(0)
  expect(campaign.cells).toHaveLength(scenarios.length)
  return campaign
}

/** The context `runImprovementLoop` hands a promotion gate after both holdout arms. */
async function holdoutContext(
  scenarios: WakeScenario[],
  baselineCorrect: (scenario: WakeScenario) => boolean,
  candidateCorrect: (scenario: WakeScenario) => boolean,
): Promise<GateContext<Decision, WakeScenario>> {
  const baseline = await replay('baseline', scenarios, baselineCorrect)
  const candidate = await replay('candidate', scenarios, candidateCorrect)
  const scores = (campaign: CampaignResult<Decision, WakeScenario>) =>
    new Map(campaign.cells.map((cell) => [cell.cellId, cell.judgeScores]))
  const artifacts = (campaign: CampaignResult<Decision, WakeScenario>) =>
    new Map(campaign.cells.map((cell) => [cell.cellId, cell.artifact]))
  return {
    candidateArtifacts: artifacts(candidate),
    baselineArtifacts: artifacts(baseline),
    judgeScores: scores(candidate),
    baselineJudgeScores: scores(baseline),
    scenarios,
    cost: { candidate: 0, baseline: 0 },
    signal: new AbortController().signal,
  }
}

// The detail a caller without a unit map has always received, in order.
const CELL_DETAIL_KEYS = [
  'deltaMean',
  'decidingDelta',
  'decisionStatistic',
  'decisionMethod',
  'binaryScale',
  'mcnemar',
  'indeterminate',
  'deltaMedianDiagnostic',
  'tieFraction',
  'ciLow',
  'ciHigh',
  'bootstrapCiLow',
  'bootstrapCiHigh',
  'confidence',
  'n',
  'deltaThreshold',
  'fewRuns',
  'seed',
]

describe('heldOutGate counts each independent unit once', () => {
  it('counts 12 wakes from 2 historical runs as 2 units and holds the lift that ships on 12 cells', async () => {
    const scenarios = wakesOf(['run-a', 'run-b'], 6)
    // The baseline misses every wake of run-a and gets every wake of run-b;
    // the candidate gets every wake. The whole lift comes from one run.
    const ctx = await holdoutContext(
      scenarios,
      (scenario) => scenario.runId === 'run-b',
      () => true,
    )
    expect(ctx.judgeScores.size).toBe(12)

    const byCell = await heldOutGate({ scenarios, deltaThreshold: 0 }).decide(ctx)
    expect(byCell.decision).toBe('ship')
    expect(byCell.delta).toBe(0.5)
    expect(byCell.reasons).toEqual([
      expect.stringMatching(
        /^held-out success-rate Δ 0\.500, CI\.low 0\.\d{3} > 0 \(95% CI \[0\.\d{3}, 0\.\d{3}\], n=12, 50% tied\)$/,
      ),
    ])
    const cellDetail = byCell.contributingGates[0]?.detail ?? {}
    expect(Object.keys(cellDetail)).toEqual(CELL_DETAIL_KEYS)
    expect(cellDetail).toMatchObject({ n: 12, fewRuns: false })

    const byRun = await heldOutGate({
      scenarios,
      deltaThreshold: 0,
      independentUnitByScenarioId: unitByWake(scenarios),
    }).decide(ctx)
    expect(byRun.decision).toBe('hold')
    expect(byRun.delta).toBe(0.5)
    expect(byRun.reasons).toEqual([
      'held-out: only 2 independent units from 12 paired cells; 6 required — too few to claim significance',
    ])
    expect(byRun.contributingGates[0]).toMatchObject({
      name: 'heldOutGate',
      status: 'not_evaluated',
      detail: {
        n: 2,
        pairedCellN: 12,
        observationUnit: 'registered',
        unitIds: ['run-a', 'run-b'],
        fewRuns: true,
      },
    })
  })

  it('ships once enough independent runs each improve, and keeps the grouping it was built with', async () => {
    const scenarios = wakesOf(['run-a', 'run-b', 'run-c', 'run-d', 'run-e', 'run-f'], 2)
    const ctx = await holdoutContext(scenarios, () => false, () => true)
    const units = unitByWake(scenarios)
    const gate = heldOutGate({ scenarios, deltaThreshold: 0, independentUnitByScenarioId: units })
    // The gate copied the map when it was built; a later edit cannot regroup it.
    units.clear()
    const result = await gate.decide(ctx)
    expect(result.decision).toBe('ship')
    expect(result.delta).toBe(1)
    expect(result.reasons).toEqual([
      expect.stringMatching(
        /^held-out success-rate Δ 1\.000, CI\.low 0\.\d{3} > 0 \(95% CI \[0\.\d{3}, \d\.\d{3}\], n=6 independent units from 12 paired cells\)$/,
      ),
    ])
    expect(result.contributingGates[0]).toMatchObject({
      status: 'pass',
      detail: {
        n: 6,
        pairedCellN: 12,
        observationUnit: 'registered',
        unitIds: ['run-a', 'run-b', 'run-c', 'run-d', 'run-e', 'run-f'],
      },
    })
  })

  it('refuses a scored wake that the supplied map leaves out', async () => {
    const scenarios = wakesOf(['run-a', 'run-b'], 6)
    const ctx = await holdoutContext(
      scenarios,
      (scenario) => scenario.runId === 'run-b',
      () => true,
    )
    const units = unitByWake(scenarios)
    units.delete('run-b/wake-5')
    await expect(
      heldOutGate({ scenarios, deltaThreshold: 0, independentUnitByScenarioId: units }).decide(ctx),
    ).rejects.toThrow("aggregatePairedHoldout: missing independent unit for scenario 'run-b/wake-5'")
  })
})
