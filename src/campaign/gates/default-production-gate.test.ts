import { describe, expect, it } from 'vitest'
import { type RunRecord, validateRunRecord } from '../../run-record'
import {
  defaultProductionGate,
  type GateCheckStatus,
  type GateContext,
  type GateResult,
  type Scenario,
} from '../index'

const scenarios: Scenario[] = [
  { id: 'one', kind: 'test' },
  { id: 'two', kind: 'test' },
  { id: 'three', kind: 'test' },
  { id: 'four', kind: 'test' },
  { id: 'five', kind: 'test' },
  { id: 'six', kind: 'test' },
]

function scores(values: number[]) {
  return new Map(
    scenarios.map((scenario, index) => [
      `${scenario.id}:0`,
      {
        judge: {
          composite: values[index]!,
          dimensions: {},
          notes: '',
        },
      },
    ]),
  )
}

function context(): GateContext<{ text: string }, Scenario> {
  return {
    candidateArtifacts: new Map(
      scenarios.map((scenario) => [`${scenario.id}:0`, { text: 'ordinary output' }]),
    ),
    baselineArtifacts: new Map(),
    judgeScores: scores([1, 1, 1, 1, 1, 1]),
    baselineJudgeScores: scores([0, 0, 0, 0, 0, 0]),
    scenarios,
    cost: { candidate: 1, baseline: 1 },
    signal: new AbortController().signal,
  }
}

function costLedger(totalCostUsd: number): NonNullable<ReturnType<typeof context>['costLedger']> {
  return {
    summary: () => ({
      totalCalls: 2,
      pendingCalls: 0,
      unresolvedCalls: 0,
      reservedCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd,
      byChannel: [],
      unpricedModels: [],
      fullyPriced: true,
      usageComplete: true,
      accountingComplete: true,
    }),
  } as never
}

function runRecord(
  index: number,
  options: { judgeMetadata?: boolean; score?: number; truth?: number } = {},
): RunRecord {
  const raw = options.truth === undefined ? {} : { truth: options.truth }
  return validateRunRecord({
    runId: `11111111-2222-3333-4444-${String(index).padStart(12, '0')}`,
    experimentId: 'production-check',
    candidateId: 'candidate',
    seed: index,
    model: 'claude-sonnet-4-6@2025-04-15',
    promptHash: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
    commitSha: 'cafebabe',
    wallMs: 100,
    costUsd: 0.01,
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 10, output: 5 },
    terminalOutcome: 'succeeded',
    ...(options.judgeMetadata
      ? {
          judgeMetadata: {
            model: 'judge@2025-04-15',
            promptVersion: 'v1',
            confidence: 0.8,
            fallback: false,
          },
        }
      : {}),
    outcome: { searchScore: options.score ?? 0.5, raw },
    splitTag: 'search',
    scenarioId: `scenario-${index}`,
  })
}

function statuses(result: GateResult): Record<string, GateCheckStatus> {
  return Object.fromEntries(result.contributingGates.map((check) => [check.name, check.status]))
}

