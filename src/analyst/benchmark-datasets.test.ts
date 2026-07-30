import { describe, expect, it } from 'vitest'
import { scoreAnalystFindings } from './benchmark'
import {
  agentRxBenchmarkCase,
  agentRxPredictionsToFindings,
  codeTraceBenchCase,
  codeTracerPredictionsToFindings,
  normalizeAgentRxCategory,
  normalizeBenchmarkLabel,
} from './benchmark-datasets'

describe('agentRxBenchmarkCase', () => {
  it('targets the published root-cause task by default', () => {
    const result = agentRxBenchmarkCase(
      {
        trajectory_id: 2,
        failures: [
          {
            failure_id: 1,
            step_number: 3,
            step_reason: 'Skipped authentication',
            failure_category: 'Instruction/Plan Adherence Failure',
          },
          {
            failure_id: 2,
            step_number: 7,
            step_reason: 'Misread the inventory count',
            failure_category: 'Misinterpretation of Tool Output',
          },
        ],
        root_cause: { failure_id: 2 },
        num_failures: 2,
      },
      { trace: 'trajectory-2' },
      { stepCount: 8 },
    )

    expect(result.id).toBe('agentrx:2')
    expect(result.expectedIssues).toEqual([
      expect.objectContaining({
        id: '2',
        areas: ['misinterpretation-of-tool-output-handoff-failure'],
        criticalEvidence: [{ kind: 'span', uri: 'trace://2/span/step-7' }],
      }),
    ])
    expect(result.expectedIssues[0]).not.toHaveProperty('evidence')
    expect(result.labeledEvidence).toEqual([{ kind: 'span', uri: 'trace://2/span/step-7' }])
    expect(result.metadata).toMatchObject({ annotatedFailures: 2, target: 'root-cause' })
  })

  it('can score every annotated failure when explicitly requested', () => {
    const result = agentRxBenchmarkCase(
      {
        trajectory_id: 'all',
        failures: [
          {
            failure_id: 1,
            step_number: 1,
            step_reason: 'Skipped a step',
            failure_category: 'Instruction Adherence Failure',
          },
          {
            failure_id: 2,
            step_number: 2,
            step_reason: 'Endpoint failed',
            failure_category: 'System Failure',
          },
        ],
        root_cause_failure_id: 2,
      },
      null,
      { target: 'all-failures', stepCount: 2 },
    )

    expect(result.expectedIssues).toHaveLength(2)
    expect(result.expectedIssues[0]).toMatchObject({
      areas: ['instruction-plan-adherence-failure'],
      evidence: [{ kind: 'span', uri: 'trace://all/span/step-1' }],
    })
  })

  it('rejects a root cause that is absent from the failure list', () => {
    expect(() =>
      agentRxBenchmarkCase(
        {
          trajectory_id: 'bad',
          failures: [
            {
              failure_id: 'failure-1',
              step_number: 1,
              step_reason: 'failed',
              failure_category: 'System Failure',
            },
          ],
          root_cause_failure_id: 'missing',
        },
        null,
      ),
    ).toThrow(/root cause 'missing' is not in failures/)
  })

  it('rejects failure steps outside the supplied trajectory', () => {
    expect(() =>
      agentRxBenchmarkCase(
        {
          trajectory_id: 'bad-step',
          failures: [
            {
              failure_id: 'failure-1',
              step_number: 3,
              step_reason: 'failed',
              failure_category: 'System Failure',
            },
          ],
          root_cause_failure_id: 'failure-1',
        },
        null,
        { stepCount: 2 },
      ),
    ).toThrow(/beyond stepCount 2/)
  })
})

