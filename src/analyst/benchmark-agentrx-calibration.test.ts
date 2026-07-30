import { describe, expect, it } from 'vitest'
import { runAnalystBenchmark } from './benchmark'
import {
  renderAgentRxCalibrationMarkdown,
  summarizeAgentRxCalibration,
} from './benchmark-agentrx-calibration'
import { agentRxBenchmarkCase, roundAgentRxStep } from './benchmark-datasets'
import { makeFinding } from './types'

describe('AgentRx published metrics', () => {
  it('matches Python rounding, raw distance, tolerance, normalization, and category metrics', async () => {
    const testCase = agentRxBenchmarkCase(
      {
        trajectory_id: 'case-1',
        failures: [
          {
            failure_id: 'earliest',
            step_number: 2,
            step_reason: 'The plan diverged.',
            failure_category: 'Instruction/Plan Adherence Failure',
          },
          {
            failure_id: 'root',
            step_number: 5,
            step_reason: 'The environment failed.',
            failure_category: 'System Failure',
          },
          {
            failure_id: 'terminal',
            step_number: 8,
            step_reason: 'The tool output was misread.',
            failure_category: 'Misinterpretation of Tool Output',
          },
        ],
        root_cause_failure_id: 'root',
      },
      'case-1',
      { stepCount: 10 },
    )
    const result = await runAnalystBenchmark({
      cases: [testCase],
      repetitions: 2,
      runners: [
        {
          id: 'candidate',
          analyze(_input, context) {
            return {
              findings:
                context.repetition === 0
                  ? [
                      makeFinding({
                        analyst_id: 'candidate',
                        area: 'system-failure',
                        subject: 'root-cause',
                        claim: 'The environment failed.',
                        severity: 'high',
                        confidence: 1,
                        evidence_refs: [{ kind: 'span', uri: 'trace://case-1/span/step-4' }],
                        metadata: { step: 4, step_mean: 4.5 },
                      }),
                    ]
                  : [],
            }
          },
        },
      ],
    })

    const summary = summarizeAgentRxCalibration(result, 'f228165b')
    expect(summary.runners[0]).toMatchObject({
      selectedRuns: 2,
      completedRuns: 2,
      failedRuns: 0,
      predictedRuns: 1,
      missingPredictionRuns: 1,
      exactStepAccuracy: 0,
      stepAccuracyWithin1: 0.5,
      stepAccuracyWithin5: 0.5,
      meanStepDistance: 0.5,
      normalizedMeanStepDistance: 0.05,
      normalizedDistanceRuns: 1,
      normalizedDistanceUnknownRuns: 1,
      rootCauseCategoryAccuracy: 0.5,
      anyFailureCategoryAccuracy: 0.5,
      earliestFailureCategoryAccuracy: 0,
      terminalFailureCategoryAccuracy: 0,
    })
    expect(renderAgentRxCalibrationMarkdown(summary)).toContain('Within 5')
  })

  it('uses Python half-to-even rounding', () => {
    expect(roundAgentRxStep(4.5)).toBe(4)
    expect(roundAgentRxStep(5.5)).toBe(6)
    expect(roundAgentRxStep(5.49)).toBe(5)
  })
})
