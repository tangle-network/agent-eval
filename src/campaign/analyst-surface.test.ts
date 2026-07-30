import { describe, expect, it } from 'vitest'
import { makeFinding } from '../analyst/types'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import {
  buildTraceAnalystSurfaceDispatch,
  type TraceAnalystScenario,
  traceAnalystQualityJudge,
} from './analyst-surface'
import type { DispatchContext } from './types'

const signal = new AbortController().signal
const context = { cellId: 'cell-1', signal } as DispatchContext
const traceStore = {} as TraceAnalysisStore
const failureUri = 'trace://failed/span/tool-3'
const scenario: TraceAnalystScenario = {
  id: 'failed-command',
  kind: 'trace-analyst',
  traceStore,
  labelState: 'positive',
  expectedIssues: [
    {
      id: 'repeated-command',
      subjects: ['failure-mode:repeated-command'],
      evidence: [{ kind: 'span', uri: failureUri }],
      criticalEvidence: [{ kind: 'span', uri: failureUri }],
    },
  ],
  labeledEvidence: [
    { kind: 'span', uri: failureUri },
    { kind: 'span', uri: 'trace://failed/span/tool-1' },
  ],
}

function finding(input: { subject?: string; uri: string; claim?: string }) {
  return makeFinding({
    analyst_id: 'test',
    area: 'failure-mode',
    subject: input.subject,
    claim: input.claim ?? 'The command failed repeatedly',
    severity: 'high',
    confidence: 1,
    evidence_refs: [{ kind: 'span', uri: input.uri }],
  })
}

describe('buildTraceAnalystSurfaceDispatch', () => {
  it('passes the candidate prompt and trace store to the configured implementation', async () => {
    const seen: unknown[] = []
    const dispatch = buildTraceAnalystSurfaceDispatch({
      async analyze(input) {
        seen.push(input)
        return { findings: [] }
      },
    })
    await dispatch('Inspect failed tool calls.', scenario, context)
    expect(seen).toEqual([
      {
        actorDescription: 'Inspect failed tool calls.',
        traceStore,
        runId: 'cell-1:failed-command',
        signal,
      },
    ])
  })

  it('rejects code and component surfaces instead of silently stringifying them', async () => {
    const dispatch = buildTraceAnalystSurfaceDispatch({
      async analyze() {
        return { findings: [] }
      },
    })
    await expect(
      dispatch({ kind: 'code', worktreeRef: 'x' } as never, scenario, context),
    ).rejects.toThrow(/requires a string prompt/)
  })
})

describe('traceAnalystQualityJudge', () => {
  const judge = traceAnalystQualityJudge()

  it('scores issue identity, causal-step location, and evidence without string cues', async () => {
    const result = await judge.score({
      artifact: {
        findings: [finding({ subject: 'failure-mode:repeated-command', uri: failureUri })],
      },
      scenario,
      signal,
    })
    expect(result.composite).toBe(1)
    expect(result.dimensions).toMatchObject({
      issue_recall: 1,
      finding_precision: 1,
      critical_step_accuracy: 1,
      citation_coverage: 1,
      citation_label_agreement: 1,
    })
  })

  it('penalizes unsupported findings and invalid citations', async () => {
    const result = await judge.score({
      artifact: {
        findings: [
          finding({ subject: 'failure-mode:repeated-command', uri: failureUri }),
          finding({
            subject: 'failure-mode:network-timeout',
            uri: 'trace://failed/span/does-not-exist',
            claim: 'A network timeout occurred',
          }),
        ],
      },
      scenario,
      signal,
    })
    expect(result.dimensions.issue_recall).toBe(1)
    expect(result.dimensions.finding_precision).toBe(0.5)
    expect(result.dimensions.citation_label_agreement).toBe(0.5)
    expect(result.composite).toBeCloseTo(5 / 6)
  })

  it('weights issue identity and causal-step location independently', async () => {
    const independentScenario: TraceAnalystScenario = {
      ...scenario,
      expectedIssues: [
        {
          id: 'repeated-command',
          subjects: ['failure-mode:repeated-command'],
          criticalEvidence: [{ kind: 'span', uri: failureUri }],
        },
      ],
    }
    const rightIssueWrongStep = await judge.score({
      artifact: {
        findings: [
          finding({
            subject: 'failure-mode:repeated-command',
            uri: 'trace://failed/span/tool-1',
          }),
        ],
      },
      scenario: independentScenario,
      signal,
    })
    const wrongIssueRightStep = await judge.score({
      artifact: {
        findings: [finding({ subject: 'failure-mode:network-timeout', uri: failureUri })],
      },
      scenario: independentScenario,
      signal,
    })

    expect(rightIssueWrongStep.dimensions).toMatchObject({
      f1: 1,
      critical_step_accuracy: 0,
    })
    expect(rightIssueWrongStep.composite).toBe(0.5)
    expect(wrongIssueRightStep.dimensions).toMatchObject({
      f1: 0,
      critical_step_accuracy: 1,
    })
    expect(wrongIssueRightStep.composite).toBe(0.5)
  })

  it('treats findings on a clean trace as false positives', async () => {
    const clean = {
      ...scenario,
      id: 'clean',
      labelState: 'trusted-negative' as const,
      expectedIssues: [],
    }
    const result = await judge.score({
      artifact: {
        findings: [finding({ uri: 'trace://failed/span/tool-1' })],
      },
      scenario: clean,
      signal,
    })
    expect(result.composite).toBe(0)
    expect(result.dimensions.clean).toBe(0)
  })

  it('excludes unlabeled traces from quality scoring', async () => {
    const unlabeled = {
      ...scenario,
      id: 'unlabeled',
      labelState: 'unlabeled' as const,
      expectedIssues: [],
      labeledEvidence: undefined,
    }

    expect(judge.appliesTo?.(unlabeled)).toBe(false)
    expect(() =>
      judge.score({
        artifact: { findings: [] },
        scenario: unlabeled,
        signal,
      }),
    ).toThrow(/has no quality labels/)
  })
})
