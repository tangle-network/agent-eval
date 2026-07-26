import { describe, expect, it } from 'vitest'
import { fromOtelSpans } from '../contract/intake/otel-spans'
import { campaignScenarioIdentity, campaignSplitDigest } from './coverage'
import type { BuildLoopProvenanceArgs } from './provenance'
import {
  buildLoopProvenanceRecord,
  campaignMeasurementDigest,
  canonicalDigest,
  loopProvenanceSpans,
  verifyLoopProvenanceRecord,
} from './provenance'
import { surfaceHash } from './surface-identity'
import type { CampaignResult, GateDecision, GenerationCandidate, Scenario } from './types'

interface TestScenario extends Scenario {
  kind: 'test'
}

const testScenario = { id: 'fixture', kind: 'test' } satisfies TestScenario
const testScenarioIdentity = campaignScenarioIdentity(testScenario)

function campaign(composite: number, runDir: string): CampaignResult<unknown, TestScenario> {
  return {
    manifestHash: 'fixture-manifest',
    splitDigest: campaignSplitDigest([testScenario], 1),
    seed: 42,
    reps: 1,
    startedAt: '2026-07-13T00:00:00.000Z',
    endedAt: '2026-07-13T00:00:00.001Z',
    durationMs: 1,
    cells: [
      {
        cellId: 'fixture:0',
        scenarioId: 'fixture',
        rep: 0,
        artifact: {},
        judgeScores: {
          quality: { composite, dimensions: { quality: composite }, notes: '' },
        },
        costUsd: 0,
        costCallIds: [],
        tokenUsage: { input: 0, output: 0 },
        durationMs: 1,
        seed: 42,
        cached: false,
      },
    ],
    aggregates: {
      byJudge: {},
      byScenario: {},
      cost: {
        totalCalls: 0,
        pendingCalls: 0,
        unresolvedCalls: 0,
        reservedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalCostUsd: 0,
        byChannel: [],
        unpricedModels: [],
        fullyPriced: true,
        usageComplete: true,
        accountingComplete: true,
        incompleteReasons: [],
      },
      cellsExecuted: 1,
      cellsSkipped: 0,
      cellsCached: 0,
      cellsFailed: 0,
    },
    runDir,
    artifactsByPath: {},
    scenarios: [testScenarioIdentity],
  }
}

function measuredCandidate(
  surface: string,
  parent: string,
  parentComposite: number,
  composite: number,
): GenerationCandidate {
  return {
    surfaceHash: surfaceHash(surface),
    composite,
    ci95: [composite, composite],
    parentSurfaceHash: surfaceHash(parent),
    parentComposite,
    observedDeltaFromParent: composite - parentComposite,
    eligibleForPromotion: true,
    coverage: { expectedCells: 1, scorableCells: 1, unscorableCells: [] },
    dimensions: {},
    scenarios: [],
  }
}

function args(): BuildLoopProvenanceArgs<unknown, TestScenario> {
  const candidate = measuredCandidate('CANDIDATE', 'BASELINE', 0.4, 0.6)
  const baselineCampaign = campaign(0.4, '/provenance-integrity/search-baseline')
  const candidateCampaign = campaign(0.6, '/provenance-integrity/search-candidate')
  return {
    runId: 'provenance-integrity',
    runDir: '/provenance-integrity',
    timestamp: '2026-07-13T00:00:00.000Z',
    baselineSurface: 'BASELINE',
    winnerSurface: 'CANDIDATE',
    baselineSearchCampaign: baselineCampaign,
    generations: [
      {
        generationIndex: 0,
        candidates: [candidate],
        promoted: [candidate.surfaceHash],
        surfaces: [
          {
            surfaceHash: candidate.surfaceHash,
            surface: 'CANDIDATE',
            campaign: candidateCampaign,
          },
        ],
      },
    ],
    gate: { decision: 'hold', reasons: [], contributingGates: [] },
    baselineOnHoldout: campaign(0.4, '/provenance-integrity/holdout-baseline'),
    winnerOnHoldout: campaign(0.6, '/provenance-integrity/holdout-winner'),
    costReceipts: [],
    totalCostUsd: 0,
    totalDurationMs: 1,
  }
}

