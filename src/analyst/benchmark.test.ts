import { describe, expect, it } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import {
  type AnalystBenchmarkCase,
  type AnalystBenchmarkRunner,
  runAnalystBenchmark,
  scoreAnalystFindings,
  traceStoreEvidenceResolver,
} from './benchmark'
import { makeFinding } from './types'

const root = 'trace://run/span/root'
const failed = 'trace://run/span/failed-tool'
const corrected = 'trace://run/span/corrected-output'

function finding(input: { subject: string; evidence: string[]; idBasis?: string }) {
  return makeFinding({
    analyst_id: 'test',
    area: 'failure-mode',
    subject: input.subject,
    claim: `Finding for ${input.subject}`,
    id_basis: input.idBasis,
    severity: 'high',
    confidence: 1,
    evidence_refs: input.evidence.map((uri) => ({ kind: 'span' as const, uri })),
  })
}

const badCase: AnalystBenchmarkCase<string> = {
  id: 'known-bad',
  input: 'bad',
  expectedIssues: [
    {
      id: 'tool-failure',
      subjects: ['failure-mode:tool-failure'],
      evidence: [{ kind: 'span', uri: failed }],
      criticalEvidence: [{ kind: 'span', uri: failed }],
    },
    {
      id: 'unsupported-claim',
      subjects: ['failure-mode:unsupported-claim'],
      evidence: [{ kind: 'span', uri: corrected }],
    },
  ],
  labeledEvidence: [
    { kind: 'span', uri: root },
    { kind: 'span', uri: failed },
    { kind: 'span', uri: corrected },
  ],
  tags: ['failed', 'tool-use'],
  metadata: { source: 'fixture' },
}

const cleanCase: AnalystBenchmarkCase<string> = {
  id: 'known-good',
  input: 'good',
  expectedIssues: [],
  labeledEvidence: [{ kind: 'span', uri: root }],
}

