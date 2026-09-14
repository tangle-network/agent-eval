import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as campaign from './campaign/index'
import {
  defineAgentEval,
  type GateDecision,
  type JudgeScore,
  type Scenario,
} from './contract/index'
import { defineEvaluationClaim, summarizeEvaluationUnits } from './experiment/index'
import type * as root from './index'
import {
  auditEvaluator,
  calibrateJudgeContinuous,
  type EvaluatorAuditObservation,
  positionalBias,
  selfPreference,
} from './meta-eval/index'

describe('public evaluation types', () => {
  it('lets root types flow through the contract evaluation without adapters', async () => {
    expectTypeOf<root.Scenario>().toEqualTypeOf<Scenario>()
    expectTypeOf<root.JudgeScore>().toEqualTypeOf<JudgeScore>()
    expectTypeOf<root.GateDecision>().toEqualTypeOf<GateDecision>()
    expectTypeOf<campaign.Scenario>().toEqualTypeOf<Scenario>()
    expectTypeOf<campaign.JudgeScore>().toEqualTypeOf<JudgeScore>()
    expectTypeOf<campaign.GateDecision>().toEqualTypeOf<GateDecision>()

    const scenario: root.Scenario = { id: 'ticket', kind: 'support' }
    const judgeScore: root.JudgeScore = { dimensions: { resolved: 1 }, composite: 1, notes: '' }
    const kit = defineAgentEval({
      scenarios: [scenario],
      baselineSurface: 'Resolve the ticket.',
      agent: async () => 'Resolved.',
      judge: {
        name: 'resolved',
        dimensions: [{ key: 'resolved', description: 'The ticket is resolved.' }],
        score: () => judgeScore,
      },
      expectUsage: 'off',
    })
    const measured = await kit.evaluate()
    expect(measured.aggregates.byJudge.resolved?.mean).toBe(1)
  })

  it('keeps the distinct product judging types explicit beside their functions', () => {
    expectTypeOf<root.JudgeInput['scenario']>().toEqualTypeOf<root.ProductScenario>()
    expectTypeOf<Awaited<ReturnType<root.JudgeFn>>>().toEqualTypeOf<root.DimensionJudgeScore[]>()
    expectTypeOf<
      ReturnType<root.HeldOutGate['evaluate']>
    >().toEqualTypeOf<root.HeldOutGateDecision>()
  })

  it('uses the experiment subpath to distinguish variants from independent tasks', () => {
    const claim = defineEvaluationClaim({
      use: 'comparison',
      population: { id: 'support', description: 'Support incidents.' },
      samplingFrame: 'Incident queue sampled before search.',
      independentUnit: 'incidentId',
      generalization: 'new-units',
      minimumEffect: 0.05,
    })
    const summary = summarizeEvaluationUnits(claim, [
      { id: 'first-variant', incidentId: 'incident-1' },
      { id: 'second-variant', incidentId: 'incident-1' },
      { id: 'third-variant', incidentId: 'incident-2' },
    ])
    expect(summary).toMatchObject({ observations: 3, independentUnits: 2 })
  })

  it('exposes calibration, bias diagnostics, and admission together', () => {
    expect(typeof calibrateJudgeContinuous).toBe('function')
    expect(
      positionalBias([
        { itemId: 'same-output', score: 0.9, positionOfAInput: 'first' },
        { itemId: 'same-output', score: 0.4, positionOfAInput: 'second' },
      ]),
    ).toEqual({ avgDelta: 0.5, n: 1 })
    expect(
      selfPreference([
        { score: 1, inFamily: true },
        { score: 0, inFamily: false },
      ]),
    ).toMatchObject({ deltaMean: 1, n: 2 })

    const observations: EvaluatorAuditObservation[] = [
      {
        id: 'unknown',
        independentUnitId: 'one-incident',
        evidenceRef: 'artifact://unknown',
        expected: 'reject',
        observed: 'unknown',
        exposure: 'fresh',
      },
    ]
    const report = auditEvaluator({
      evaluatorDigest: `sha256:${'1'.repeat(64)}`,
      population: 'Support outputs.',
      samplingFrame: 'Independent incident samples.',
      authority: {
        evaluatorAuthorId: 'author',
        auditorId: 'auditor',
        independenceEvidenceRef: 'artifact://access-policy',
      },
      policy: { confidence: 0.95, maxFalseAcceptanceRate: 0.1, maxFalseRejectionRate: 0.1 },
      observations,
    })
    expect(report.verdict).toBe('inconclusive')
    expect(report.coverage.unknownCases).toBe(1)
    expect(report.falseAcceptance.errorRate).toBeNull()
  })
})