describe('loop provenance measurement integrity', () => {
  it('retains an internally recomputable parent-to-child measurement', () => {
    const record = buildLoopProvenanceRecord(args())
    expect(record.schema).toBe('tangle.loop-provenance')
    expect(record.candidates[0]).toMatchObject({
      parentSurfaceHash: surfaceHash('BASELINE'),
      parentComposite: 0.4,
      composite: 0.6,
      promoted: true,
    })
    expect(record.candidates[0]!.observedDeltaFromParent).toBeCloseTo(0.2, 12)
  })

  it('rejects a finite but invented improvement delta', () => {
    const input = args()
    input.generations[0]!.candidates[0]!.observedDeltaFromParent = 0.9
    expect(() => buildLoopProvenanceRecord(input)).toThrow(
      /observed delta does not match measured scores/,
    )
  })

  it('rejects a candidate attributed to the wrong parent score', () => {
    const input = args()
    input.generations[0]!.candidates[0]!.parentComposite = 0.3
    expect(() => buildLoopProvenanceRecord(input)).toThrow(
      /parentComposite does not match the incumbent/,
    )
  })

  it('rejects coverage counts that omit an unscorable designed cell', () => {
    const input = args()
    input.generations[0]!.candidates[0]!.coverage = {
      expectedCells: 2,
      scorableCells: 1,
      unscorableCells: [],
    }
    input.generations[0]!.candidates[0]!.eligibleForPromotion = false
    delete input.generations[0]!.candidates[0]!.observedDeltaFromParent
    expect(() => buildLoopProvenanceRecord(input)).toThrow(
      /coverage counts do not match its failures/,
    )
  })

  it('rejects a candidate hash that does not identify the recorded surface bytes', () => {
    const input = args()
    input.generations[0]!.surfaces[0]!.surface = 'DIFFERENT BYTES'
    expect(() => buildLoopProvenanceRecord(input)).toThrow(
      /surface hash does not match its surface bytes/,
    )
  })

  it('rejects duplicate candidate identities', () => {
    const input = args()
    input.generations[0]!.candidates.push({ ...input.generations[0]!.candidates[0]! })
    expect(() => buildLoopProvenanceRecord(input)).toThrow(/duplicate candidate surface hash/)
  })

  it('rejects skipped and empty generation records', () => {
    const skipped = args()
    skipped.generations[0]!.generationIndex = 1
    expect(() => buildLoopProvenanceRecord(skipped)).toThrow(/contiguous integers starting at zero/)

    const empty = args()
    empty.generations[0] = {
      generationIndex: 0,
      candidates: [],
      promoted: [],
      surfaces: [],
    }
    empty.winnerSurface = empty.baselineSurface
    expect(() => buildLoopProvenanceRecord(empty)).toThrow(/must contain a candidate/)
  })

  it('chains generation two to the measured winner of generation one', () => {
    const input = args()
    const second = measuredCandidate('SECOND', 'CANDIDATE', 0.6, 0.7)
    input.winnerSurface = 'SECOND'
    input.generations.push({
      generationIndex: 1,
      candidates: [second],
      promoted: [second.surfaceHash],
      surfaces: [
        {
          surfaceHash: second.surfaceHash,
          surface: 'SECOND',
          campaign: campaign(0.7, '/provenance-integrity/search-second'),
        },
      ],
    })
    expect(
      buildLoopProvenanceRecord(input).candidates.map((candidate) => candidate.promoted),
    ).toEqual([true, true])

    second.parentSurfaceHash = surfaceHash('BASELINE')
    expect(() => buildLoopProvenanceRecord(input)).toThrow(/parent does not match the incumbent/)
  })

  it('rejects gate details that JSON serialization would silently change', () => {
    const input = args()
    input.gate.contributingGates = [
      { name: 'strict-detail', status: 'pass', detail: { score: Number.NaN } },
    ]
    expect(() => buildLoopProvenanceRecord(input)).toThrow(/gate detail must be canonical JSON/)

    input.gate.contributingGates[0]!.detail = { omitted: undefined }
    expect(() => buildLoopProvenanceRecord(input)).toThrow(/gate detail must be canonical JSON/)
  })

  it.each<GateDecision>(['hold', 'need_more_work', 'model_ceiling', 'arch_ceiling'])(
    'records %s as a successful decision rather than an execution error',
    (decision) => {
      const input = args()
      input.gate.decision = decision
      const record = buildLoopProvenanceRecord(input)
      const spans = loopProvenanceSpans(record)

      expect(spans.find((span) => span.name === 'improvement-loop')?.status).toEqual({
        code: 'OK',
      })
      expect(spans.find((span) => span.name === 'gate-decision')?.status).toEqual({
        code: 'OK',
      })

      const [run] = fromOtelSpans({ spans })
      expect(run).toMatchObject({
        terminalOutcome: 'succeeded',
        outcome: {
          raw: {
            error_span_count: 0,
            execution_error_count: 0,
            process_error_count: 0,
            unclassified_error_count: 0,
          },
        },
      })
    },
  )

  it('binds failure stage and judge identity into the campaign digest', () => {
    const dispatchFailure = campaign(0.5, '/same-run')
    dispatchFailure.cells[0]!.error = 'same failure'
    dispatchFailure.cells[0]!.errorStage = 'dispatch'

    const judgeFailure = campaign(0.5, '/same-run')
    judgeFailure.cells[0]!.error = 'same failure'
    judgeFailure.cells[0]!.errorStage = 'judge'
    judgeFailure.cells[0]!.errorJudge = 'judge-a'

    const otherJudgeFailure = campaign(0.5, '/same-run')
    otherJudgeFailure.cells[0]!.error = 'same failure'
    otherJudgeFailure.cells[0]!.errorStage = 'judge'
    otherJudgeFailure.cells[0]!.errorJudge = 'judge-b'

    expect(campaignMeasurementDigest(dispatchFailure)).not.toBe(
      campaignMeasurementDigest(judgeFailure),
    )
    expect(campaignMeasurementDigest(judgeFailure)).not.toBe(
      campaignMeasurementDigest(otherJudgeFailure),
    )
  })

  it('preserves tri-state check status without a boolean alias', () => {
    const input = args()
    input.gate.contributingGates = [
      { name: 'measured', status: 'pass', detail: {} },
      { name: 'missing', status: 'not_evaluated', detail: { reason: 'no input' } },
    ]

    const checks = buildLoopProvenanceRecord(input).gate.contributingGates
    expect(checks).toEqual(input.gate.contributingGates)
    expect(checks.every((check) => !('passed' in check))).toBe(true)
  })

  it('rejects obsolete boolean contributions at build and persisted-read boundaries', () => {
    const input = args()
    input.gate.contributingGates = [{ name: 'legacy', passed: true, detail: {} } as never]
    expect(() => buildLoopProvenanceRecord(input)).toThrow(/must have status/)

    const current = buildLoopProvenanceRecord(args())
    const { recordDigest: _currentDigest, ...currentWithoutDigest } = current
    const legacyWithoutDigest = {
      ...currentWithoutDigest,
      gate: {
        ...currentWithoutDigest.gate,
        contributingGates: [{ name: 'legacy', passed: true, detail: {} }],
      },
    }
    const legacy = {
      ...legacyWithoutDigest,
      recordDigest: canonicalDigest(legacyWithoutDigest),
    }

    expect(() => verifyLoopProvenanceRecord(legacy as never)).toThrow(/must have status/)
  })
})