describe('scoreAnalystFindings', () => {
  it('scores issue recall, finding precision, first-bad-step location, and citations separately', () => {
    const result = scoreAnalystFindings(badCase, [
      finding({ subject: 'failure-mode:tool-failure', evidence: [failed] }),
      finding({ subject: 'failure-mode:unsupported-claim', evidence: [corrected] }),
      finding({ subject: 'failure-mode:invented', evidence: ['trace://run/span/missing'] }),
    ])
    expect(result.matchedIssueIds).toEqual(['tool-failure', 'unsupported-claim'])
    expect(result.issueRecall).toBe(1)
    expect(result.findingPrecision).toBeCloseTo(2 / 3)
    expect(result.f1).toBeCloseTo(0.8)
    expect(result.criticalStepAccuracy).toBe(1)
    expect(result.citationCoverage).toBe(1)
    expect(result.citationLabelAgreement).toBeCloseTo(2 / 3)
    expect(result.unlabeledEvidence).toHaveLength(1)
  })

  it('does not match negated or coincidental claim text', () => {
    const result = scoreAnalystFindings(badCase, [
      finding({ subject: 'failure-mode:not-a-timeout', evidence: [root] }),
    ])
    expect(result.matchedIssueIds).toEqual([])
    expect(result.issueRecall).toBe(0)
    expect(result.findingPrecision).toBe(0)
  })

  it('separates missing citations from invalid citations', () => {
    const uncited = makeFinding({
      analyst_id: 'test',
      area: 'failure-mode',
      subject: 'failure-mode:tool-failure',
      claim: 'The tool failed',
      severity: 'high',
      confidence: 1,
      evidence_refs: [],
    })
    const result = scoreAnalystFindings(badCase, [uncited])
    expect(result.citationCoverage).toBe(0)
    expect(result.citationLabelAgreement).toBe(0)
    expect(result.issueRecall).toBe(0)
  })

  it('matches findings and expected issues one-to-one', () => {
    const duplicate = finding({
      subject: 'failure-mode:tool-failure',
      evidence: [failed],
      idBasis: 'duplicate',
    })
    const result = scoreAnalystFindings(
      {
        id: 'one-to-one',
        expectedIssues: [
          { id: 'first', evidence: [{ kind: 'span', uri: failed }] },
          { id: 'second', evidence: [{ kind: 'span', uri: failed }] },
        ],
      },
      [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] }), duplicate],
    )

    expect(result.matchedIssueIds).toEqual(['first', 'second'])
    expect(result.supportedFindingIndexes).toHaveLength(2)

    const oneFinding = scoreAnalystFindings(
      {
        id: 'one-prediction',
        expectedIssues: [
          { id: 'first', evidence: [{ kind: 'span', uri: failed }] },
          { id: 'second', evidence: [{ kind: 'span', uri: failed }] },
        ],
      },
      [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] })],
    )
    expect(oneFinding.issueRecall).toBe(0.5)
    expect(oneFinding.supportedFindingIndexes).toEqual([0])
  })

  it('counts duplicate predictions as unsupported', () => {
    const result = scoreAnalystFindings(badCase, [
      finding({ subject: 'failure-mode:tool-failure', evidence: [failed] }),
      finding({
        subject: 'failure-mode:tool-failure',
        evidence: [failed],
        idBasis: 'duplicate',
      }),
    ])

    expect(result.issueRecall).toBe(0.5)
    expect(result.findingPrecision).toBe(0.5)
    expect(result.unsupportedFindingIndexes).toHaveLength(1)
  })

  it('uses the maximum-cardinality assignment that best localizes critical steps', () => {
    const wrongStep = finding({
      subject: 'failure-mode:tool-failure',
      evidence: [root],
      idBasis: 'wrong-step',
    })
    const criticalStep = finding({
      subject: 'failure-mode:tool-failure',
      evidence: [failed],
      idBasis: 'critical-step',
    })
    const result = scoreAnalystFindings(
      {
        id: 'critical-assignment',
        expectedIssues: [
          {
            id: 'tool-failure',
            subjects: ['failure-mode:tool-failure'],
            criticalEvidence: [{ kind: 'span', uri: failed }],
          },
        ],
        labeledEvidence: [
          { kind: 'span', uri: root },
          { kind: 'span', uri: failed },
        ],
      },
      [wrongStep, criticalStep],
    )

    expect(result.issueRecall).toBe(1)
    expect(result.criticalStepAccuracy).toBe(1)
    expect(result.supportedFindingIndexes).toEqual([1])
    expect(result.unsupportedFindingIndexes).toEqual([0])
  })

  it('allows category-only labels and rejects labels with no matching field', () => {
    expect(
      scoreAnalystFindings(
        { id: 'category-label', expectedIssues: [{ id: 'failure', areas: ['failure-mode'] }] },
        [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] })],
      ).issueRecall,
    ).toBe(1)
    expect(() =>
      scoreAnalystFindings({ id: 'bad-label', expectedIssues: [{ id: 'vague' }] }, []),
    ).toThrow(/must identify a finding/)
  })
})

