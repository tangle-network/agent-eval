import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readAnalystBenchmarkArtifact } from './benchmark-command-result'
import {
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
  ANALYST_BENCHMARK_EVIDENCE_DEPENDENCY_LOCK_SHA256,
  ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256,
  ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
} from './benchmark-implementation'

const REFERENCE_RESULT = fileURLToPath(
  new URL(
    '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/result.json',
    import.meta.url,
  ),
)
const FAIR_RESULT = fileURLToPath(
  new URL(
    '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/fair-result.json',
    import.meta.url,
  ),
)
const CODETRACER_RESULT = fileURLToPath(
  new URL(
    '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/codetracer-result.json',
    import.meta.url,
  ),
)
const VERIFICATION_RECEIPT = fileURLToPath(
  new URL(
    '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/verification.json',
    import.meta.url,
  ),
)
const PREPARE_SCRIPT = fileURLToPath(
  new URL(
    '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/prepare.py',
    import.meta.url,
  ),
)
const CODETRACER_RUNNER = fileURLToPath(
  new URL(
    '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/run-codetracer.sh',
    import.meta.url,
  ),
)
const CODETRACER_REDUCER = fileURLToPath(
  new URL(
    '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/summarize-codetracer.mjs',
    import.meta.url,
  ),
)
const CODETRACER_CONFIG = fileURLToPath(
  new URL(
    '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/codetracer-no-memory.yaml',
    import.meta.url,
  ),
)

