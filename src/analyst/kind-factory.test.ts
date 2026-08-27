import { describe, expect, it, vi } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import type { TraceAnalysisEngine, TraceAnalysisEngineRequest } from './engine'
import {
  createTraceAnalyst,
  resolveCitedTurnRole,
  runTraceAnalyst,
  type TraceAnalystDefinition,
} from './kind-factory'
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

/**
 * Turn roles are carried inside serialized message arrays, not as a span-level
 * attribute — the shape `tests/fixtures/trace-analyst/tiny-trace.jsonl` and
 * `src/trace/store-to-otlp.ts` emit. `step-1` / `step-2` above carry no message
 * array at all, which is how an unlabelled dataset reads.
 */
describe('required cited turn roles', () => {
  const CORRECTION = 'stop rewriting the config, I asked for the parser'
  const ANCHOR = 'I will rewrite the config file first.'
  const conversationSpans: TraceAnalystSpan[] = [
    ...spans,
    turnSpan('human-1', { 'llm.input_messages': [{ role: 'user', content: CORRECTION }] }),
    turnSpan('assistant-1', { 'llm.output_messages': [{ role: 'assistant', content: ANCHOR }] }),
    turnSpan('assistant-2', {
      'llm.output_messages': [{ role: 'assistant', content: 'Rewriting the config file now.' }],
    }),
  ]
  const conversationStore = traceStore(conversationSpans)
  const pairDefinition: TraceAnalystDefinition = {
    ...definition,
    minimumEvidenceCitations: 2,
    requiredCitedTurnRoles: ['human', 'assistant'],
  }

  it('accepts a finding that quotes one human turn and one assistant turn', async () => {
    const result = await runTraceAnalyst({
      definition: pairDefinition,
      engine: citationEngine([
        { uri: 'trace://run-1/span/assistant-1', excerpt: ANCHOR },
        { uri: 'trace://run-1/span/human-1', excerpt: CORRECTION },
      ]),
      store: conversationStore,
      context: context(),
    })

    expect(result.findings).toHaveLength(1)
  })

  it('rejects two assistant turns, which the citation count alone admits', async () => {
    const log = vi.fn()
    const engine = citationEngine([
      { uri: 'trace://run-1/span/assistant-1', excerpt: ANCHOR },
      { uri: 'trace://run-1/span/assistant-2', excerpt: 'Rewriting the config file now.' },
    ])
    const countOnly = await runTraceAnalyst({
      definition: { ...definition, minimumEvidenceCitations: 2 },
      engine,
      store: conversationStore,
      context: context(),
    })
    // Two distinct URIs satisfy the count while quoting nothing the user said.
    expect(countOnly.findings).toHaveLength(1)

    const result = await runTraceAnalyst({
      definition: pairDefinition,
      engine,
      store: conversationStore,
      context: { ...context(), log },
    })

    expect(result.findings).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'finding rejected: citations do not cover the required turn roles',
      {
        analyst_id: 'test-research',
        required: ['human', 'assistant'],
        resolved: ['assistant', 'assistant'],
      },
    )
  })

  it('rejects a resolvable half of the pair rather than assuming the other half', async () => {
    const result = await runTraceAnalyst({
      definition: pairDefinition,
      engine: citationEngine([
        { uri: 'trace://run-1/span/human-1', excerpt: CORRECTION },
        { uri: 'trace://run-1/span/step-1', excerpt: 'candidate' },
      ]),
      store: conversationStore,
      context: context(),
    })

    expect(result.findings).toEqual([])
  })

  it('degrades to the citation count when no cited span labels a speaker', async () => {
    const result = await runTraceAnalyst({
      definition: pairDefinition,
      engine: citationEngine([
        { uri: 'trace://run-1/span/step-1', excerpt: 'candidate' },
        { uri: 'trace://run-1/span/step-2', excerpt: '401 unauthorized' },
      ]),
      store: conversationStore,
      context: context(),
    })

    expect(result.findings).toHaveLength(1)
  })

  it('accepts the pair alongside an unlabelled citation', async () => {
    const result = await runTraceAnalyst({
      definition: pairDefinition,
      engine: citationEngine([
        { uri: 'trace://run-1/span/step-1', excerpt: 'candidate' },
        { uri: 'trace://run-1/span/human-1', excerpt: CORRECTION },
        { uri: 'trace://run-1/span/assistant-1', excerpt: ANCHOR },
      ]),
      store: conversationStore,
      context: context(),
    })

    expect(result.findings).toHaveLength(1)
  })

  it('reads no span a kind without the rule would not have read', async () => {
    const viewSpans = vi.fn(conversationStore.viewSpans.bind(conversationStore))
    const countingStore = { ...conversationStore, viewSpans } as TraceAnalysisStore
    const citations = [
      { uri: 'trace://run-1/span/human-1' },
      { uri: 'trace://run-1/span/assistant-1' },
    ]

    await runTraceAnalyst({
      definition,
      engine: citationEngine(citations),
      store: countingStore,
      context: context(),
    })
    expect(viewSpans).not.toHaveBeenCalled()

    await runTraceAnalyst({
      definition: pairDefinition,
      engine: citationEngine(citations),
      store: countingStore,
      context: context(),
    })
    expect(viewSpans).toHaveBeenCalledTimes(2)
  })

  it('seals the rule into the execution config', () => {
    expect(
      createTraceAnalyst(pairDefinition, { engine: stubEngine() }).executionConfig,
    ).toMatchObject({ required_cited_turn_roles: ['assistant', 'human'] })
    expect(createTraceAnalyst(definition, { engine: stubEngine() }).executionConfig).toMatchObject({
      required_cited_turn_roles: [],
    })
  })

  it('rejects a role outside the human/assistant vocabulary', () => {
    expect(() =>
      createTraceAnalyst(
        { ...definition, requiredCitedTurnRoles: ['tool'] as unknown as ['human'] },
        { engine: stubEngine() },
      ),
    ).toThrow(/requiredCitedTurnRoles/)
  })
})