describe('runAnalystBenchmark', () => {
  it('compares runners across bad and clean cases with stability, usage, failures, and latency', async () => {
    let unstableCall = 0
    const strong: AnalystBenchmarkRunner<string> = {
      id: 'strong',
      async analyze(input) {
        return {
          findings:
            input === 'good'
              ? []
              : [
                  finding({ subject: 'failure-mode:tool-failure', evidence: [failed] }),
                  finding({ subject: 'failure-mode:unsupported-claim', evidence: [corrected] }),
                ],
          usage: {
            calls: 1,
            tokens: { input: 10, output: 5 },
            cost: { kind: 'observed', usd: 0.01 },
          },
        }
      },
    }
    const unstable: AnalystBenchmarkRunner<string> = {
      id: 'unstable',
      async analyze(input) {
        unstableCall += 1
        if (input === 'good') {
          return {
            findings: [finding({ subject: 'failure-mode:invented', evidence: [root] })],
          }
        }
        return {
          findings:
            unstableCall % 2 === 0
              ? []
              : [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] })],
        }
      },
    }
    const result = await runAnalystBenchmark({
      cases: [badCase, cleanCase],
      runners: [strong, unstable],
      repetitions: 2,
      maxConcurrency: 1,
      benchmark: {
        id: 'analyst-fixture',
        dataset: { id: 'fixture', revision: 'abc123', split: 'test' },
      },
    })
    const strongSummary = result.summaries[0]!
    expect(strongSummary).toMatchObject({
      runnerId: 'strong',
      plannedRuns: 4,
      completedRuns: 4,
      failedRuns: 0,
      issueRecall: 1,
      findingPrecision: 1,
      f1: 1,
      criticalStepAccuracy: 1,
      citationCoverage: 1,
      citationLabelAgreement: 1,
      citationResolution: null,
      citationResolutionUnknownRuns: 2,
      unresolvedCitations: 0,
      citationResolutionErrors: 0,
      cleanCaseFalsePositiveRate: 0,
      cleanCaseFailureRate: 0,
      runAgreement: 1,
      calls: 4,
      inputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokenUsageUnknownRuns: 4,
      cachedTokenUsageUnknownRuns: 4,
      cacheWriteTokenUsageUnknownRuns: 4,
      knownCostUsd: 0.04,
    })
    const unstableSummary = result.summaries[1]!
    expect(unstableSummary.issueRecall).toBeLessThan(1)
    expect(unstableSummary.cleanCaseFalsePositiveRate).toBe(1)
    expect(unstableSummary.runAgreement).toBeLessThan(1)
    expect(unstableSummary.callsUnknownRuns).toBe(4)
    expect(result.observations).toHaveLength(8)
    expect(result.observations[0]).toMatchObject({
      caseId: 'known-bad',
      caseTags: ['failed', 'tool-use'],
      caseMetadata: { source: 'fixture' },
    })
    expect(strongSummary.latencyMs.min).toBeGreaterThanOrEqual(0)
    expect(result.provenance).toMatchObject({
      id: 'analyst-fixture',
      dataset: { id: 'fixture', revision: 'abc123', split: 'test' },
      caseCount: 2,
      runnerIds: ['strong', 'unstable'],
      repetitions: 2,
      maxConcurrency: 1,
      runnerOrderSeed: 0,
    })
  })

  it('records runner errors as failed observations instead of aborting the comparison', async () => {
    const result = await runAnalystBenchmark({
      cases: [badCase],
      runners: [
        {
          id: 'broken',
          async analyze() {
            throw new Error('provider down')
          },
        },
      ],
    })
    expect(result.summaries[0]).toMatchObject({ completedRuns: 0, failedRuns: 1 })
    expect(result.observations[0]?.error).toEqual({ class: 'Error', message: 'provider down' })
    expect(result.summaries[0]?.runAgreement).toBeNull()
  })

  it('does not report perfect quality when every clean-case run fails', async () => {
    const result = await runAnalystBenchmark({
      cases: [cleanCase],
      runners: [
        {
          id: 'dead',
          async analyze() {
            throw new Error('unavailable')
          },
        },
      ],
    })

    expect(result.summaries[0]).toMatchObject({
      completedRuns: 0,
      failedRuns: 1,
      issueRecall: null,
      findingPrecision: null,
      f1: null,
      cleanCaseFalsePositiveRate: null,
      cleanCaseFailureRate: 1,
    })
  })

  it('checks citation resolution separately from agreement with labeled locations', async () => {
    const missing = 'trace://run/span/missing'
    const testCase: AnalystBenchmarkCase<string> = {
      ...badCase,
      expectedIssues: [badCase.expectedIssues[0]!],
      labeledEvidence: [...(badCase.labeledEvidence ?? []), { kind: 'span', uri: missing }],
    }
    const result = await runAnalystBenchmark({
      cases: [testCase],
      runners: [
        {
          id: 'citing',
          async analyze() {
            return {
              findings: [
                finding({
                  subject: 'failure-mode:tool-failure',
                  evidence: [failed, missing],
                }),
              ],
            }
          },
        },
      ],
      resolveEvidence: ({ evidence }) => evidence.uri !== missing,
    })

    expect(result.observations[0]?.score.citationLabelAgreement).toBe(1)
    expect(result.observations[0]?.evidenceResolution).toMatchObject({
      checked: 2,
      resolved: 1,
      validity: 0.5,
      unresolvedEvidence: [{ kind: 'span', uri: missing }],
      errors: [],
    })
    expect(result.summaries[0]).toMatchObject({
      citationResolution: 0.5,
      unresolvedCitations: 1,
      citationResolutionErrors: 0,
    })
  })

  it('records citation resolver failures without turning them into analyst failures', async () => {
    const result = await runAnalystBenchmark({
      cases: [badCase],
      runners: [
        {
          id: 'citing',
          async analyze() {
            return {
              findings: [
                finding({
                  subject: 'failure-mode:tool-failure',
                  evidence: [failed],
                }),
              ],
            }
          },
        },
      ],
      resolveEvidence() {
        throw new Error('trace store unavailable')
      },
    })

    expect(result.observations[0]?.error).toBeUndefined()
    expect(result.observations[0]?.evidenceResolution).toMatchObject({
      validity: null,
      errors: [{ class: 'Error', message: 'trace store unavailable' }],
    })
    expect(result.summaries[0]).toMatchObject({
      citationResolution: null,
      citationResolutionUnknownRuns: 1,
      citationResolutionErrors: 1,
    })
  })

  it('keeps runner pairs adjacent and rotates their order between case blocks', async () => {
    const starts: string[] = []
    const runner = (id: string): AnalystBenchmarkRunner<string> => ({
      id,
      async analyze() {
        starts.push(id)
        return { findings: [] }
      },
    })

    const result = await runAnalystBenchmark({
      cases: [cleanCase, { ...cleanCase, id: 'known-good-2' }],
      runners: [runner('first'), runner('second')],
      maxConcurrency: 1,
      runnerOrderSeed: 17,
    })

    expect(starts.slice(0, 2).sort()).toEqual(['first', 'second'])
    expect(starts.slice(2, 4)).toEqual(starts.slice(0, 2).reverse())
    expect(result.observations.map((observation) => observation.executionIndex).sort()).toEqual([
      0, 1, 2, 3,
    ])
  })
})