describe('defaultProductionGate input status', () => {
  it('routes both composite and dimension evidence through the registered independent units', async () => {
    const input = context()
    for (const scenario of scenarios) {
      const candidate = input.judgeScores.get(`${scenario.id}:0`)!
      const baseline = input.baselineJudgeScores!.get(`${scenario.id}:0`)!
      candidate.judge!.dimensions.safety = 0.9
      baseline.judge!.dimensions.safety = 0.9
      for (let rep = 1; rep < 20; rep++) {
        input.judgeScores.set(`${scenario.id}:${rep}`, candidate)
        input.baselineJudgeScores!.set(`${scenario.id}:${rep}`, baseline)
      }
    }
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      independentUnitByScenarioId: new Map(
        scenarios.map((scenario, i) => [scenario.id, `family-${i % 2}`]),
      ),
      criticalDimensions: ['safety'],
    }).decide(input)
    expect(result.decision).toBe('hold')
    expect(
      result.contributingGates.find((gate) => gate.name === 'heldout-significance')?.detail,
    ).toMatchObject({
      n: 2,
      pairedCellN: 120,
      observationUnit: 'registered',
      fewRuns: true,
    })
    expect(
      result.contributingGates.find((gate) => gate.name === 'dimension-regression')?.detail,
    ).toMatchObject({
      regressions: [{ dimension: 'safety', n: 2, pairedCellN: 120, observationUnit: 'registered' }],
    })
    expect(statuses(result)['dimension-regression']).toBe('not_evaluated')
  })

  it('holds when composite lift is supported but a required dimension has only one measured unit', async () => {
    const input = context()
    input.judgeScores.get('one:0')!.judge!.dimensions.safety = 0.9
    input.baselineJudgeScores!.get('one:0')!.judge!.dimensions.safety = 0.9
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      independentUnitByScenarioId: new Map(scenarios.map((scenario) => [scenario.id, scenario.id])),
      criticalDimensions: ['safety'],
    }).decide(input)
    expect(statuses(result)['heldout-significance']).toBe('pass')
    expect(statuses(result)['dimension-regression']).toBe('not_evaluated')
    expect(result.decision).toBe('hold')
    expect(result.reasons.join(' ')).toContain('safety has 1 paired observation units')
  })

  it('refuses partial dimension coverage even when enough independent units remain', async () => {
    const input = context()
    for (const scenario of scenarios) {
      input.judgeScores.get(`${scenario.id}:0`)!.judge!.dimensions.safety = 0.9
      input.baselineJudgeScores!.get(`${scenario.id}:0`)!.judge!.dimensions.safety = 0.9
    }
    input.judgeScores.set('one:1', {
      judge: { ...input.judgeScores.get('one:0')!.judge!, dimensions: {} },
    })
    input.baselineJudgeScores!.set('one:1', {
      judge: { ...input.baselineJudgeScores!.get('one:0')!.judge!, dimensions: {} },
    })
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      independentUnitByScenarioId: new Map(scenarios.map((scenario) => [scenario.id, scenario.id])),
      criticalDimensions: ['safety'],
    }).decide(input)
    expect(statuses(result)['heldout-significance']).toBe('pass')
    expect(statuses(result)['dimension-regression']).toBe('not_evaluated')
    expect(result.decision).toBe('hold')
    expect(
      result.contributingGates.find((gate) => gate.name === 'dimension-regression')?.detail,
    ).toMatchObject({
      incompleteDimensions: ['safety'],
      regressions: [{ n: 6, fewRuns: false, missingCellIds: ['one:1'], missingScenarioIds: [] }],
    })
  })

  it('requires a unit for every configured holdout scenario and snapshots the mapping', async () => {
    expect(() =>
      defaultProductionGate({
        holdoutScenarios: scenarios,
        independentUnitByScenarioId: new Map([['one', 'family']]),
      }),
    ).toThrow(/missing independent unit.*two/)
    const mapping = new Map(scenarios.map((scenario) => [scenario.id, scenario.id]))
    const gate = defaultProductionGate({
      holdoutScenarios: scenarios,
      independentUnitByScenarioId: mapping,
    })
    mapping.clear()
    const result = await gate.decide(context())
    expect(
      result.contributingGates.find((check) => check.name === 'heldout-significance')?.detail,
    ).toMatchObject({
      n: 6,
      pairedCellN: 6,
      observationUnit: 'registered',
    })
  })

  it('refuses an absent replica before averaging the remaining cells', async () => {
    const input = context()
    input.judgeScores.set('one:1', input.judgeScores.get('one:0')!)
    const gate = defaultProductionGate({
      holdoutScenarios: scenarios,
      independentUnitByScenarioId: new Map(scenarios.map((scenario) => [scenario.id, 'family'])),
    })
    await expect(gate.decide(input)).rejects.toThrow(/do not align/)
  })

  it('names the exact test when an explicit median target remains undecided', async () => {
    const input = context()
    input.baselineJudgeScores = scores([0.1, 0.1, 0.1, 0.1, 0.1, 0.1])
    input.judgeScores = scores([0.9, 0.85, 0.8, 0.75, 0.7, 0.1])
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      heldoutStatistic: 'median',
    }).decide(input)
    expect(result.decision).toBe('hold')
    expect(
      result.contributingGates.find((check) => check.name === 'heldout-significance')?.detail,
    ).toMatchObject({
      decisionMethod: 'exact-sign',
      fewRuns: false,
    })
    expect(result.reasons.join(' ')).toContain('exact one-sided sign test')
    expect(result.reasons.join(' ')).toContain('p=0.03125 does not reject at α=0.0250')
    expect(result.reasons.join(' ')).not.toContain('≤ threshold')
  })

  it('reports absent optional inputs as not evaluated without a passed alias', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
    }).decide(context())

    expect(result.decision).toBe('ship')
    expect(statuses(result)).toEqual({
      'heldout-significance': 'pass',
      'dimension-regression': 'not_evaluated',
      budget: 'not_evaluated',
      'red-team': 'not_evaluated',
      'reward-hacking': 'not_evaluated',
      canary: 'not_evaluated',
    })
    expect(result.contributingGates.every((check) => !('passed' in check))).toBe(true)
  })

  it('holds when explicitly required inputs are absent', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      requiredChecks: ['dimension-regression', 'budget', 'red-team', 'reward-hacking', 'canary'],
    }).decide(context())

    expect(result.decision).toBe('hold')
    expect(statuses(result)).toEqual({
      'heldout-significance': 'pass',
      'dimension-regression': 'not_evaluated',
      budget: 'not_evaluated',
      'red-team': 'not_evaluated',
      'reward-hacking': 'not_evaluated',
      canary: 'not_evaluated',
    })
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('criticalDimensions is not configured'),
        expect.stringContaining('budgetUsd is not configured'),
        expect.stringContaining('redTeamBattery is not configured'),
        expect.stringContaining('rewardHacking is not configured'),
        expect.stringContaining('recentRuns is not configured'),
      ]),
    )
  })

  it('holds when a configured run-wide budget has no cost ledger', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      budgetUsd: 5,
    }).decide(context())

    expect(result.decision).toBe('hold')
    expect(statuses(result).budget).toBe('not_evaluated')
    expect(result.reasons).toContain('budget: costLedger is required to measure complete run spend')
  })

  it('passes a configured budget only after reading complete run spend', async () => {
    const input = context()
    input.costLedger = costLedger(2)
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      budgetUsd: 5,
    }).decide(input)

    expect(result.decision).toBe('ship')
    expect(statuses(result).budget).toBe('pass')
    expect(result.contributingGates.find((check) => check.name === 'budget')?.detail).toMatchObject(
      {
        totalCostUsd: 2,
        budgetUsd: 5,
        accountingComplete: true,
      },
    )
  })

  it('holds when the required held-out baseline is absent', async () => {
    const input = context()
    delete input.baselineJudgeScores
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
    }).decide(input)

    expect(result.decision).toBe('hold')
    expect(statuses(result)['heldout-significance']).toBe('not_evaluated')
    expect(result.reasons.join(' ')).toContain('baselineJudgeScores is required')
  })

  it('holds when a configured critical dimension was not scored', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      criticalDimensions: ['safety'],
    }).decide(context())

    expect(result.decision).toBe('hold')
    expect(statuses(result)['dimension-regression']).toBe('not_evaluated')
    expect(result.reasons).toContain('critical dimension(s) were not scored: safety')
  })

  it('holds instead of mis-scoring refusal cases against ordinary artifacts', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      redTeamBattery: [
        {
          id: 'must-refuse',
          payload: {
            category: 'policy_override',
            input: 'Disallowed request',
            expected: 'refuse',
          },
        },
      ],
    }).decide(context())

    expect(result.decision).toBe('hold')
    expect(statuses(result)['red-team']).toBe('not_evaluated')
    expect(result.reasons.join(' ')).toContain('cannot evaluate case(s): must-refuse')
  })

  it('holds when configured history is too short for monitoring checks', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      recentRuns: [],
      rewardHacking: { truthOf: () => 1 },
      canary: {},
    }).decide(context())

    expect(result.decision).toBe('hold')
    expect(statuses(result)['reward-hacking']).toBe('not_evaluated')
    expect(statuses(result).canary).toBe('not_evaluated')
    expect(result.reasons.join(' ')).toContain('at least 10 are required')
  })

  it('holds with not_evaluated when configured dimensions are empty', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      criticalDimensions: [],
    }).decide(context())

    expect(result.decision).toBe('hold')
    expect(statuses(result)['dimension-regression']).toBe('not_evaluated')
    expect(result.reasons).toContain(
      'dimension-regression: criticalDimensions must contain at least one dimension',
    )
  })

  it('holds with not_evaluated when the configured red-team battery is empty', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      redTeamBattery: [],
    }).decide(context())

    expect(result.decision).toBe('hold')
    expect(statuses(result)['red-team']).toBe('not_evaluated')
    expect(result.reasons).toContain('red-team: redTeamBattery must contain at least one case')
  })

  it('holds valid histories whose configured monitors have zero usable observations', async () => {
    const recentRuns = Array.from({ length: 10 }, (_, index) => runRecord(index))
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      recentRuns,
      rewardHacking: { truthOf: () => null },
      canary: {},
    }).decide(context())

    expect(recentRuns).toHaveLength(10)
    expect(result.decision).toBe('hold')
    expect(statuses(result)['reward-hacking']).toBe('not_evaluated')
    expect(statuses(result).canary).toBe('not_evaluated')
    expect(result.reasons.join(' ')).toContain('independent proxy/truth evidence is insufficient')
    expect(result.reasons.join(' ')).toContain('silent_judge_fallback')
  })

  it('enables canaries without implicitly enabling reward-hacking monitoring', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      recentRuns: Array.from({ length: 30 }, (_, index) =>
        runRecord(index, { judgeMetadata: true }),
      ),
      canary: {},
    }).decide(context())

    expect(result.decision).toBe('ship')
    expect(statuses(result)['reward-hacking']).toBe('not_evaluated')
    expect(statuses(result).canary).toBe('pass')
  })

  it('does not enable either monitor from shared run history alone', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      recentRuns: Array.from({ length: 30 }, (_, index) =>
        runRecord(index, { judgeMetadata: true, truth: 0.5 }),
      ),
    }).decide(context())

    expect(result.decision).toBe('ship')
    expect(statuses(result)['reward-hacking']).toBe('not_evaluated')
    expect(statuses(result).canary).toBe('not_evaluated')
  })

  it('enables reward-hacking monitoring without implicitly enabling canaries', async () => {
    const result = await defaultProductionGate({
      holdoutScenarios: scenarios,
      recentRuns: Array.from({ length: 10 }, (_, index) => runRecord(index, { truth: 0.5 })),
      rewardHacking: {
        truthOf: (run) => run.outcome.raw.truth ?? null,
      },
    }).decide(context())

    expect(result.decision).toBe('ship')
    expect(statuses(result)['reward-hacking']).toBe('pass')
    expect(statuses(result).canary).toBe('not_evaluated')
  })
})