describe('codeTraceBenchCase', () => {
  it('uses the published incorrect-step metric by default and preserves clean cases', () => {
    const labeled = codeTraceBenchCase(
      {
        traj_id: 'run/1',
        agent: 'mini-SWE-agent',
        model: 'OpenAI/GPT-5',
        task_name: 'task-1',
        difficulty: 'hard',
        tags: '["debugging"]',
        solved: false,
        step_count: 25,
        incorrect_stages: JSON.stringify([
          { stage_id: 5, incorrect_step_ids: [24], unuseful_step_ids: [18, 19] },
        ]),
      },
      'trajectory',
    )

    expect(labeled.expectedIssues.map((issue) => issue.id)).toEqual(['incorrect:24'])
    expect(labeled.expectedIssues[0]?.evidence).toEqual([
      { kind: 'span', uri: 'trace://run%2F1/span/step-24' },
    ])
    expect(labeled.labeledEvidence).toEqual([{ kind: 'span', uri: 'trace://run%2F1/span/step-24' }])
    expect(labeled.tags).toContain('debugging')
    expect(labeled.metadata?.labelSet).toBe('incorrect-only')

    const clean = codeTraceBenchCase(
      {
        traj_id: 'clean',
        agent: 'OpenHands',
        model: 'DeepSeek/DeepSeek-V3.2',
        task_name: 'task-2',
        step_count: 3,
        incorrect_stages: [],
      },
      'trajectory',
    )
    expect(clean.expectedIssues).toEqual([])
    expect(clean.labeledEvidence).toEqual([])
  })

  it('scores a perfect official prediction as one when unuseful labels exist', () => {
    const labels = [
      {
        stage_id: 5,
        incorrect_step_ids: [24],
        unuseful_step_ids: [18, 19],
      },
    ]
    const testCase = codeTraceBenchCase(
      {
        traj_id: 'official',
        agent: 'mini-SWE-agent',
        model: 'OpenAI/GPT-5',
        task_name: 'task',
        step_count: 25,
        incorrect_stages: labels,
      },
      null,
    )
    const findings = codeTracerPredictionsToFindings('official', labels, {
      stepCount: 25,
      producedAt: '2026-07-29T00:00:00.000Z',
    })

    const score = scoreAnalystFindings(testCase, findings)
    expect(findings.map((finding) => finding.area)).toEqual(['incorrect'])
    expect(score.issueRecall).toBe(1)
    expect(score.findingPrecision).toBe(1)
    expect(score.f1).toBe(1)
  })

  it('includes unuseful labels only in the explicitly combined mode', () => {
    const labels = [
      {
        stage_id: 1,
        incorrect_step_ids: [4],
        unuseful_step_ids: [3],
      },
    ]
    const testCase = codeTraceBenchCase(
      {
        traj_id: 'combined',
        agent: 'agent',
        model: 'model',
        task_name: 'task',
        step_count: 4,
        incorrect_stages: labels,
      },
      null,
      { labelSet: 'incorrect-and-unuseful' },
    )
    const findings = codeTracerPredictionsToFindings('combined', labels, {
      labelSet: 'incorrect-and-unuseful',
      stepCount: 4,
    })

    expect(testCase.expectedIssues.map((issue) => issue.id)).toEqual(['incorrect:4', 'unuseful:3'])
    expect(findings.map((finding) => finding.area)).toEqual(['incorrect', 'unuseful'])
    expect(scoreAnalystFindings(testCase, findings).f1).toBe(1)
  })

  it('rejects labels outside the trajectory', () => {
    expect(() =>
      codeTraceBenchCase(
        {
          traj_id: 'bad',
          agent: 'agent',
          model: 'model',
          task_name: 'task',
          step_count: 2,
          incorrect_stages: [{ stage_id: 1, incorrect_step_ids: [3] }],
        },
        null,
      ),
    ).toThrow(/exceeds step_count 2/)
  })

  it('rejects unknown label modes instead of silently changing the metric', () => {
    expect(() =>
      codeTracerPredictionsToFindings('bad-mode', [], {
        labelSet: 'combined' as never,
      }),
    ).toThrow(/labelSet must be/)
  })
})