describe('traceStoreEvidenceResolver', () => {
  it('resolves encoded canonical span URIs and rejects unsupported locations', async () => {
    const requests: Array<{ trace_id: string; span_ids: readonly string[] }> = []
    const traceStore = {
      async viewSpans(input: { trace_id: string; span_ids: readonly string[] }) {
        requests.push(input)
        const found = input.trace_id === 'run/a' && input.span_ids[0] === 'span/b'
        return {
          trace_id: input.trace_id,
          spans: found ? [{ trace_id: input.trace_id, span_id: input.span_ids[0] }] : [],
          missing_span_ids: found ? [] : [...input.span_ids],
          truncated_attribute_count: 0,
        }
      },
    } as unknown as TraceAnalysisStore
    const resolve = traceStoreEvidenceResolver<{ traceStore: TraceAnalysisStore }>(
      (input) => input.traceStore,
    )
    const context = {
      caseId: 'case',
      caseInput: { traceStore },
    }

    await expect(
      resolve({
        ...context,
        evidence: { kind: 'span', uri: 'trace://run%2Fa/span/span%2Fb' },
      }),
    ).resolves.toBe(true)
    await expect(
      resolve({
        ...context,
        evidence: { kind: 'artifact', uri: 'artifact://report' },
      }),
    ).resolves.toBe(false)
    await expect(
      resolve({
        ...context,
        evidence: { kind: 'span', uri: 'trace://bad/span/%E0%A4%A' },
      }),
    ).resolves.toBe(false)
    expect(requests).toEqual([{ trace_id: 'run/a', span_ids: ['span/b'] }])
  })
})
