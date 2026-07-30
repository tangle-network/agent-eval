import { describe, expect, it } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import {
  type AnalystBenchmarkRunner,
  registryBenchmarkRunner,
  runAnalystBenchmark,
  traceStoreEvidenceResolver,
} from './benchmark'
import { badCase, cleanCase } from './benchmark-test-fixtures'
import { AnalystRegistry } from './registry'
import type { AnalystRunInputs, AnalystUsageReceipt } from './types'

describe('runAnalystBenchmark', () => {
  it('retains externally measured latency instead of timing prediction-file reads', async () => {
    const result = await runAnalystBenchmark({
      cases: [cleanCase],
      runners: [
        {
          id: 'imported',
          analyze: () => ({ findings: [], observedLatencyMs: 12_345 }),
        },
      ],
    })

    expect(result.observations[0]).toMatchObject({
      latencyMs: 12_345,
      latencySource: 'runner-reported',
    })
    expect(result.summaries[0]).toMatchObject({
      benchmarkClockLatencyRuns: 0,
      runnerReportedLatencyRuns: 1,
      latencyUnknownRuns: 0,
      latencyMs: {
        min: 12_345,
        mean: 12_345,
        p50: 12_345,
        p95: 12_345,
        max: 12_345,
      },
    })
  })

  it('fails an imported run with an invalid observed duration', async () => {
    const result = await runAnalystBenchmark({
      cases: [cleanCase],
      runners: [
        {
          id: 'invalid-import',
          analyze: () => ({ findings: [], observedLatencyMs: Number.NaN }),
        },
      ],
    })

    expect(result.observations[0]).toMatchObject({
      latencySource: 'benchmark-clock',
      error: {
        class: 'RangeError',
        message: 'analyst benchmark observedLatencyMs must be finite and non-negative',
      },
    })
  })

  it('fails imported runs with invalid usage instead of publishing corrupt totals', async () => {
    const invalidReceipts: Array<{ field: string; usage: AnalystUsageReceipt }> = [
      {
        field: 'calls',
        usage: {
          calls: -1,
          tokens: { input: 1, output: 1 },
          cost: { kind: 'observed', usd: 0 },
        },
      },
      {
        field: 'tokens.input',
        usage: {
          calls: 1,
          tokens: { input: Number.NaN, output: 1 },
          cost: { kind: 'observed', usd: 0 },
        },
      },
      {
        field: 'tokens.output',
        usage: {
          calls: 1,
          tokens: { input: 1, output: 1.5 },
          cost: { kind: 'observed', usd: 0 },
        },
      },
      {
        field: 'cost.usd',
        usage: {
          calls: 1,
          tokens: { input: 1, output: 1 },
          cost: { kind: 'estimated', usd: -0.01 },
        },
      },
    ]

    for (const { field, usage } of invalidReceipts) {
      const result = await runAnalystBenchmark({
        cases: [cleanCase],
        runners: [{ id: field, analyze: () => ({ findings: [], usage }) }],
      })
      expect(result.summaries[0]).toMatchObject({ completedRuns: 0, failedRuns: 1 })
      expect(result.observations[0]?.error?.message).toContain(field)
      expect(result.observations[0]?.usage).toBeUndefined()
    }
  })

  it('keeps explicitly uncaptured imported duration out of latency statistics', async () => {
    const result = await runAnalystBenchmark({
      cases: [cleanCase],
      runners: [
        {
          id: 'imported-without-duration',
          analyze: () => ({ findings: [], observedLatencyMs: null }),
        },
      ],
    })

    expect(result.observations[0]).toMatchObject({
      latencyMs: null,
      latencySource: 'uncaptured',
    })
    expect(result.summaries[0]).toMatchObject({
      latencyMs: null,
      benchmarkClockLatencyRuns: 0,
      runnerReportedLatencyRuns: 0,
      latencyUnknownRuns: 1,
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
    expect(result.summaries[0]?.predictionAgreement).toBeNull()
    expect(result.summaries[0]?.matchedLabelAgreement).toBeNull()
  })

  it('does not report success when cancellation happens during the final job', async () => {
    const controller = new AbortController()

    await expect(
      runAnalystBenchmark({
        cases: [cleanCase],
        runners: [
          {
            id: 'canceling',
            analyze() {
              controller.abort(new Error('benchmark canceled'))
              return { findings: [] }
            },
          },
        ],
        signal: controller.signal,
      }),
    ).rejects.toThrow('benchmark canceled')
  })

  it('retains registry usage and diagnostics when an analyst fails', async () => {
    const registry = new AnalystRegistry()
    registry.register({
      id: 'broken',
      description: 'Fails after recording provider usage.',
      inputKind: 'custom',
      cost: { kind: 'llm' },
      version: '1.0.0',
      async analyze(_input, context) {
        context.recordUsage?.({
          calls: 1,
          tokens: { input: 10, output: 2 },
          cost: { kind: 'observed', usd: 0.01 },
        })
        throw new Error('invalid provider response')
      },
    })
    const input: AnalystRunInputs = { custom: { broken: {} } }

    const result = await runAnalystBenchmark({
      cases: [{ ...badCase, input }],
      runners: [
        registryBenchmarkRunner({
          id: 'registry',
          registry,
          failOnAnalystFailure: true,
        }),
      ],
    })

    expect(result.observations[0]).toMatchObject({
      error: {
        class: 'AnalystRunFailure',
        message: 'broken: Error: invalid provider response',
      },
      usage: {
        calls: 1,
        tokens: { input: 10, output: 2 },
        cost: { kind: 'observed', usd: 0.01 },
      },
    })
    expect(result.summaries[0]).toMatchObject({
      completedRuns: 0,
      failedRuns: 1,
      calls: 1,
      inputTokens: 10,
      outputTokens: 2,
      knownCostUsd: 0.01,
    })
  })

  it('retains imported telemetry when an external runner reports failure', async () => {
    const result = await runAnalystBenchmark({
      cases: [badCase],
      runners: [
        {
          id: 'external',
          analyze() {
            return {
              findings: [],
              observedLatencyMs: 23_900,
              usage: {
                calls: 2,
                tokens: { input: 3_765, output: 1_231 },
                cost: { kind: 'observed', usd: 0.0496 },
              },
              metadata: { outputStatus: 'missing' },
              error: {
                class: 'MissingUpstreamPrediction',
                message: 'upstream reported success without a prediction file',
              },
            }
          },
        },
      ],
    })

    expect(result.observations[0]).toMatchObject({
      latencyMs: 23_900,
      latencySource: 'runner-reported',
      usage: {
        calls: 2,
        tokens: { input: 3_765, output: 1_231 },
        cost: { kind: 'observed', usd: 0.0496 },
      },
      runnerMetadata: { outputStatus: 'missing' },
      error: {
        class: 'MissingUpstreamPrediction',
        message: 'upstream reported success without a prediction file',
      },
    })
    expect(result.summaries[0]).toMatchObject({
      completedRuns: 0,
      failedRuns: 1,
      benchmarkClockLatencyRuns: 0,
      runnerReportedLatencyRuns: 1,
      latencyUnknownRuns: 0,
      calls: 2,
      inputTokens: 3_765,
      outputTokens: 1_231,
      knownCostUsd: 0.0496,
      callsUnknownRuns: 0,
      tokenUsageUnknownRuns: 0,
      costUnknownRuns: 0,
    })
  })

  it('resumes exact planned jobs without rerunning persisted observations', async () => {
    let calls = 0
    const runner: AnalystBenchmarkRunner<string> = {
      id: 'resumable',
      analyze() {
        calls += 1
        return { findings: [] }
      },
    }
    const first = await runAnalystBenchmark({ cases: [cleanCase], runners: [runner] })
    expect(calls).toBe(1)

    const resumed = await runAnalystBenchmark({
      cases: [cleanCase],
      runners: [runner],
      initialObservations: first.observations,
    })

    expect(calls).toBe(1)
    expect(resumed.observations).toEqual(first.observations)
    expect(resumed.summaries).toEqual(first.summaries)
  })

  it('rejects persisted rows that do not match the current plan', async () => {
    const runner: AnalystBenchmarkRunner<string> = {
      id: 'resumable',
      analyze: () => ({ findings: [] }),
    }
    const first = await runAnalystBenchmark({ cases: [cleanCase], runners: [runner] })

    await expect(
      runAnalystBenchmark({
        cases: [cleanCase],
        runners: [runner],
        initialObservations: [
          {
            ...first.observations[0]!,
            clusterId: 'different-task',
          },
        ],
      }),
    ).rejects.toThrow(/does not match the current case labels/)
    await expect(
      runAnalystBenchmark({
        cases: [cleanCase],
        runners: [runner],
        initialObservations: [
          {
            ...first.observations[0]!,
            score: {
              ...first.observations[0]!.score,
              f1: 0,
            },
          },
        ],
      }),
    ).rejects.toThrow(/stale or invalid scores/)
  })

  it('requires explicit, internally consistent case labels', async () => {
    const runner: AnalystBenchmarkRunner<string> = {
      id: 'noop',
      analyze: () => ({ findings: [] }),
    }
    await expect(
      runAnalystBenchmark({
        cases: [{ ...cleanCase, labelState: 'positive' }],
        runners: [runner],
      }),
    ).rejects.toThrow(/positive case requires/)
    await expect(
      runAnalystBenchmark({
        cases: [{ ...badCase, labelState: 'unlabeled' }],
        runners: [runner],
      }),
    ).rejects.toThrow(/unlabeled case cannot contain/)
    await expect(
      runAnalystBenchmark({
        cases: [{ ...cleanCase, clusterId: '' }],
        runners: [runner],
      }),
    ).rejects.toThrow(/clusterId must not be empty/)
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
    let receivedSignal: AbortSignal | undefined
    const traceStore = {
      async viewSpans(
        input: { trace_id: string; span_ids: readonly string[] },
        options?: { signal?: AbortSignal },
      ) {
        requests.push(input)
        receivedSignal = options?.signal
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
    const controller = new AbortController()

    await expect(
      resolve({
        ...context,
        evidence: { kind: 'span', uri: 'trace://run%2Fa/span/span%2Fb' },
        signal: controller.signal,
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
    expect(receivedSignal).toBe(controller.signal)
  })
})
