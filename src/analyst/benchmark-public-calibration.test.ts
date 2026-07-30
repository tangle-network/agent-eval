import { describe, expect, it } from 'vitest'
import { runAnalystBenchmark } from './benchmark'
import { codeTraceBenchCase, codeTracerPredictionsToFindings } from './benchmark-datasets'
import { summarizeCodeTraceCalibration } from './benchmark-public-calibration'

describe('summarizeCodeTraceCalibration', () => {
  it('separates a correct analyst from a plausible wrong analyst and an empty baseline', async () => {
    const positive = codeTraceBenchCase(
      {
        traj_id: 'positive',
        task_name: 'task-positive',
        agent: 'agent',
        model: 'model',
        solved: false,
        step_count: 3,
        incorrect_stages: [{ stage_id: 1, incorrect_step_ids: [2] }],
      },
      { trajectoryId: 'positive' },
    )
    const trustedNegative = codeTraceBenchCase(
      {
        traj_id: 'trusted-negative',
        task_name: 'task-negative',
        agent: 'agent',
        model: 'model',
        solved: true,
        step_count: 3,
        incorrect_stages: [],
      },
      { trajectoryId: 'trusted-negative' },
    )
    const result = await runAnalystBenchmark({
      cases: [positive, trustedNegative],
      runners: [
        {
          id: 'correct',
          analyze: ({ trajectoryId }) => ({
            findings:
              trajectoryId === 'positive'
                ? codeTracerPredictionsToFindings(
                    trajectoryId,
                    [{ stage_id: 1, incorrect_step_ids: [2] }],
                    { stepCount: 3 },
                  )
                : [],
          }),
        },
        {
          id: 'plausible-wrong',
          analyze: ({ trajectoryId }) => ({
            findings: codeTracerPredictionsToFindings(
              trajectoryId,
              [{ stage_id: 1, incorrect_step_ids: [1] }],
              { stepCount: 3 },
            ),
          }),
        },
        { id: 'empty', analyze: () => ({ findings: [] }) },
      ],
    })

    expect(summarizeCodeTraceCalibration(result).runners).toEqual([
      expect.objectContaining({
        runnerId: 'correct',
        precision: 1,
        recall: 1,
        f1: 1,
        officialAllRowF1: 0.5,
        officialAllRowRuns: 2,
        trustedNegativeFalsePositiveRate: 0,
      }),
      expect.objectContaining({
        runnerId: 'plausible-wrong',
        precision: 0,
        recall: 0,
        f1: 0,
        officialAllRowF1: 0,
        officialAllRowRuns: 2,
        trustedNegativeFalsePositiveRate: 1,
      }),
      expect.objectContaining({
        runnerId: 'empty',
        precision: 0,
        recall: 0,
        f1: 0,
        officialAllRowF1: 0,
        officialAllRowRuns: 2,
        trustedNegativeFalsePositiveRate: 0,
      }),
    ])
  })

  it('scores an empty baseline as zero and excludes failed label-empty cases from clean controls', async () => {
    const result = await runAnalystBenchmark({
      cases: [
        codeTraceBenchCase(
          {
            traj_id: 'positive',
            task_name: 'task-positive',
            agent: 'agent',
            model: 'model',
            solved: false,
            step_count: 3,
            incorrect_stages: [{ stage_id: 1, incorrect_step_ids: [2] }],
          },
          null,
        ),
        codeTraceBenchCase(
          {
            traj_id: 'trusted-negative',
            task_name: 'task-negative',
            agent: 'agent',
            model: 'model',
            solved: true,
            step_count: 3,
            incorrect_stages: [],
          },
          null,
        ),
        codeTraceBenchCase(
          {
            traj_id: 'unlabeled',
            task_name: 'task-unlabeled',
            agent: 'agent',
            model: 'model',
            solved: false,
            step_count: 3,
            incorrect_stages: [],
          },
          null,
        ),
      ],
      runners: [{ id: 'empty', analyze: () => ({ findings: [] }) }],
    })

    expect(summarizeCodeTraceCalibration(result).runners[0]).toMatchObject({
      selectedRuns: 2,
      positiveRuns: 1,
      trustedNegativeRuns: 1,
      unlabeledRuns: 1,
      failedLabelEmptyRuns: 1,
      unknownLabelEmptyRuns: 0,
      expectedIncorrectSteps: 1,
      predictedIncorrectSteps: 0,
      matchedIncorrectSteps: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      officialAllRowF1: 0,
      officialAllRowRuns: 3,
      trustedNegativeFalsePositiveRate: 0,
      unlabeledPredictionRate: 0,
      unlabeledFailureRate: 0,
    })
  })
})
