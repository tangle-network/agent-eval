import { describe, expect, it } from 'vitest'
import {
  type AnalystBenchmarkCase,
  type AnalystBenchmarkRunner,
  runAnalystBenchmark,
} from './benchmark'
import { summarizeAnalystBenchmarkRunner } from './benchmark-summary'
import { badCase, cleanCase, corrected, failed, finding, root } from './benchmark-test-fixtures'

describe('analyst benchmark summaries', () => {
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
      macroIssueRecall: 1,
      macroFindingPrecision: 1,
      macroF1: 1,
      criticalStepAccuracy: 1,
      citationCoverage: 1,
      citationExcerptCoverage: 0,
      citationLabelAgreement: 1,
      citationResolution: null,
      citationResolutionUnknownRuns: 2,
      unresolvedCitations: 0,
      citationResolutionErrors: 0,
      trustedNegativeFalsePositiveRate: 0,
      trustedNegativeFailureRate: 0,
      predictionAgreement: 1,
      predictionAgreementCases: 2,
      matchedLabelAgreement: 1,
      matchedLabelAgreementCases: 1,
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
    expect(unstableSummary.trustedNegativeFalsePositiveRate).toBe(1)
    expect(unstableSummary.predictionAgreement).toBeLessThan(1)
    expect(unstableSummary.matchedLabelAgreement).toBeLessThan(1)
    expect(unstableSummary.callsUnknownRuns).toBe(4)
    expect(result.observations).toHaveLength(8)
    expect(result.observations[0]).toMatchObject({
      caseId: 'known-bad',
      caseTags: ['failed', 'tool-use'],
      caseMetadata: { source: 'fixture' },
    })
    expect(strongSummary.latencyMs).not.toBeNull()
    expect(strongSummary.latencyMs!.min).toBeGreaterThanOrEqual(0)
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

  it('scores partial findings from failed runs as diagnostics, not quality', async () => {
    const result = await runAnalystBenchmark({
      cases: [badCase],
      runners: [
        {
          id: 'partial-failure',
          analyze() {
            return {
              findings: [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] })],
              error: { class: 'TruncatedResponse', message: 'response ended before completion' },
            }
          },
        },
      ],
    })

    expect(result.observations[0]).toMatchObject({
      findings: [expect.any(Object)],
      score: {
        matchedIssueIds: [],
        issueRecall: 0,
        findingPrecision: 0,
        f1: 0,
        citationCoverage: null,
      },
      error: { class: 'TruncatedResponse' },
    })
    expect(result.summaries[0]).toMatchObject({
      completedRuns: 0,
      failedRuns: 1,
      issueRecall: 0,
      findingPrecision: 0,
      f1: 0,
      citationCoverage: null,
    })
  })

  it('separates trusted negatives from unlabeled trajectories', async () => {
    const result = await runAnalystBenchmark({
      cases: [
        cleanCase,
        {
          ...cleanCase,
          id: 'unknown-outcome',
          clusterId: 'task-unknown',
          labelState: 'unlabeled',
        },
      ],
      runners: [
        {
          id: 'flags-both',
          analyze() {
            return {
              findings: [finding({ subject: 'failure-mode:invented', evidence: [root] })],
            }
          },
        },
      ],
    })

    expect(result.summaries[0]).toMatchObject({
      trustedNegativeRuns: 1,
      unlabeledRuns: 1,
      trustedNegativeFalsePositiveRate: 1,
      unlabeledPredictionRate: 1,
    })
  })

  it('uses full prediction agreement as the primary repeatability measure', async () => {
    let call = 0
    const result = await runAnalystBenchmark({
      cases: [cleanCase],
      repetitions: 2,
      runners: [
        {
          id: 'unstable-false-positive',
          analyze() {
            call += 1
            return {
              findings: [
                finding({
                  subject: `failure-mode:invented-${call}`,
                  evidence: [call === 1 ? root : corrected],
                }),
              ],
            }
          },
        },
      ],
    })

    expect(result.summaries[0]).toMatchObject({
      predictionAgreement: 0,
      predictionAgreementCases: 1,
      matchedLabelAgreement: null,
      matchedLabelAgreementCases: 0,
    })
  })

  it('treats a changed claim as a changed repeated finding', async () => {
    let call = 0
    const result = await runAnalystBenchmark({
      cases: [cleanCase],
      repetitions: 2,
      runners: [
        {
          id: 'claim-changes',
          analyze() {
            call += 1
            return {
              findings: [
                finding({
                  subject: 'failure-mode:invented',
                  evidence: [root],
                  claim: `Claim ${call}`,
                }),
              ],
            }
          },
        },
      ],
    })

    expect(result.summaries[0]).toMatchObject({
      predictionAgreement: 0,
      predictionAgreementCases: 1,
    })
  })

  it('counts a failed repetition as a different repeatability outcome', async () => {
    let call = 0
    const result = await runAnalystBenchmark({
      cases: [badCase],
      repetitions: 2,
      runners: [
        {
          id: 'sometimes-fails',
          analyze() {
            call += 1
            if (call === 2) throw new Error('transient provider failure')
            return {
              findings: [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] })],
            }
          },
        },
      ],
    })

    expect(result.summaries[0]).toMatchObject({
      completedRuns: 1,
      failedRuns: 1,
      predictionAgreement: 0,
      predictionAgreementCases: 1,
      matchedLabelAgreement: 0,
      matchedLabelAgreementCases: 1,
    })
  })

  it('produces identical floating-point summaries regardless of completion order', async () => {
    const cases = [0.1, 0.2, 0.3].map((cost, index) => ({
      ...badCase,
      id: `cost-${index}`,
      clusterId: `cost-${index}`,
      input: cost,
    }))
    const result = await runAnalystBenchmark({
      cases,
      runners: [
        {
          id: 'costed',
          analyze(cost) {
            return {
              findings: [],
              usage: {
                calls: 1,
                tokens: { input: 1, output: 1 },
                cost: { kind: 'observed', usd: cost },
              },
            }
          },
        },
      ],
    })

    const forward = summarizeAnalystBenchmarkRunner('costed', result.observations)
    const reverse = summarizeAnalystBenchmarkRunner('costed', [...result.observations].reverse())

    expect(reverse).toEqual(forward)
    expect(forward.knownCostUsd).toBe(0.6)
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
      macroIssueRecall: null,
      macroFindingPrecision: null,
      macroF1: null,
      trustedNegativeFalsePositiveRate: null,
      trustedNegativeFailureRate: 1,
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
})
