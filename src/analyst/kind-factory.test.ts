import { describe, expect, it, vi } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import type { TraceAnalysisEngine, TraceAnalysisEngineRequest } from './engine'
import { createTraceAnalyst, runTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import { makeFinding } from './types'

const spans: TraceAnalystSpan[] = [
  traceSpan('step-1', 'candidate'),
  traceSpan('step-2', '401 unauthorized'),
]
const store = traceStore(spans)
const definition: TraceAnalystDefinition = {
  id: 'test-research',
  description: 'Find the causal failure.',
  area: 'failure-mode',
  version: '1.0.0',
  question: 'What caused the failure?',
  instructions: 'Inspect exact spans and cite them.',
  toolGroup: 'discovery',
  limits: {
    maxIterations: 6,
    maxLlmCalls: 3,
    maxToolCalls: 12,
    maxOutputChars: 2_000,
  },
}

function context() {
  return {
    runId: 'run-1',
    correlationId: 'analysis-1',
    tags: { suite: 'unit' },
  }
}

describe('runTraceAnalyst', () => {
  it('binds a definition to an engine and retains the investigation record', async () => {
    let request: TraceAnalysisEngineRequest | undefined
    const engine = fakeEngine(async (input) => {
      request = input
      return {
        answer: 'The first tool call failed authentication.',
        findings: [
          {
            severity: 'high',
            claim: 'Authentication failed before useful work began.',
            subject: 'auth-failure',
            confidence: 0.95,
            evidence: [
              {
                uri: 'trace://run-1/span/step-2',
                excerpt: '401 unauthorized',
              },
            ],
          },
        ],
        trajectory: [{ code: 'overview = getDatasetOverview()' }],
        modelCalls: 2,
        toolCalls: 3,
        runtime: { engine: 'test' },
      }
    })

    const result = await runTraceAnalyst({
      definition,
      engine,
      store,
      context: context(),
    })

    expect(request).toMatchObject({
      analystId: 'test-research',
      question: 'What caused the failure?',
      limits: {
        maxIterations: 6,
        maxLlmCalls: 3,
        maxToolCalls: 12,
        maxOutputChars: 2_000,
      },
      costPhase: 'trace-analysis',
    })
    expect(request?.tools.map((tool) => tool.name)).toEqual([
      'getDatasetOverview',
      'queryTraces',
      'countTraces',
    ])
    expect(request?.instructions).toContain('strict findings array')
    expect(result.findings).toHaveLength(1)
    expect(result.trajectory).toHaveLength(1)
  })

  it('applies a null post-processor as a rejection', async () => {
    const result = await runTraceAnalyst({
      definition: { ...definition, postProcess: () => null },
      engine: fakeEngine(async () => ({
        answer: 'A candidate was investigated.',
        findings: [
          {
            severity: 'low',
            claim: 'Rejected candidate.',
            confidence: 0.5,
            evidence: [{ uri: 'trace://run-1/span/step-1' }],
          },
        ],
        trajectory: [],
        modelCalls: 1,
        toolCalls: 1,
        runtime: {},
      })),
      store,
      context: context(),
    })

    expect(result.findings).toEqual([])
  })

  it('fails when a definition requires findings and the engine abstains', async () => {
    await expect(
      runTraceAnalyst({
        definition: { ...definition, requireStructuredFindings: true },
        engine: fakeEngine(async () => ({
          answer: 'No supported issue was found.',
          findings: [],
          trajectory: [],
          modelCalls: 1,
          toolCalls: 1,
          runtime: {},
        })),
        store,
        context: context(),
      }),
    ).rejects.toThrow(/returned no valid structured findings/)
  })

  it('rejects transformed trace and span identifiers', async () => {
    const log = vi.fn()
    const result = await runTraceAnalyst({
      definition,
      engine: findingEngine({
        uri: 'trace://cnVuLTE=/span/c3RlcC0y',
        excerpt: '401 unauthorized',
      }),
      store,
      context: { ...context(), log },
    })

    expect(result.findings).toEqual([])
    expect(log).toHaveBeenCalledWith('finding rejected: unresolved evidence', {
      uri: 'trace://cnVuLTE=/span/c3RlcC0y',
      reason: 'trace span does not exist',
    })
  })

  it('rejects a nonexistent trace span', async () => {
    const log = vi.fn()
    const result = await runTraceAnalyst({
      definition,
      engine: findingEngine({ uri: 'trace://run-1/span/step-99' }),
      store,
      context: { ...context(), log },
    })

    expect(result.findings).toEqual([])
    expect(log).toHaveBeenCalledWith('finding rejected: unresolved evidence', {
      uri: 'trace://run-1/span/step-99',
      reason: 'trace span does not exist',
    })
  })

  it('rejects an excerpt that is absent from the cited span', async () => {
    const log = vi.fn()
    const result = await runTraceAnalyst({
      definition,
      engine: findingEngine({
        uri: 'trace://run-1/span/step-2',
        excerpt: 'authentication succeeded',
      }),
      store,
      context: { ...context(), log },
    })

    expect(result.findings).toEqual([])
    expect(log).toHaveBeenCalledWith('finding rejected: unresolved evidence', {
      uri: 'trace://run-1/span/step-2',
      reason: 'excerpt is not present in the cited span content',
    })
  })

  it.each([
    ['message.assistant', 'span name'],
    ['test-agent', 'agent name'],
    ['2026-07-30T00:00:00.000Z', 'timestamp'],
  ])('rejects the fabricated excerpt %s quoting a %s instead of content', async (excerpt) => {
    const log = vi.fn()
    const result = await runTraceAnalyst({
      definition,
      engine: findingEngine({ uri: 'trace://run-1/span/step-2', excerpt }),
      store,
      context: { ...context(), log },
    })

    expect(result.findings).toEqual([])
    expect(log).toHaveBeenCalledWith('finding rejected: unresolved evidence', {
      uri: 'trace://run-1/span/step-2',
      reason: 'excerpt is not present in the cited span content',
    })
  })

  it.each([['step-2'], ['OK'], ['0']])(
    'rejects the excerpt %s as too short to verify',
    async (excerpt) => {
      const log = vi.fn()
      const result = await runTraceAnalyst({
        definition,
        engine: findingEngine({ uri: 'trace://run-1/span/step-2', excerpt }),
        store,
        context: { ...context(), log },
      })

      expect(result.findings).toEqual([])
      expect(log).toHaveBeenCalledWith('finding rejected: unresolved evidence', {
        uri: 'trace://run-1/span/step-2',
        reason: 'excerpt is too short to verify',
      })
    },
  )

  it('accepts a supplied finding citation and checks its excerpt', async () => {
    const prior = makeFinding({
      analyst_id: 'prior-analyst',
      area: 'failure-mode',
      claim: 'Authentication failed before the first useful tool call.',
      severity: 'high',
      confidence: 0.9,
      evidence_refs: [{ kind: 'span', uri: 'trace://run-1/span/step-2' }],
    })
    const result = await runTraceAnalyst({
      definition,
      engine: findingEngine({
        uri: `finding://${encodeURIComponent(prior.finding_id)}`,
        excerpt: 'first useful tool call',
      }),
      store,
      context: { ...context(), priorFindings: [prior] },
    })

    expect(result.findings).toHaveLength(1)
  })
})

describe('createTraceAnalyst', () => {
  it('maps engine findings into registry findings with execution metadata', async () => {
    const analyst = createTraceAnalyst(definition, {
      engine: fakeEngine(async () => ({
        answer: 'The tool failed.',
        findings: [
          {
            severity: 'high',
            claim: 'The tool failed.',
            confidence: 0.9,
            evidence: [{ uri: 'trace://run-1/span/step-2' }],
          },
        ],
        trajectory: [{ code: 'viewSpans(...)' }],
        modelCalls: 3,
        toolCalls: 4,
        runtime: { dspy: '3.2.1' },
      })),
      versionSuffix: 'optimized',
    })
    const findings = await analyst.analyze(store, context())

    expect(analyst.version).toBe('1.0.0+optimized')
    expect(analyst.cost.models).toEqual(['test-model'])
    expect(findings[0]).toMatchObject({
      analyst_id: 'test-research',
      area: 'failure-mode',
      claim: 'The tool failed.',
      metadata: {
        analysis_engine: 'test-engine',
        analysis_model: 'test-model',
        analysis_model_calls: 3,
        analysis_tool_calls: 4,
        analysis_runtime: { dspy: '3.2.1' },
      },
    })
  })

  it('records an empty usage receipt without inventing model tokens', async () => {
    const recordUsage = vi.fn()
    const analyst = createTraceAnalyst(definition, {
      engine: fakeEngine(async () => ({
        answer: 'No issue.',
        findings: [],
        trajectory: [],
        modelCalls: 1,
        toolCalls: 1,
        runtime: {},
      })),
    })

    await analyst.analyze(store, { ...context(), recordUsage })

    expect(recordUsage).toHaveBeenCalledWith({
      calls: 0,
      tokens: { input: 0, output: 0 },
      cost: { kind: 'observed', usd: 0 },
    })
  })
})

function fakeEngine(analyze: TraceAnalysisEngine['analyze']): TraceAnalysisEngine {
  return {
    id: 'test-engine',
    description: 'test',
    model: 'test-model',
    analyze,
  }
}

function findingEngine(evidence: { uri: string; excerpt?: string }): TraceAnalysisEngine {
  return fakeEngine(async () => ({
    answer: 'Authentication failed.',
    findings: [
      {
        severity: 'high',
        claim: 'Authentication failed before useful work began.',
        confidence: 0.95,
        evidence: [evidence],
      },
    ],
    trajectory: [],
    modelCalls: 1,
    toolCalls: 1,
    runtime: {},
  }))
}

function traceSpan(spanId: string, content: string): TraceAnalystSpan {
  return {
    trace_id: 'run-1',
    span_id: spanId,
    parent_span_id: null,
    name: 'message.assistant',
    kind: 'LLM',
    start_time: '2026-07-30T00:00:00.000Z',
    end_time: '2026-07-30T00:00:01.000Z',
    duration_ms: 1_000,
    status: 'OK',
    service_name: 'test',
    agent_name: 'test-agent',
    model_name: 'test-model',
    tool_name: null,
    attributes: { content },
  }
}

function traceStore(rows: TraceAnalystSpan[]): TraceAnalysisStore {
  const store: Pick<TraceAnalysisStore, 'hasSpans' | 'viewSpans'> = {
    async hasSpans({ trace_id, span_ids }) {
      return rows
        .filter((span) => span.trace_id === trace_id && span_ids.includes(span.span_id))
        .map((span) => span.span_id)
    },
    async viewSpans({ trace_id, span_ids }) {
      const found = rows.filter(
        (span) => span.trace_id === trace_id && span_ids.includes(span.span_id),
      )
      const foundIds = new Set(found.map((span) => span.span_id))
      return {
        trace_id,
        spans: found,
        missing_span_ids: span_ids.filter((spanId) => !foundIds.has(spanId)),
        omitted_span_ids: [],
        has_more: false,
        truncated_attribute_count: 0,
      }
    },
  }
  return store as unknown as TraceAnalysisStore
}
