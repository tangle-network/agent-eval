import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AnalystBenchmarkRunner } from './benchmark'
import {
  AGENT_RX_UPSTREAM_REVISION,
  ANALYST_BENCHMARK_COST_LEDGER_FILE,
  ANALYST_BENCHMARK_LOCAL_RECEIPT_FILE,
  ANALYST_BENCHMARK_MANIFEST_FILE,
  ANALYST_BENCHMARK_OBSERVATIONS_FILE,
  readAnalystBenchmarkArtifact,
  runAnalystBenchmarkCommand,
} from './benchmark-command'
import {
  AGENT_RX_TEST_REVISION,
  agentRxCommandArgs,
  agentRxFixture,
  codeTraceFixture,
  commandArgs,
  UNKNOWN_USAGE,
} from './benchmark-command.test-support'
import type { AnalystRunInputs } from './types'
import { makeFinding } from './types'

describe('runAnalystBenchmarkCommand', () => {
  it('writes complete paired results and preserves unknown model cost', async () => {
    const fixture = await codeTraceFixture()
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      async analyze(input, context) {
        const manifest = JSON.parse(
          await readFile(join(fixture.outDir, ANALYST_BENCHMARK_MANIFEST_FILE), 'utf8'),
        )
        expect(manifest).toMatchObject({
          kind: 'agent-eval/analyst-benchmark-run',
          identitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        })
        expect(JSON.stringify(manifest)).not.toContain('do-not-persist-this-key')
        const trace = await input.traceStore?.viewTrace({ trace_id: 'trace-1' })
        const verificationSpans = trace?.spans?.filter((span) => span.kind === 'EVALUATOR') ?? []
        expect(verificationSpans.map((span) => span.name)).toEqual([
          'final verification outcome: failed',
          'final verification artifact: panes/post-test.txt',
        ])
        await expect(
          input.traceStore?.searchTrace({
            trace_id: 'trace-1',
            regex_pattern: 'hidden assertion failed',
          }),
        ).resolves.toMatchObject({
          hits: [expect.objectContaining({ span_id: verificationSpans[1]?.span_id })],
        })
        return {
          findings: [
            makeFinding({
              analyst_id: 'dspy-rlm',
              area: 'incorrect',
              claim: 'Step 2 changes the wrong file.',
              severity: 'high',
              confidence: 0.9,
              evidence_refs: [{ kind: 'span', uri: 'trace://trace-1/span/step-2' }],
            }),
          ],
          usage: UNKNOWN_USAGE,
          metadata: { caseId: context.caseId },
        }
      },
    }

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await runAnalystBenchmarkCommand(
      commandArgs(fixture),
      { TEST_ANALYST_KEY: 'do-not-persist-this-key' },
      {
        createAnalystRunner: (_dataset, config) => {
          expect(config.durability).toEqual({
            runIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            responseCacheDir: join(fixture.outDir, 'model-responses'),
          })
          return modelRunner
        },
      },
    )
    const successOutput = stdout.mock.calls.map(([value]) => String(value)).join('')
    stdout.mockRestore()

    expect(code).toBe(0)
    expect(successOutput).toContain(
      'cases=1 failures=0 known_cost_usd=0.000000 unknown_cost_runs=1',
    )
    expect(successOutput).toContain(`result=${join(fixture.outDir, 'result.json')}`)
    expect(successOutput).toContain(`report=${join(fixture.outDir, 'report.md')}`)
    const artifact = (await readAnalystBenchmarkArtifact(
      join(fixture.outDir, 'result.json'),
    )) as unknown as Record<string, any>
    expect(artifact.result.provenance).toMatchObject({
      caseCount: 1,
      runnerIds: ['empty', 'dspy-rlm'],
      runnerOrderSeed: 7,
      metadata: {
        protocolSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        implementationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        dependencyLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        populationRepresentativenessProven: false,
      },
    })
    expect(artifact.result.summaries).toEqual([
      expect.objectContaining({ runnerId: 'empty', issueRecall: 0, knownCostUsd: 0 }),
      expect.objectContaining({
        runnerId: 'dspy-rlm',
        issueRecall: 1,
        costUnknownRuns: 1,
        knownCostUsd: 0,
      }),
    ])
    expect(artifact.result.observations[1].usage).toEqual(UNKNOWN_USAGE)
    expect(artifact.inputs.verificationAvailability).toEqual({
      cases: 1,
      resultFilesPresent: 1,
      resultFilesMissing: 0,
      outcomes: { passed: 0, failed: 1, unavailable: 0 },
    })
    expect(artifact.inputs.execution.maxCostUsd).toBe(5)
    expect(artifact.inputs.execution.analystProtocolSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(artifact.inputs.execution.analystProtocolSha256).toBe(
      artifact.result.provenance.metadata.protocolSha256,
    )
    expect(artifact.inputs.execution.implementationSha256).toBe(
      artifact.result.provenance.metadata.implementationSha256,
    )
    expect(artifact.inputs.execution.dependencyLockSha256).toBe(
      artifact.result.provenance.metadata.dependencyLockSha256,
    )
    expect(artifact.inputs.verificationArtifacts).toEqual([
      expect.objectContaining({
        traceId: 'trace-1',
        status: 'present',
        outcome: expect.objectContaining({
          status: 'failed',
          sources: [
            expect.objectContaining({
              path: 'task-1_result.json',
              format: 'swe-bench',
            }),
          ],
        }),
        outcomeSpanId: expect.stringMatching(/^benchmark-verification-outcome-/),
        caseDirectoriesSearched: expect.arrayContaining(['trace-1/cases/trace-1']),
        totalBytes: expect.any(Number),
        missingRoles: ['final-metrics'],
        files: [
          expect.objectContaining({
            role: 'final-test-output',
            relativePath: 'panes/post-test.txt',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            spanId: expect.stringMatching(/^benchmark-verification-/),
          }),
          expect.objectContaining({
            role: 'final-result',
            relativePath: 'task-1_result.json',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            spanId: expect.stringMatching(/^benchmark-verification-/),
          }),
        ],
      }),
    ])
    expect(artifact.result.observations[1].caseMetadata.verificationArtifacts).toMatchObject({
      status: 'present',
      missingRoles: ['final-metrics'],
    })
    expect(artifact.inputs.selection.report).toMatchObject({
      method: 'census',
      representativeOfInput: true,
      source: {
        class: { total: 1, missing: 0, counts: { positive: 1 } },
        agent: { total: 1, missing: 0, counts: { 'mini-SWE-agent': 1 } },
        model: { total: 1, missing: 0, counts: { 'test-worker': 1 } },
        difficulty: { total: 1, missing: 1, counts: {} },
        solved: { total: 1, missing: 1, counts: {} },
      },
    })
    expect(artifact.comparisons[0]).toMatchObject({
      baselineRunnerId: 'empty',
      candidateRunnerId: 'dspy-rlm',
    })
    expect(
      artifact.comparisons[0].metrics.every((metric: { inferenceLimitations: string[] }) =>
        metric.inferenceLimitations.includes('population-representativeness-not-proven'),
      ),
    ).toBe(true)
    expect(artifact.codeTraceCalibration).toMatchObject({
      protocol: 'labeled-positive-and-solved-negative',
      runners: [
        expect.objectContaining({ runnerId: 'empty', positiveRuns: 1 }),
        expect.objectContaining({
          runnerId: 'dspy-rlm',
          positiveRuns: 1,
          matchedIncorrectSteps: 1,
          precision: 1,
          recall: 1,
          f1: 1,
        }),
      ],
    })
    const report = await readFile(join(fixture.outDir, 'report.md'), 'utf8')
    expect(report).toContain('This is a census of the supplied input.')
    expect(report).toContain('CodeTraceBench Calibrated View')
    expect(report).toContain('| 1 | 1 | 0 | 0 | 1 | 0 |')
    const shareable = `${JSON.stringify(artifact)}${report}`
    expect(shareable).not.toContain('do-not-persist-this-key')
    expect(shareable).not.toContain(fixture.labelsPath)
    expect(shareable).not.toContain(fixture.traceDir)
    expect(shareable).not.toContain(fixture.artifactDir)
    expect(shareable).not.toContain('http://127.0.0.1:3355/v1')
    const manifestText = await readFile(
      join(fixture.outDir, ANALYST_BENCHMARK_MANIFEST_FILE),
      'utf8',
    )
    expect(manifestText).not.toContain(fixture.labelsPath)
    expect(manifestText).not.toContain(fixture.traceDir)
    expect(manifestText).not.toContain(fixture.artifactDir)
    expect(manifestText).not.toContain('http://127.0.0.1:3355/v1')
    const localReceipt = JSON.parse(
      await readFile(join(fixture.outDir, ANALYST_BENCHMARK_LOCAL_RECEIPT_FILE), 'utf8'),
    )
    expect(localReceipt).toMatchObject({
      kind: 'agent-eval/analyst-benchmark-local-run',
      local: {
        labelsPath: fixture.labelsPath,
        traceDir: fixture.traceDir,
        artifactDir: fixture.artifactDir,
        outputDir: fixture.outDir,
        baseUrl: 'http://127.0.0.1:3355/v1',
        apiKeyEnvironment: 'TEST_ANALYST_KEY',
      },
      files: {
        costLedger: join(fixture.outDir, ANALYST_BENCHMARK_COST_LEDGER_FILE),
        modelResponses: join(fixture.outDir, 'model-responses'),
      },
    })
    expect(JSON.stringify(localReceipt)).not.toContain('do-not-persist-this-key')
  })

  it('refuses an existing result when its cost file contains an unresolved call', async () => {
    const fixture = await agentRxFixture()
    const args = agentRxCommandArgs(fixture)
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
    }
    await runAnalystBenchmarkCommand(
      args,
      { TEST_ANALYST_KEY: 'unused' },
      {
        createAnalystRunner: () => modelRunner,
      },
    )
    await appendFile(
      join(fixture.outDir, ANALYST_BENCHMARK_COST_LEDGER_FILE),
      `${JSON.stringify({
        version: 1,
        record: {
          status: 'pending',
          callId: 'unresolved-after-result',
          channel: 'analyst',
          phase: 'analyst.public-benchmark',
          actor: 'agentrx-root-cause-localizer',
          model: 'gpt-4o',
          maximumCostUsd: 0.5,
          timestamp: 1,
        },
      })}\n`,
    )
    const createAnalystRunner = vi.fn(() => modelRunner)

    await expect(
      runAnalystBenchmarkCommand(
        [...args, '--resume'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/pending or budget-breaching cost entries/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('rejects missing labeled spans before constructing or calling a model runner', async () => {
    const fixture = await codeTraceFixture({ labeledStep: 3 })
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        commandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/missing labeled span step-3/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('runs trajectory-only cases with an explicit unavailable outcome', async () => {
    const fixture = await codeTraceFixture({ withVerificationArtifacts: false })
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      async analyze(input) {
        const trace = await input.traceStore?.viewTrace({ trace_id: 'trace-1' })
        expect(trace?.spans).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'final verification outcome: unavailable',
              status: 'UNSET',
            }),
          ]),
        )
        return { findings: [], usage: UNKNOWN_USAGE }
      },
    }
    const createAnalystRunner = vi.fn(() => modelRunner)

    await expect(
      runAnalystBenchmarkCommand(
        commandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).resolves.toBe(0)
    expect(createAnalystRunner).toHaveBeenCalledOnce()
    const artifact = JSON.parse(await readFile(join(fixture.outDir, 'result.json'), 'utf8'))
    expect(artifact.inputs.verificationArtifacts[0]).toMatchObject({
      status: 'missing',
      outcome: { status: 'unavailable', reason: 'missing-result' },
    })
    expect(artifact.inputs.verificationAvailability).toEqual({
      cases: 1,
      resultFilesPresent: 0,
      resultFilesMissing: 1,
      outcomes: { passed: 0, failed: 0, unavailable: 1 },
    })
  })

  it('rejects answer annotations in final-result artifacts before constructing the model', async () => {
    const fixture = await codeTraceFixture()
    await writeFile(
      join(fixture.artifactDir, 'trace-1', 'cases', 'trace-1', 'task-1_result.json'),
      JSON.stringify({
        resolved: false,
        failed_tests: ['hidden assertion'],
        incorrect_step_ids: [2],
      }),
    )
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        commandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/label key 'incorrect_step_ids'/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('refuses credential-bearing base URLs before constructing the model runner', async () => {
    const fixture = await codeTraceFixture()
    const args = commandArgs(fixture)
    args[args.indexOf('--base-url') + 1] = 'http://secret@127.0.0.1:3355/v1'
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(args, { TEST_ANALYST_KEY: 'unused' }, { createAnalystRunner }),
    ).rejects.toThrow(/without credentials/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('refuses remote plain HTTP before constructing the model runner', async () => {
    const fixture = await codeTraceFixture()
    const args = commandArgs(fixture)
    args[args.indexOf('--base-url') + 1] = 'http://provider.example/v1'
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(args, { TEST_ANALYST_KEY: 'unused' }, { createAnalystRunner }),
    ).rejects.toThrow(/must use HTTPS unless/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('records the consensus sample count in identity, provenance, and the result artifact', async () => {
    const fixture = await codeTraceFixture()
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      analyze: () => ({
        findings: [
          makeFinding({
            analyst_id: 'dspy-rlm',
            area: 'incorrect',
            claim: 'Step 2 changes the wrong file.',
            severity: 'high',
            confidence: 0.9,
            evidence_refs: [{ kind: 'span', uri: 'trace://trace-1/span/step-2' }],
          }),
        ],
        usage: UNKNOWN_USAGE,
      }),
    }
    const createAnalystRunner = vi.fn(
      (_dataset: unknown, config: { dspyRlm?: { samples?: number } }) => {
        expect(config.dspyRlm?.samples).toBe(3)
        return modelRunner
      },
    )

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await runAnalystBenchmarkCommand(
      [...commandArgs(fixture), '--rlm-samples', '3'],
      { TEST_ANALYST_KEY: 'secret' },
      { createAnalystRunner },
    )
    stdout.mockRestore()

    expect(code).toBe(0)
    expect(createAnalystRunner).toHaveBeenCalledTimes(1)
    const artifact = (await readAnalystBenchmarkArtifact(
      join(fixture.outDir, 'result.json'),
    )) as unknown as Record<string, any>
    expect(artifact.inputs.execution.rlmSamples).toBe(3)
    expect(artifact.result.provenance.metadata.rlmSamples).toBe(3)
    const manifest = JSON.parse(
      await readFile(join(fixture.outDir, ANALYST_BENCHMARK_MANIFEST_FILE), 'utf8'),
    )
    expect(manifest.identity.config.rlmSamples).toBe(3)
  })

  it('refuses consensus sampling with the direct analyst or outside CodeTraceBench', async () => {
    const codeTrace = await codeTraceFixture()
    const agentRx = await agentRxFixture()
    const createAnalystRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        [...commandArgs(codeTrace), '--analyst', 'direct', '--rlm-samples', '2'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/--rlm-samples above 1 requires --analyst dspy-rlm/)
    await expect(
      runAnalystBenchmarkCommand(
        [...agentRxCommandArgs(agentRx), '--rlm-samples', '2'],
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner },
      ),
    ).rejects.toThrow(/--rlm-samples above 1 requires --dataset codetracebench/)
    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('rejects branch names and short revision hashes before constructing a runner', async () => {
    const fixture = await codeTraceFixture()
    const createAnalystRunner = vi.fn()

    for (const revision of ['main', 'abc123']) {
      const args = commandArgs(fixture)
      args[args.indexOf('--revision') + 1] = revision
      await expect(
        runAnalystBenchmarkCommand(args, { TEST_ANALYST_KEY: 'unused' }, { createAnalystRunner }),
      ).rejects.toThrow(/full 40- or 64-character hexadecimal digest/)
    }

    expect(createAnalystRunner).not.toHaveBeenCalled()
  })

  it('runs AgentRx without imposing CodeTraceBench artifact requirements', async () => {
    const fixture = await agentRxFixture()
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      analyze() {
        return {
          findings: [
            makeFinding({
              analyst_id: 'dspy-rlm',
              area: 'system-failure',
              claim: 'The worker lost its provider at the root step.',
              severity: 'high',
              confidence: 0.9,
              evidence_refs: [{ kind: 'span', uri: 'trace://rx-1/span/step-1' }],
              metadata: { step_mean: 1 },
            }),
          ],
          usage: UNKNOWN_USAGE,
        }
      },
    }

    await expect(
      runAnalystBenchmarkCommand(
        agentRxCommandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner: () => modelRunner },
      ),
    ).resolves.toBe(0)

    const artifact = JSON.parse(
      await readFile(join(fixture.outDir, 'result.json'), 'utf8'),
    ) as Record<string, any>
    expect(artifact.inputs.datasetRevision).toBe(AGENT_RX_TEST_REVISION)
    expect(artifact.inputs.verificationArtifacts).toEqual([])
    expect(artifact.inputs.artifactDir).toBeUndefined()
    expect(artifact.inputs.selection.report.source).toMatchObject({
      class: { total: 1, missing: 0, counts: { 'system-failure': 1 } },
      agent: { total: 1, missing: 0, counts: { worker: 1 } },
      model: { total: 1, missing: 1, counts: {} },
    })
    expect(
      artifact.result.summaries.map((summary: { runnerId: string }) => summary.runnerId),
    ).toEqual(['empty', 'dspy-rlm'])
    expect(artifact.agentRxCalibration).toMatchObject({
      protocol: 'official-agentrx-root-cause',
      upstreamRevision: AGENT_RX_UPSTREAM_REVISION,
      runners: [
        expect.objectContaining({
          runnerId: 'empty',
          predictedRuns: 0,
          exactStepAccuracy: 0,
        }),
        expect.objectContaining({
          runnerId: 'dspy-rlm',
          predictedRuns: 1,
          exactStepAccuracy: 1,
          rootCauseCategoryAccuracy: 1,
        }),
      ],
    })
    expect(await readFile(join(fixture.outDir, 'report.md'), 'utf8')).toContain(
      'AgentRx Published Metrics',
    )
  })

  it('does not treat a supplied-input census as representative of the upstream population', async () => {
    const fixture = await agentRxFixture({ caseCount: 20 })
    const args = agentRxCommandArgs(fixture)
    args[args.indexOf('--limit') + 1] = '20'

    await runAnalystBenchmarkCommand(
      args,
      { TEST_ANALYST_KEY: 'unused' },
      {
        createAnalystRunner: () => ({
          id: 'dspy-rlm',
          analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
        }),
      },
    )

    const artifact = await readAnalystBenchmarkArtifact(join(fixture.outDir, 'result.json'))
    expect(artifact.inputs.selection.report).toMatchObject({
      method: 'census',
      sourceCount: 20,
      selectedCount: 20,
      representativeOfInput: true,
    })
    expect(artifact.result.provenance.metadata?.populationRepresentativenessProven).toBe(false)
    expect(
      artifact.comparisons[0]?.metrics.find((metric) => metric.metric === 'completion'),
    ).toMatchObject({
      pairedClusters: 20,
      minimumSampleMet: true,
      populationInferenceEligible: false,
      inferenceLimitations: ['population-representativeness-not-proven'],
    })
  })

  it('returns a failing exit code without discarding failed model usage', async () => {
    const fixture = await agentRxFixture()
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'dspy-rlm',
      analyze() {
        return {
          findings: [],
          usage: {
            calls: 8,
            tokens: null,
            cost: { kind: 'uncaptured', usd: null },
            knownCostUsd: 0.09,
          },
          error: {
            class: 'AnalystRunFailure',
            message: 'root-cause-localizer: Error: invalid provider response',
          },
        }
      },
    }

    await expect(
      runAnalystBenchmarkCommand(
        agentRxCommandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createAnalystRunner: () => modelRunner },
      ),
    ).resolves.toBe(2)

    const artifact = JSON.parse(
      await readFile(join(fixture.outDir, 'result.json'), 'utf8'),
    ) as Record<string, any>
    expect(artifact.result.summaries[1]).toMatchObject({
      runnerId: 'dspy-rlm',
      completedRuns: 0,
      failedRuns: 1,
      calls: 8,
      knownCostUsd: 0.09,
      costUnknownRuns: 1,
    })
    expect(artifact.result.observations[1]).toMatchObject({
      usage: { calls: 8, knownCostUsd: 0.09 },
      error: {
        class: 'AnalystRunFailure',
        message: 'root-cause-localizer: Error: invalid provider response',
      },
    })
  })

  it('binds model calls to the durable run-wide spend limit', async () => {
    const fixture = await agentRxFixture()
    const execute = vi.fn(async () => 'should not run')

    await expect(
      runAnalystBenchmarkCommand(
        [...agentRxCommandArgs(fixture), '--max-cost-usd', '0.25'],
        { TEST_ANALYST_KEY: 'unused' },
        {
          createAnalystRunner: (_dataset, config) => ({
            id: 'dspy-rlm',
            async analyze() {
              const denied = await config.costLedger!.runPaidCall({
                channel: 'analyst',
                phase: 'benchmark',
                actor: 'test-model',
                model: 'gpt-4o-mini',
                maximumCharge: { externallyEnforcedMaximumUsd: 0.26 },
                execute,
                receipt: () => ({
                  model: 'gpt-4o-mini',
                  inputTokens: 1,
                  outputTokens: 1,
                }),
              })
              if (denied.succeeded) throw new Error('cost limit admitted the provider call')
              throw denied.error
            },
          }),
        },
      ),
    ).rejects.toThrow(/would exceed ceiling 0.25/)

    expect(execute).not.toHaveBeenCalled()
    const costEvents = await readFile(
      join(fixture.outDir, ANALYST_BENCHMARK_COST_LEDGER_FILE),
      'utf8',
    )
    expect(costEvents).toContain('"costCeilingUsd":0.25')
    const observations = await readFile(
      join(fixture.outDir, ANALYST_BENCHMARK_OBSERVATIONS_FILE),
      'utf8',
    )
    expect(observations).not.toContain('"runnerId":"model"')
    await expect(readFile(join(fixture.outDir, 'result.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('finalizes when a completed analysis has one settled call the provider under-reported', async () => {
    const fixture = await agentRxFixture()
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await runAnalystBenchmarkCommand(
      agentRxCommandArgs(fixture),
      { TEST_ANALYST_KEY: 'unused' },
      {
        createAnalystRunner: (_dataset, config) => ({
          id: 'dspy-rlm',
          async analyze(_input, context) {
            // A settled provider response that omitted usage: cost is flagged
            // unknown, the call did not fail, and the analysis completes.
            const paid = await config.costLedger!.runPaidCall({
              channel: 'analyst',
              phase: 'analyst.public-benchmark',
              actor: 'agentrx-root-cause-localizer',
              model: 'glm-5.2',
              maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
              tags: {
                analystId: 'agentrx-root-cause-localizer',
                benchmarkCaseId: context.caseId,
                benchmarkRepetition: String(context.repetition),
              },
              async execute() {
                return { model: 'glm-5.2', inputTokens: 0, outputTokens: 0, usageUnknown: true }
              },
              receipt: (value) => value,
            })
            if (!paid.succeeded) throw paid.error
            return { findings: [], usage: UNKNOWN_USAGE, metadata: { caseId: context.caseId } }
          },
        }),
      },
    )
    const output = stdout.mock.calls.map(([value]) => String(value)).join('')
    stdout.mockRestore()

    expect(code).toBe(0)
    expect(output).toContain(`result=${join(fixture.outDir, 'result.json')}`)
    expect(output).toMatch(/unknown_cost_runs=[1-9]/)
    await expect(readFile(join(fixture.outDir, 'result.json'), 'utf8')).resolves.toContain(
      'analyst-benchmark-result',
    )
  })

  it('records a provider failure as a scored failure and still finalizes', async () => {
    const fixture = await agentRxFixture()
    const secret = 'sk-provider-body-secret'
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const code = await runAnalystBenchmarkCommand(
      agentRxCommandArgs(fixture),
      { TEST_ANALYST_KEY: 'unused' },
      {
        createAnalystRunner: (_dataset, config) => ({
          id: 'dspy-rlm',
          async analyze(_input, context) {
            const paid = await config.costLedger!.runPaidCall({
              channel: 'analyst',
              phase: 'analyst.public-benchmark',
              actor: 'agentrx-root-cause-localizer',
              model: 'unknown-provider-model',
              maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
              tags: {
                analystId: 'agentrx-root-cause-localizer',
                benchmarkCaseId: context.caseId,
                benchmarkRepetition: String(context.repetition),
              },
              async execute() {
                throw new Error(`malformed response Bearer ${secret}`)
              },
              receipt: () => ({
                model: 'unknown-provider-model',
                inputTokens: 0,
                outputTokens: 0,
              }),
            })
            if (paid.succeeded) throw new Error('provider failure unexpectedly succeeded')
            throw paid.error
          },
        }),
      },
    )
    stdout.mockRestore()

    // A failed provider call settles as a recorded failure: the run finalizes
    // with a non-zero exit, the case is scored as a failure, the secret never
    // leaks, and its cost is flagged rather than fabricated.
    expect(code).not.toBe(0)
    const costEvents = await readFile(
      join(fixture.outDir, ANALYST_BENCHMARK_COST_LEDGER_FILE),
      'utf8',
    )
    expect(costEvents).not.toContain(secret)
    expect(costEvents).toContain('"error":"paid-call-failed"')
    await expect(readFile(join(fixture.outDir, 'result.json'), 'utf8')).resolves.toContain(
      'analyst-benchmark-result',
    )
  })

  it.each(['0', '-1', 'NaN', 'Infinity'])(
    'rejects invalid run-wide spend limit %s before model construction',
    async (value) => {
      const fixture = await agentRxFixture()
      const createAnalystRunner = vi.fn()

      await expect(
        runAnalystBenchmarkCommand(
          [...agentRxCommandArgs(fixture), '--max-cost-usd', value],
          { TEST_ANALYST_KEY: 'unused' },
          { createAnalystRunner },
        ),
      ).rejects.toThrow(/max-cost-usd must be a positive finite number/)
      expect(createAnalystRunner).not.toHaveBeenCalled()
    },
  )
})