describe('CodeTraceBench GLM-5.2 reference result', () => {
  it('keeps the published real-model result parseable, exact, and shareable', async () => {
    const contents = await readFile(REFERENCE_RESULT, 'utf8')
    expect(createHash('sha256').update(contents).digest('hex')).toBe(
      '22f2514771a52288f26d2121d7d77b2df2fb41cb80d90173570f122aaceb87b9',
    )
    expect(contents).not.toMatch(
      /\/home\/drew|\/tmp\/agent-eval|api\.z\.ai|ZAI_GLM_API_KEY|authorization|bearer/i,
    )

    const artifact = await readAnalystBenchmarkArtifact(REFERENCE_RESULT)
    expect({
      kind: artifact.kind,
      runIdentitySha256: artifact.runIdentitySha256,
      datasetRevision: artifact.inputs.datasetRevision,
      labelsSha256: artifact.inputs.labelsSha256,
      selectedCases: artifact.inputs.selection.selectedCaseIds.length,
      protocolSha256: artifact.inputs.execution.analystProtocolSha256,
      implementationSha256: artifact.inputs.execution.implementationSha256,
      dependencyLockSha256: artifact.inputs.execution.dependencyLockSha256,
      observations: artifact.result.observations.length,
      verificationAvailability: artifact.inputs.verificationAvailability,
    }).toEqual({
      kind: 'agent-eval/analyst-benchmark-result',
      runIdentitySha256: '044393f7d937c621b568fd4d4ec92a9c9d0a4040d55db9b3faf72647e0270cdb',
      datasetRevision: 'aa213b84ffb6690fc37ca15766d6ca174ec36d4d',
      labelsSha256: '5d8b4024c3e2114965cbf2f2fa0124bbf59b3fb134824fa06dd6a38ee07e8412',
      selectedCases: 32,
      protocolSha256: '166e399c9a93c9806b007273bf0b54078709389c52c6a33e3cbce0f554dab302',
      implementationSha256: ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256,
      dependencyLockSha256: ANALYST_BENCHMARK_EVIDENCE_DEPENDENCY_LOCK_SHA256,
      observations: 128,
      verificationAvailability: {
        cases: 32,
        resultFilesPresent: 32,
        resultFilesMissing: 0,
        outcomes: { passed: 15, failed: 13, unavailable: 4 },
      },
    })

    const model = artifact.result.summaries.find((summary) => summary.runnerId === 'model')
    expect(model).toMatchObject({
      plannedRuns: 64,
      completedRuns: 63,
      failedRuns: 1,
      issueRecall: 0.4090909090909091,
      findingPrecision: 0.3333333333333333,
      f1: 0.36734693877551017,
      macroIssueRecall: 0.30431547619047616,
      macroFindingPrecision: 0.27133508852258853,
      macroF1: 0.26940125846375845,
      citationCoverage: 1,
      citationExcerptCoverage: 1,
      citationLabelAgreement: 0.2727272727272727,
      citationResolution: 1,
      trustedNegativeFalsePositiveRate: 0.9333333333333333,
      unlabeledPredictionRate: 1,
      predictionAgreement: 0.46588064713064714,
      predictionAgreementCases: 32,
      matchedLabelAgreement: 0.6791666666666667,
      matchedLabelAgreementCases: 16,
      calls: 64,
      inputTokens: 1972,
      outputTokens: 46072,
      reasoningTokens: 0,
      cachedTokens: 1843200,
      knownCostUsd: 1.2084616,
      costUnknownRuns: 0,
    })

    expect(
      artifact.codeTraceCalibration?.runners.find((runner) => runner.runnerId === 'model'),
    ).toMatchObject({
      selectedRuns: 48,
      completedRuns: 47,
      failedRuns: 1,
      expectedIncorrectSteps: 110,
      predictedIncorrectSteps: 165,
      matchedIncorrectSteps: 45,
      officialAllRowF1: 0.13470062923187923,
      officialAllRowRuns: 64,
    })
  })

  it('keeps the trajectory-only comparison arm exact', async () => {
    const contents = await readFile(FAIR_RESULT, 'utf8')
    expect(createHash('sha256').update(contents).digest('hex')).toBe(
      '272013efd36ad7951f159f88656ff2fd8fa5e5b4e6c2368e6b214c3c58a0a566',
    )
    expect(contents).not.toMatch(
      /\/home\/drew|\/tmp\/agent-eval|api\.z\.ai|ZAI_GLM_API_KEY|authorization|bearer/i,
    )
    const artifact = await readAnalystBenchmarkArtifact(FAIR_RESULT)
    expect(artifact.inputs.verificationAvailability).toEqual({
      cases: 32,
      resultFilesPresent: 0,
      resultFilesMissing: 32,
      outcomes: { passed: 0, failed: 0, unavailable: 32 },
    })
    expect(
      artifact.codeTraceCalibration?.runners.find((runner) => runner.runnerId === 'model'),
    ).toMatchObject({
      completedRuns: 46,
      failedRuns: 2,
      expectedIncorrectSteps: 110,
      predictedIncorrectSteps: 174,
      matchedIncorrectSteps: 44,
      officialAllRowF1: 0.15021525367393335,
      officialAllRowRuns: 64,
    })
  })

  it('keeps the pinned CodeTracer comparison exact and failure-inclusive', async () => {
    const contents = await readFile(CODETRACER_RESULT, 'utf8')
    expect(createHash('sha256').update(contents).digest('hex')).toBe(
      'bc55c1abc3037e3d15a5712584ebf3884c12e08defd280e40cc3d23d8feeeb13',
    )
    expect(contents).not.toMatch(/authorization|bearer|ZAI_GLM_API_KEY/i)
    const artifact = JSON.parse(contents)
    expect(artifact).toMatchObject({
      kind: 'agent-eval/codetracer-benchmark-result',
      source: {
        upstream: 'NJU-LINK/CodeTracer',
        upstreamRevision: '2d302191dd07e7c0c2da6f7a5e9451c7cbb62d34',
        model: 'glm-5.2',
        memoryEnabled: false,
        labelsSha256: '5d8b4024c3e2114965cbf2f2fa0124bbf59b3fb134824fa06dd6a38ee07e8412',
      },
      statusCounts: { ok: 62, failed: 1, 'invalid-output': 1 },
      evaluationStatusCounts: { valid: 61, failedProcess: 1, invalidOutput: 2 },
      repricedCost: {
        knownRuns: 63,
        unknownRuns: 1,
        usd: 7.2703472,
      },
    })
    expect(artifact.result.summaries[0]).toMatchObject({
      plannedRuns: 64,
      completedRuns: 61,
      failedRuns: 3,
      calls: 933,
      callsUnknownRuns: 1,
      inputTokens: 10437890,
      outputTokens: 458006,
      knownCostUsd: 63.6392,
      costUnknownRuns: 1,
      predictionAgreement: 0.4733532092907093,
      predictionAgreementCases: 32,
    })
    expect(artifact.codeTraceCalibration.runners[0]).toMatchObject({
      expectedIncorrectSteps: 110,
      predictedIncorrectSteps: 166,
      matchedIncorrectSteps: 38,
      officialAllRowF1: 0.11609110809178744,
      officialAllRowRuns: 64,
    })
  })

  it('keeps the published evidence separated from the current engine', async () => {
    // The DSPy RLM migration replaced the runner that produced this evidence and
    // added the Python bridge to the dependency manifest, so neither evidence
    // digest can equal its current counterpart. Equality here would mean the
    // published numbers were being attributed to an implementation that never
    // produced them.
    expect(ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256).not.toBe(
      ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
    )
    expect(ANALYST_BENCHMARK_EVIDENCE_DEPENDENCY_LOCK_SHA256).not.toBe(
      ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
    )

    const readme = await readFile(
      fileURLToPath(
        new URL(
          '../../benchmarks/trace-analysis/codetracebench-glm52-20260730/README.md',
          import.meta.url,
        ),
      ),
      'utf8',
    )
    expect(readme).toContain(ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256)
    expect(readme).toMatch(/retired one-shot direct runner/)
  })

  it('binds the verification receipt to all three published results', async () => {
    const receipt = JSON.parse(await readFile(VERIFICATION_RECEIPT, 'utf8'))
    const digest = async (path: string) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    expect({
      reference: await digest(REFERENCE_RESULT),
      fair: await digest(FAIR_RESULT),
      codeTracer: await digest(CODETRACER_RESULT),
      prepareScript: await digest(PREPARE_SCRIPT),
      codeTracerRunner: await digest(CODETRACER_RUNNER),
      codeTracerReducer: await digest(CODETRACER_REDUCER),
      codeTracerConfig: await digest(CODETRACER_CONFIG),
    }).toEqual({
      reference: receipt.referenceRun.resultSha256,
      fair: receipt.trajectoryOnlyRun.resultSha256,
      codeTracer: receipt.codeTracerRun.resultSha256,
      prepareScript: receipt.inputs.preparation.prepareScriptSha256,
      codeTracerRunner: receipt.codeTracerRun.runnerScriptSha256,
      codeTracerReducer: receipt.codeTracerRun.reducerSha256,
      codeTracerConfig: receipt.codeTracerRun.configurationSha256,
    })
    expect(receipt).toMatchObject({
      inputs: {
        traceFiles: 32,
        traceBytes: 3187625,
        artifactFiles: 64,
        artifactBytes: 306971,
        missingCases: 0,
      },
      implementation: {
        sourceSha256: ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256,
        dependencyLockSha256: ANALYST_BENCHMARK_EVIDENCE_DEPENDENCY_LOCK_SHA256,
      },
      failureProof: {
        parallelStart: {
          providerStatus: 429,
          savedFailedResponses: 5,
          unknownUsageResponses: 5,
          resultWritten: false,
          continuedAfterUnknownCost: false,
        },
      },
      secretScan: {
        exactLiveKeyMatches: 0,
        shareableMetadataMatches: 0,
      },
      securityScan: {
        semgrep: {
          rules: 492,
          files: 664,
          suppressedWithReviewedInvariant: 1,
          unsuppressedFindingsInChangedFiles: 0,
        },
        gitleaks: {
          fixtureCandidates: 5,
          findingsInChangedFiles: 0,
        },
        dependencyAudit: {
          knownVulnerabilities: 0,
        },
      },
    })
  })
})
