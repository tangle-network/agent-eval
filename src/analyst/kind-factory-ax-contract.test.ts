import type { AxAIService } from '@ax-llm/ax'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CostLedger } from '../cost-ledger'
import { createAnalystAi } from './ax-service'
import { RAW_FINDING_SCHEMA_PROMPT, RawAnalystFindingSchema } from './finding-signature'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from './kind-factory'
import { DEFAULT_TRACE_ANALYST_KINDS } from './kinds'
import { IMPROVEMENT_KIND_SPEC } from './kinds/improvement'
import { AnalystRegistry } from './registry'
import { type AnalystUsageReceipt, makeFinding } from './types'

const axMock = vi.hoisted(() => ({
  agentCalls: [] as Array<{ signature: string; options: Record<string, unknown> }>,
  forwardResult: { report: '', findings: [] as unknown[] },
  executorResult: undefined as unknown,
  events: [] as string[],
}))

vi.mock('@ax-llm/ax', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ax-llm/ax')>()
  return {
    ...actual,
    AxJSRuntime: class {
      readonly options: unknown
      constructor(options?: unknown) {
        this.options = options
      }
    },
    agent: (signature: string, options: Record<string, unknown>) => {
      if (
        options.functions !== undefined &&
        !(
          typeof (options.functions as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
          'function'
        )
      ) {
        throw new TypeError('functions must be iterable')
      }
      axMock.agentCalls.push({ signature, options })
      return {
        executor: {
          async run(ai: { chat(request: unknown): Promise<unknown> }) {
            axMock.events.push('run')
            await ai.chat({
              model: 'gpt-4o-mini',
              chatPrompt: [{ role: 'user', content: 'actor' }],
            })
            return {
              nonContextValues: {},
              executorResult: axMock.executorResult ?? {
                type: 'final',
                args: ['Submit the completed trace analysis.', axMock.forwardResult],
              },
              actorFieldValues: {},
              usedMemories: [],
              usedSkills: [],
              turnCount: 1,
              guidanceLog: undefined,
              actionLog: '',
            }
          },
          getUsage() {
            return []
          },
          getChatLog() {
            return []
          },
        },
      }
    },
  }
})

afterEach(() => {
  axMock.executorResult = undefined
})

function testAi(
  chat = vi.fn(async () => ({
    results: [],
    modelUsage: {
      ai: 'openai',
      model: 'gpt-4o-mini',
      tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    },
  })),
): AxAIService {
  const service = createAnalystAi({
    apiKey: 'test',
    baseUrl: 'https://provider.invalid/v1',
    model: 'gpt-4o-mini',
  }) as unknown as { chat: typeof chat }
  service.chat = chat
  return service as unknown as AxAIService
}

