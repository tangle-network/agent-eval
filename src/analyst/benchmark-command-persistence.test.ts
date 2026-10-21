

import { describe, expect, it } from 'vitest'



import { assertAnalystBenchmarkObservation } from './benchmark-command-artifact'





describe('the observation gate accepts every usage receipt a runner can emit', () => {
  const observation = (usage: unknown) => ({
    runnerId: 'prime',
    caseId: 'codetrace:x',
    clusterId: 'codetrace-task:x',
    labelState: 'positive',
    repetition: 0,
    executionIndex: 0,
    latencyMs: 1234,
    latencySource: 'benchmark-clock',
    findings: [],
    score: {
      expectedIssueCount: 1,
      matchedIssueIds: [],
      missedIssueIds: ['incorrect:1'],
      supportedFindingIndexes: [],
      unsupportedFindingIndexes: [],
      unlabeledEvidence: [],
      issueRecall: 0,
      findingPrecision: 0,
      f1: 0,
      criticalStepAccuracy: null,
      citationCoverage: null,
      citationExcerptCoverage: null,
      citationLabelAgreement: null,
      predictionOnLabelEmptyCase: false,
    },
    caseTags: [],
    usage,
  })

  // A one-sided provider count lives in partialTokens rather than being
  // zero-filled into tokens. The gate runs at journal-write time, AFTER the
  // model call is paid for, so a receipt shape it rejects burns real money.
  it('accepts a one-sided token count', () => {
    expect(() =>
      assertAnalystBenchmarkObservation(
        observation({
          calls: 1,
          tokens: null,
          cost: { kind: 'uncaptured', usd: null },
          partialTokens: { input: 217085, output: null },
        }),
        'benchmark observation',
      ),
    ).not.toThrow()
  })

  it('accepts transport-derived token counts', () => {
    expect(() =>
      assertAnalystBenchmarkObservation(
        observation({
          calls: 2,
          tokens: { input: 10, output: 5 },
          cost: { kind: 'estimated', usd: 0.000017 },
          tokensEstimated: true,
        }),
        'benchmark observation',
      ),
    ).not.toThrow()
  })

  it('still rejects a usage key no runner declares', () => {
    expect(() =>
      assertAnalystBenchmarkObservation(
        observation({
          calls: 1,
          tokens: null,
          cost: { kind: 'uncaptured', usd: null },
          madeUpField: 1,
        }),
        'benchmark observation',
      ),
    ).toThrow()
  })
})