describe('resolveCitedTurnRole', () => {
  const conversation = {
    'llm.input_messages': JSON.stringify([
      { role: 'system', content: 'You are a careful engineer.' },
      { role: 'user', content: 'stop touching the config' },
    ]),
    'llm.output_messages': JSON.stringify([
      { role: 'assistant', content: 'Rewriting the config file now.' },
    ]),
  }

  it('attributes the quote, not the span, when one span holds both sides', () => {
    expect(resolveCitedTurnRole(conversation, 'stop touching the config')).toBe('human')
    expect(resolveCitedTurnRole(conversation, 'Rewriting the config file now.')).toBe('assistant')
    expect(resolveCitedTurnRole(conversation, undefined)).toBe('unknown')
  })

  it('reads the alternate role vocabularies producers emit', () => {
    expect(
      resolveCitedTurnRole({ messages: [{ role: 'human', content: 'do it again' }] }, undefined),
    ).toBe('human')
    expect(
      resolveCitedTurnRole({ messages: [{ role: 'model', content: 'done' }] }, undefined),
    ).toBe('assistant')
  })

  it.each([
    ['no message array', { content: 'plain attribute text' }],
    ['a non-conversational role', { 'llm.input_messages': '[{"role":"tool","content":"ok"}]' }],
    ['a truncated message array', { 'llm.input_messages': '[{"role":"user","content":"stop tou' }],
    ['a role field on a record that is not a turn', { 'artifact.role': 'user', scope: 'repo' }],
    ['a bare role with no payload', { meta: [{ role: 'user', id: 'reviewer-1' }] }],
  ])('returns unknown for %s', (_label, attributes) => {
    expect(resolveCitedTurnRole(attributes, undefined)).toBe('unknown')
  })

  it('returns unknown when the excerpt is not in any labelled turn', () => {
    expect(resolveCitedTurnRole(conversation, 'careful engineer')).toBe('unknown')
  })
})

function stubEngine(): TraceAnalysisEngine {
  return fakeEngine(async () => ({
    answer: 'none',
    findings: [],
    trajectory: [],
    modelCalls: 0,
    toolCalls: 0,
    runtime: {},
  }))
}

function turnSpan(
  spanId: string,
  messagesByAttribute: Record<string, Array<{ role: string; content: string }>>,
): TraceAnalystSpan {
  const span = traceSpan(spanId, 'conversation turn')
  const attributes: Record<string, unknown> = {}
  for (const [key, messages] of Object.entries(messagesByAttribute)) {
    attributes[key] = JSON.stringify(messages)
  }
  return { ...span, attributes }
}

function citationEngine(evidence: Array<{ uri: string; excerpt?: string }>): TraceAnalysisEngine {
  return fakeEngine(async () => ({
    answer: 'The agent kept editing the config after being told to stop.',
    findings: [
      {
        severity: 'high',
        claim: 'The agent kept editing the config after being told to stop.',
        confidence: 0.9,
        evidence,
      },
    ],
    trajectory: [],
    modelCalls: 1,
    toolCalls: 1,
    runtime: {},
  }))
}

function fakeEngine(analyze: TraceAnalysisEngine['analyze']): TraceAnalysisEngine {
  return {
    id: 'test-engine',
    description: 'test',
    model: 'test-model',
    version: '1.0.0',
    executionConfig: { base_url: 'https://engine.test' },
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