describe('createTraceAnalystKind Ax contract', () => {
  it.each([
    ['recursion', { maxDepth: 2 }, 'subqueries'],
    ['responderDescription', 'old prompt', 'actorDescription'],
    ['maxDepth', 2, 'subqueries'],
    ['maxParallelSubagents', 3, 'subqueries.maxParallel'],
    ['subagentDescription', 'old prompt', 'actorDescription'],
  ])('rejects removed kind option %s instead of silently using defaults', (name, value, replacement) => {
    expect(() =>
      createTraceAnalystKind({ ...testSpec(), [name]: value } as never, { ai: testAi() }),
    ).toThrow(`'${name}' is unsupported; use '${replacement}'`)
    expect(axMock.agentCalls).toHaveLength(0)
  })

  it('requires an explicit model for opaque Ax services before paid work', () => {
    const chat = vi.fn()

    expect(() => createTraceAnalystKind(testSpec(), { ai: { chat } as never })).toThrow(
      /model is required.*createAnalystAi/,
    )
    expect(chat).not.toHaveBeenCalled()
  })

  it('passes trace tools as the iterable Ax functions shape', async () => {
    axMock.agentCalls.length = 0
    const tool = { namespace: 'traces', name: 'getDatasetOverview' }
    const spec: TraceAnalystKindSpec = {
      id: 'failure-mode',
      description: 'Find trace failures',
      area: 'failure-mode',
      version: '0.0.1',
      actorDescription: 'Return findings.',
      buildTools: () => [tool as never],
      cost: { kind: 'llm' },
    }
    const analyst = createTraceAnalystKind(spec, { ai: testAi() })

    let receipt: AnalystUsageReceipt | undefined
    const findings = await analyst.analyze(
      {} as never,
      { tags: {}, recordUsage: (usage: AnalystUsageReceipt) => (receipt = usage) } as never,
    )

    expect(findings).toEqual([])
    expect(receipt).toEqual({
      calls: 1,
      tokens: { input: 1, output: 1 },
      cost: { kind: 'estimated', usd: expect.any(Number) },
    })
    expect(axMock.agentCalls).toHaveLength(1)
    const functions = Array.from(
      axMock.agentCalls[0]!.options.functions as Iterable<Record<string, unknown>>,
    )
    expect(functions).toHaveLength(1)
    expect(functions[0]).toBe(tool)
  })

  it('writes provider calls to a shared ledger without counting unrelated calls', async () => {
    axMock.forwardResult = { report: '', findings: [] }
    const costLedger = new CostLedger()
    await costLedger.runPaidCall({
      channel: 'analyst',
      phase: 'search.proposal',
      actor: 'other-analyst',
      model: 'gpt-4o-mini',
      tags: { analystId: 'other', analystRunId: 'ar_other' },
      execute: async () => 'ok',
      receipt: () => ({ model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 2 }),
    })
    const analyst = createTraceAnalystKind(testSpec(), { ai: testAi() })
    let receipt: AnalystUsageReceipt | undefined

    await analyst.analyze(
      {} as never,
      {
        correlationId: 'ar_shared',
        costLedger,
        costPhase: 'search.proposal',
        recordUsage: (usage: AnalystUsageReceipt) => (receipt = usage),
      } as never,
    )

    expect(receipt).toMatchObject({ calls: 1, tokens: { input: 1, output: 1 } })
    expect(costLedger.list({ tags: { analystRunId: 'ar_shared' } })).toHaveLength(1)
    expect(costLedger.list()).toHaveLength(2)
  })

  it('assembles one canonical output contract for every shipped kind', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = { report: '', findings: [] }

    for (const shipped of DEFAULT_TRACE_ANALYST_KINDS) {
      const analyst = createTraceAnalystKind({ ...shipped, buildTools: () => [] }, { ai: testAi() })
      await analyst.analyze({} as never, { tags: {} } as never)
    }

    expect(axMock.agentCalls).toHaveLength(DEFAULT_TRACE_ANALYST_KINDS.length)
    for (const call of axMock.agentCalls) {
      expect(call.signature).toBe('question:string -> report:string, findings:json[]')
      const actor = call.options.executorOptions as { description: string }
      expect(actor.description.split(RAW_FINDING_SCHEMA_PROMPT)).toHaveLength(2)
      expect(actor.description).toContain(
        'final("Submit the completed trace analysis.", { report, findings })',
      )
      expect(actor.description).not.toMatch(/`area`\s*=/)
      expect(actor.description).not.toContain('evidence_uri')
      expect(actor.description).not.toContain('submitAnalysis')
    }
    const poisoningActor = axMock.agentCalls[2]!.options.executorOptions as {
      description: string
    }
    expect(poisoningActor.description).toContain(
      'requires at least 2 evidence citations per finding',
    )
  })
  it('lifts every citation and derives finding/event evidence kinds', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = {
      report: '',
      findings: [
        {
          severity: 'high',
          claim: 'upstream diagnosis and trace event jointly support the change',
          evidence: [
            { uri: 'finding://failure-123', excerpt: 'failure cluster' },
            { uri: 'event://trace-1/event-8', excerpt: 'runtime contradiction' },
          ],
          confidence: 0.9,
        },
      ],
    }
    const analyst = createTraceAnalystKind(testSpec(), { ai: testAi() })

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidence_refs).toEqual([
      { kind: 'finding', uri: 'finding://failure-123', excerpt: 'failure cluster' },
      { kind: 'event', uri: 'event://trace-1/event-8', excerpt: 'runtime contradiction' },
    ])
  })

  it('keeps legacy postProcess callbacks source-compatible without dropping citations', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = {
      report: '',
      findings: [
        {
          severity: 'high',
          claim: 'original claim',
          evidence: [
            { uri: 'span://trace/action', excerpt: 'primary' },
            { uri: 'event://trace/result', excerpt: 'corroborating' },
          ],
          confidence: 0.9,
        },
      ],
    }
    const analyst = createTraceAnalystKind(
      {
        ...testSpec(),
        postProcess: (row) => {
          const exactLegacyRow = RawAnalystFindingSchema.parse(row)
          return {
            ...exactLegacyRow,
            claim: `${exactLegacyRow.claim}; checked ${exactLegacyRow.evidence_uri}`,
          }
        },
      },
      { ai: testAi() },
    )

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      claim: 'original claim; checked span://trace/action',
      evidence_refs: [
        { kind: 'span', uri: 'span://trace/action', excerpt: 'primary' },
        { kind: 'event', uri: 'event://trace/result', excerpt: 'corroborating' },
      ],
    })
  })

  it('keeps secondary citations when a legacy callback replaces the primary citation', async () => {
    axMock.forwardResult = {
      report: '',
      findings: [
        {
          severity: 'high',
          claim: 'original claim',
          evidence: [
            { uri: 'span://trace/action', excerpt: 'primary' },
            { uri: 'event://trace/result', excerpt: 'corroborating' },
          ],
          confidence: 0.9,
        },
      ],
    }
    const analyst = createTraceAnalystKind(
      {
        ...testSpec(),
        postProcess: (row) => ({ ...row, evidence_uri: 'span://trace/reclassified' }),
      },
      { ai: testAi() },
    )

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings[0]?.evidence_refs).toEqual([
      { kind: 'span', uri: 'span://trace/reclassified', excerpt: 'primary' },
      { kind: 'event', uri: 'event://trace/result', excerpt: 'corroborating' },
    ])
  })

  it('rejects rows below a kind minimum-citation contract', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = {
      report: '',
      findings: [
        {
          severity: 'high',
          claim: 'poisoning with only the action half',
          evidence: [{ uri: 'span://trace/action' }],
          confidence: 0.8,
        },
      ],
    }
    const log = vi.fn()
    const analyst = createTraceAnalystKind(
      { ...testSpec(), minimumEvidenceCitations: 2 },
      { ai: testAi() },
    )

    const findings = await analyst.analyze({} as never, { tags: {}, log } as never)

    expect(findings).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'finding rejected: insufficient evidence citations',
      expect.objectContaining({ required: 2, received: 1 }),
    )
  })

  it('does not count duplicate evidence as independent citations', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = {
      report: '',
      findings: [
        {
          severity: 'high',
          claim: 'duplicate support',
          evidence: [
            { uri: 'span://trace/action' },
            { uri: 'span://trace/action', excerpt: 'same span again' },
          ],
          confidence: 0.8,
        },
      ],
    }
    const log = vi.fn()
    const analyst = createTraceAnalystKind(
      { ...testSpec(), minimumEvidenceCitations: 2 },
      { ai: testAi() },
    )

    const findings = await analyst.analyze({} as never, { tags: {}, log } as never)

    expect(findings).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'finding rejected: insufficient evidence citations',
      expect.objectContaining({ required: 2, received: 2, distinct: 1 }),
    )
  })

  it('applies the minimum-citation contract to prose-recovery findings', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = {
      report: 'A'.repeat(220),
      findings: [],
    }
    const log = vi.fn()
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    {
                      severity: 'high',
                      claim: 'one-sided poisoning claim',
                      evidence: [{ uri: 'span://trace/action' }],
                      confidence: 0.8,
                    },
                  ]),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch
    const analyst = createTraceAnalystKind(
      { ...testSpec(), minimumEvidenceCitations: 2 },
      {
        ai: testAi(),
        recovery: { baseUrl: 'https://example.test/v1', model: 'test', fetchImpl },
      },
    )

    await expect(analyst.analyze({} as never, { tags: {}, log } as never)).rejects.toThrow(
      /no finding satisfied its acceptance rules/,
    )
    expect(log).toHaveBeenCalledWith(
      'analyst.kind test-kind recovery',
      expect.objectContaining({ recovered: 0, rejected_insufficient_evidence: 2 }),
    )
  })

  it('applies the kind postProcess rule to recovered and fallback rows', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = { report: 'A'.repeat(220), findings: [] }
    const fetchImpl = stubRecoveryFetch([
      {
        severity: 'high',
        claim: 'kind-specific false positive',
        evidence: [{ uri: 'span://trace/span' }],
        confidence: 0.8,
      },
    ])
    const analyst = createTraceAnalystKind(
      { ...testSpec(), postProcess: () => null },
      {
        ai: testAi(),
        recovery: { baseUrl: 'https://example.test/v1', model: 'test', fetchImpl },
      },
    )

    await expect(analyst.analyze({} as never, { tags: {} } as never)).rejects.toThrow(
      /no finding satisfied its acceptance rules/,
    )
  })

  it('rejects a recovered subject that belongs to another analyst kind', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = { report: 'A'.repeat(220), findings: [] }
    const log = vi.fn()
    const fetchImpl = stubRecoveryFetch([
      {
        severity: 'high',
        claim: 'prompt locus emitted by the failure classifier',
        subject: 'system-prompt:instructions',
        evidence: [{ uri: 'span://trace/span' }],
        confidence: 0.8,
      },
    ])
    const analyst = createTraceAnalystKind(
      { ...testSpec(), id: 'failure-mode' },
      {
        ai: testAi(),
        recovery: { baseUrl: 'https://example.test/v1', model: 'test', fetchImpl },
      },
    )

    const findings = await analyst.analyze({} as never, { tags: {}, log } as never)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      claim: 'Analyst produced a diagnosis but no structured findings — see report.',
      metadata: { kind_version: '0.0.1', outcome: 'extraction_failed' },
    })
    expect(log).toHaveBeenCalledWith(
      'analyst.kind failure-mode recovery',
      expect.objectContaining({ recovered: 0, rejected_wrong_subject: 2 }),
    )
  })

  it('fails when Ax substitutes max-turn fallback text for a structured result', async () => {
    axMock.agentCalls.length = 0
    axMock.executorResult = {
      type: 'final',
      args: [
        'Actor stopped without calling final(...). Evidence summary:\n' +
          '- Action 1: [SUMMARY]: Error step. No durable result.',
      ],
    }
    const analyst = createTraceAnalystKind(testSpec(), { ai: testAi() })

    await expect(analyst.analyze({} as never, { tags: {} } as never)).rejects.toThrow(
      "Trace analyst 'test-kind' stopped without a structured final result",
    )
  })

  it('uses the exact structured executor completion', async () => {
    axMock.executorResult = {
      type: 'final',
      args: [
        'Submit the completed trace analysis.',
        {
          report: 'Captured evidence-backed report.',
          findings: [
            {
              severity: 'high',
              confidence: 0.9,
              claim: 'Captured finding',
              evidence: [{ uri: 'trace://run-1/span-1' }],
              recommended_action: 'Use the captured result.',
            },
          ],
        },
      ],
    }
    axMock.forwardResult = { report: 'Unrelated return value.', findings: [] }
    const analyst = createTraceAnalystKind(testSpec(), { ai: testAi() })

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings).toHaveLength(1)
    expect(findings[0]?.claim).toBe('Captured finding')
  })

  it('fails loud when optional recovery cannot complete', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = { report: 'A'.repeat(220), findings: [] }
    const log = vi.fn()
    const fetchImpl = vi.fn(async () => {
      throw new Error('recovery provider unavailable')
    }) as unknown as typeof fetch
    const analyst = createTraceAnalystKind(testSpec(), {
      ai: testAi(),
      recovery: { baseUrl: 'https://example.test/v1', model: 'test', fetchImpl },
    })

    await expect(analyst.analyze({} as never, { tags: {}, log } as never)).rejects.toThrow(
      'recovery provider unavailable',
    )
  })

  it('honors a kind postProcess null rejection', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = {
      report: '',
      findings: [
        {
          severity: 'medium',
          claim: 'kind-specific false positive',
          evidence: [{ uri: 'span://trace/span' }],
          confidence: 0.7,
        },
      ],
    }
    const analyst = createTraceAnalystKind(
      { ...testSpec(), postProcess: () => null },
      { ai: testAi() },
    )

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings).toEqual([])
  })

  it('enforces the allocated analyst budget before a provider call', async () => {
    axMock.forwardResult = { report: '', findings: [] }
    const providerChat = vi.fn(async () => ({
      results: [],
      modelUsage: {
        ai: 'openai',
        model: 'gpt-4o-mini',
        tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    }))
    const analyst = createTraceAnalystKind(
      { ...testSpec(), maxOutputTokens: 64 },
      { ai: testAi(providerChat) },
    )

    await expect(analyst.analyze({} as never, { budgetUsd: 0 } as never)).rejects.toThrow(
      /would exceed ceiling 0/,
    )
    expect(providerChat).not.toHaveBeenCalled()
  })

  it('waits for a cancelled provider call to settle before reporting usage', async () => {
    axMock.forwardResult = { report: '', findings: [] }
    const controller = new AbortController()
    type TestAxResponse = {
      results: never[]
      modelUsage: {
        ai: string
        model: string
        tokens: { promptTokens: number; completionTokens: number; totalTokens: number }
      }
    }
    let markStarted!: () => void
    let finishProvider!: (value: TestAxResponse) => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const provider = new Promise<TestAxResponse>((resolve) => {
      finishProvider = resolve
    })
    const providerChat = vi.fn(async () => {
      markStarted()
      return provider
    })
    const analyst = createTraceAnalystKind(testSpec(), { ai: testAi(providerChat) })
    let receipt: AnalystUsageReceipt | undefined

    const run = analyst.analyze(
      {} as never,
      {
        signal: controller.signal,
        recordUsage: (usage: AnalystUsageReceipt) => (receipt = usage),
      } as never,
    )
    await started
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await Promise.resolve()
    expect(receipt).toBeUndefined()
    finishProvider({
      results: [],
      modelUsage: {
        ai: 'openai',
        model: 'gpt-4o-mini',
        tokens: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      },
    })

    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(receipt).toMatchObject({
      calls: 1,
      tokens: { input: 10, output: 4 },
      cost: { kind: 'estimated', usd: expect.any(Number) },
    })
  })

  it('reports a stuck cancelled provider call without hanging', async () => {
    axMock.forwardResult = { report: '', findings: [] }
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const providerChat = vi.fn(async () => {
      markStarted()
      return new Promise<never>(() => {})
    })
    const analyst = createTraceAnalystKind(testSpec(), {
      ai: testAi(providerChat),
      settlementTimeoutMs: 1,
    })
    const log = vi.fn()
    let receipt: AnalystUsageReceipt | undefined

    const run = analyst.analyze(
      {} as never,
      {
        signal: controller.signal,
        log,
        recordUsage: (usage: AnalystUsageReceipt) => (receipt = usage),
      } as never,
    )
    await started
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(receipt).toEqual({
      calls: 1,
      tokens: null,
      cost: { kind: 'uncaptured', usd: null },
      knownCostUsd: 0,
    })
    expect(log).toHaveBeenCalledWith('analyst.kind test-kind provider settlement timed out', {
      pending_calls: 1,
      timeout_ms: 1,
    })
  })

  it('renders same-run findings as dependency context, not prior-run memory', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = { report: '', findings: [] }
    const upstream = makeFinding({
      analyst_id: 'failure-mode',
      area: 'failure-mode',
      claim: 'agent repeated the same failed tool call',
      severity: 'high',
      confidence: 0.9,
      evidence_refs: [{ kind: 'span', uri: 'span://trace/tool-call' }],
      recommended_action: 'deduplicate identical calls',
    })
    const analyst = createTraceAnalystKind(testSpec(), { ai: testAi() })

    await analyst.analyze({} as never, { upstreamFindings: [upstream] } as never)

    const actor = (
      axMock.agentCalls[0]?.options.executorOptions as { description?: string } | undefined
    )?.description
    expect(actor).toContain('UPSTREAM FINDINGS (produced earlier in this same registry run)')
    expect(actor).toContain(`id=${upstream.finding_id} source=failure-mode high`)
    expect(actor).toContain('claim=agent repeated the same failed tool call')
    expect(actor).toContain('action=deduplicate identical calls')
    expect(actor).toContain('evidence=span://trace/tool-call')
    expect(actor).not.toContain('PRIOR FINDINGS (from a previous run')
  })

  it('renders registry-forwarded prior findings into the improvement actor input', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = { report: '', findings: [] }
    const prior = makeFinding({
      analyst_id: 'failure-mode',
      area: 'failure-mode',
      claim: 'the worker stopped after executing only the first JavaScript block',
      severity: 'high',
      confidence: 0.99,
      evidence_refs: [{ kind: 'span', uri: 'span://trace/worker-turn-7' }],
    })
    const registry = new AnalystRegistry()
    registry.register(
      createTraceAnalystKind(
        { ...IMPROVEMENT_KIND_SPEC, buildTools: () => [], subqueries: { maxCalls: 0 } },
        { ai: testAi() },
      ),
    )

    await registry.run(
      'prior-finding-render',
      { traceStore: {} as never },
      { priorFindings: { '*': [prior] } },
    )

    const actor = (
      axMock.agentCalls[0]?.options.executorOptions as { description?: string } | undefined
    )?.description
    expect(actor).toContain('PRIOR FINDINGS (from a previous run on related data)')
    expect(actor).toContain(`id=${prior.finding_id} high`)
    expect(actor).toContain('the worker stopped after executing only the first JavaScript block')
  })
})

function testSpec(): TraceAnalystKindSpec {
  return {
    id: 'test-kind',
    description: 'test',
    area: 'test',
    version: '0.0.1',
    actorDescription: 'Analyze the supplied traces.',
    buildTools: () => [],
    cost: { kind: 'llm' },
  }
}

function stubRecoveryFetch(findings: unknown[]): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(findings) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  ) as unknown as typeof fetch
}