describe('upstream prediction adapters', () => {
  it('maps the AgentRx Report.to_dict shape and keeps category and root step separate', () => {
    const findings = agentRxPredictionsToFindings(
      'trajectory',
      {
        task_id: 'trajectory',
        failures: [
          {
            task_id: 'trajectory',
            failure_case: 4,
            step_number: 7,
            description: 'The tool output was misread.',
            checklist_reasoning: 'The conclusion contradicted the tool result.',
          },
        ],
        num_judges: 1,
        trajectory_length: 8,
      },
      { producedAt: '2026-07-29T00:00:00.000Z', stepCount: 8 },
    )

    expect(findings).toEqual([
      expect.objectContaining({
        analyst_id: 'agentrx',
        area: 'misinterpretation-of-tool-output-handoff-failure',
        subject: 'root-cause',
        rationale: 'The tool output was misread.',
        evidence_refs: [{ kind: 'span', uri: 'trace://trajectory/span/step-7' }],
        metadata: expect.objectContaining({
          failure_case: 4,
          judge_votes: 1,
          category_agreement: 1,
          checklist_reasoning: 'The conclusion contradicted the tool result.',
        }),
      }),
    ])
  })

  it('reduces repeated AgentRx judge votes to the upstream consensus prediction', () => {
    const testCase = agentRxBenchmarkCase(
      {
        trajectory_id: 'consensus',
        failures: [
          {
            failure_id: 'root',
            step_number: 7,
            step_reason: 'The tool output was misread.',
            failure_category: 'Misinterpretation of Tool Output',
          },
        ],
        root_cause_failure_id: 'root',
      },
      null,
      { stepCount: 8 },
    )
    const findings = agentRxPredictionsToFindings(
      'consensus',
      {
        task_id: 'consensus',
        failures: [
          { failure_case: 4, step_number: 6 },
          { failure_case: 4, step_number: 7 },
          { failure_case: 4, step_number: 8 },
        ],
        num_judges: 3,
        most_common_failure: '4',
        modes: ['4'],
        step_mean: 7,
      },
      { stepCount: 8 },
    )

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      area: 'misinterpretation-of-tool-output-handoff-failure',
      evidence_refs: [{ uri: 'trace://consensus/span/step-7' }],
      metadata: {
        judge_votes: 3,
        consensus_votes: 3,
        category_agreement: 1,
      },
    })
    expect(scoreAnalystFindings(testCase, findings).f1).toBe(1)
  })

  it('uses Python round-half-to-even for the upstream mean-step prediction', () => {
    const findings = agentRxPredictionsToFindings('rounding', {
      failures: [
        { failure_case: 4, step_number: 2 },
        { failure_case: 4, step_number: 3 },
      ],
      most_common_failure: '4',
      modes: ['4'],
      step_mean: 2.5,
    })

    expect(findings[0]?.evidence_refs).toEqual([
      { kind: 'span', uri: 'trace://rounding/span/step-2' },
    ])
  })

  it('treats FailureCase 0 as no finding for reports and direct arrays', () => {
    const noError = {
      task_id: 'clean',
      failure_case: 0,
      description: 'No failure found.',
      step_number: 0,
      checklist_reasoning: null,
    }
    expect(
      agentRxPredictionsToFindings('clean', {
        task_id: 'clean',
        failures: [noError],
        num_judges: 1,
      }),
    ).toEqual([])
    expect(agentRxPredictionsToFindings('clean', [noError])).toEqual([])
  })

  it('preserves every positive AgentRx taxonomy mapping', () => {
    const expectedAreas = [
      'instruction-plan-adherence-failure',
      'invention-of-new-information',
      'invalid-invocation',
      'misinterpretation-of-tool-output-handoff-failure',
      'intent-plan-misalignment',
      'underspecified-user-intent',
      'intent-not-supported',
      'guardrails-triggered',
      'system-failure',
      'inconclusive',
    ]
    const findings = expectedAreas.map(
      (_, index) =>
        agentRxPredictionsToFindings(
          `taxonomy-${index + 1}`,
          [{ failure_case: index + 1, step_number: index + 1 }],
          { stepCount: 10 },
        )[0],
    )

    expect(findings.map((finding) => finding?.area)).toEqual(expectedAreas)
    expect(findings.map((finding) => finding?.metadata?.failure_case)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
  })

  it('rejects malformed AgentRx reports instead of treating them as clean', () => {
    const malformed: Array<[unknown, RegExp]> = [
      [{}, /must contain failures/],
      [{ failures: [] }, /must contain a judge prediction/],
      [{ failures: 'none' }, /failures must be an array/],
      [{ failures: [null] }, /failures\[0\] must be an object/],
      [{ failures: [{ failure_case: 0, step_number: 1 }] }, /must be 0/],
      [{ failures: [{ failure_case: 1, step_number: 0 }] }, /must be positive/],
      [{ failures: [{ failure_case: 11, step_number: 1 }] }, /outside 0-10/],
      [
        { failures: [{ failure_case: 'made up', step_number: 1 }] },
        /not an AgentRx taxonomy label/,
      ],
      [{ failures: [{ failure_case: 1, step_number: 1 }], num_judges: 2 }, /declares 2 judges/],
      [
        {
          task_id: 'other',
          failures: [{ failure_case: 1, step_number: 1 }],
        },
        /does not match trajectory id/,
      ],
      [
        {
          failures: [
            { failure_case: 1, step_number: 1 },
            { failure_case: 1, step_number: 2 },
            { failure_case: 2, step_number: 3 },
          ],
          most_common_failure: '2',
        },
        /most_common_failure disagrees/,
      ],
      [
        {
          failures: [
            { failure_case: 1, step_number: 1 },
            { failure_case: 2, step_number: 2 },
          ],
          modes: ['1'],
        },
        /modes disagrees/,
      ],
      [
        {
          failures: [
            { failure_case: 1, step_number: 1 },
            { failure_case: 2, step_number: 2 },
          ],
          modes: ['1', '1', '2'],
        },
        /modes contains duplicates/,
      ],
      [
        {
          failures: [
            { failure_case: 1, step_number: 1 },
            { failure_case: 1, step_number: 3 },
          ],
          step_mean: 3,
        },
        /step_mean disagrees/,
      ],
      [
        {
          failures: [
            { failure_case: 1, step_number: 1 },
            { failure_case: 1, step_number: 4 },
          ],
          trajectory_length: 3,
        },
        /step 4 exceeds stepCount 3/,
      ],
    ]

    for (const [output, message] of malformed) {
      expect(() => agentRxPredictionsToFindings('trajectory', output)).toThrow(message)
    }
  })

  it('maps CodeTracer labels and rejects duplicate or out-of-range steps', () => {
    const findings = codeTracerPredictionsToFindings(
      'run/1',
      [
        {
          stage_id: 2,
          incorrect_step_ids: [4],
          unuseful_step_ids: [3],
          reasoning: 'The edit was wrong.',
        },
      ],
      {
        producedAt: '2026-07-29T00:00:00.000Z',
        stepCount: 4,
        labelSet: 'incorrect-and-unuseful',
      },
    )

    expect(findings.map((finding) => [finding.area, finding.evidence_refs[0]?.uri])).toEqual([
      ['incorrect', 'trace://run%2F1/span/step-4'],
      ['unuseful', 'trace://run%2F1/span/step-3'],
    ])
    expect(() =>
      codeTracerPredictionsToFindings('bad', [{ stage_id: 1, incorrect_step_ids: [2, 2] }], {
        stepCount: 2,
      }),
    ).toThrow(/repeats label/)
    expect(() =>
      codeTracerPredictionsToFindings('bad', [{ stage_id: 1, incorrect_step_ids: [3] }], {
        stepCount: 2,
      }),
    ).toThrow(/exceeds stepCount 2/)
  })
})

it('normalizes benchmark categories deterministically', () => {
  expect(normalizeBenchmarkLabel(' Invention of New Information ')).toBe(
    'invention-of-new-information',
  )
  expect(normalizeAgentRxCategory('Instruction Adherence Failure')).toBe(
    'instruction-plan-adherence-failure',
  )
})
