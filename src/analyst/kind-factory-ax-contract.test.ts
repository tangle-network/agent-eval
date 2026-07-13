import { describe, expect, it, vi } from 'vitest'
import { RAW_FINDING_SCHEMA_PROMPT } from './finding-signature'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from './kind-factory'
import { DEFAULT_TRACE_ANALYST_KINDS } from './kinds'

const axMock = vi.hoisted(() => ({
  agentCalls: [] as Array<{ signature: string; options: Record<string, unknown> }>,
  forwardResult: { report: '', findings: [] as unknown[] },
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
        async forward() {
          return axMock.forwardResult
        },
        getUsage() {
          return {}
        },
        getChatLog() {
          return {}
        },
        resetUsage() {},
      }
    },
  }
})

describe('createTraceAnalystKind Ax contract', () => {
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
    const analyst = createTraceAnalystKind(spec, { ai: {} as never })

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings).toEqual([])
    expect(axMock.agentCalls).toHaveLength(1)
    expect(axMock.agentCalls[0]!.options.functions).toEqual([tool])
  })

  it('assembles one canonical output contract for every shipped kind', async () => {
    axMock.agentCalls.length = 0
    axMock.forwardResult = { report: '', findings: [] }

    for (const shipped of DEFAULT_TRACE_ANALYST_KINDS) {
      const analyst = createTraceAnalystKind(
        { ...shipped, buildTools: () => [] },
        { ai: {} as never },
      )
      await analyst.analyze({} as never, { tags: {} } as never)
    }

    expect(axMock.agentCalls).toHaveLength(DEFAULT_TRACE_ANALYST_KINDS.length)
    for (const call of axMock.agentCalls) {
      expect(call.signature).toBe('question:string -> report:string, findings:json[]')
      const actor = call.options.actorOptions as { description: string }
      expect(actor.description.split(RAW_FINDING_SCHEMA_PROMPT)).toHaveLength(2)
      expect(actor.description).toContain('final({ report, findings })')
      expect(actor.description).not.toMatch(/`area`\s*=/)
      expect(actor.description).not.toContain('evidence_uri')
      expect(actor.description).not.toMatch(/final\(\{\s*findings/)
    }
    const poisoningActor = axMock.agentCalls[2]!.options.actorOptions as { description: string }
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
    const analyst = createTraceAnalystKind(testSpec(), { ai: {} as never })

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidence_refs).toEqual([
      { kind: 'finding', uri: 'finding://failure-123', excerpt: 'failure cluster' },
      { kind: 'event', uri: 'event://trace-1/event-8', excerpt: 'runtime contradiction' },
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
      { ai: {} as never },
    )

    const findings = await analyst.analyze({} as never, { tags: {}, log } as never)

    expect(findings).toEqual([])
    expect(log).toHaveBeenCalledWith(
      'finding rejected: insufficient evidence citations',
      expect.objectContaining({ required: 2, received: 1 }),
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
        ai: {} as never,
        recovery: { baseUrl: 'https://example.test/v1', model: 'test', fetchImpl },
      },
    )

    const findings = await analyst.analyze({} as never, { tags: {}, log } as never)

    expect(findings).toHaveLength(1)
    expect(findings[0]!.metadata).toEqual({ outcome: 'extraction_failed' })
    expect(log).toHaveBeenCalledWith(
      'analyst.kind test-kind recovery',
      expect.objectContaining({ recovered: 0, rejected_insufficient_evidence: 1 }),
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
      { ai: {} as never },
    )

    const findings = await analyst.analyze({} as never, { tags: {} } as never)

    expect(findings).toEqual([])
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
