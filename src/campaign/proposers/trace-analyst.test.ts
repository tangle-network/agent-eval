import { describe, expect, it, vi } from 'vitest'
import { AnalystRegistry } from '../../analyst/registry'
import type { AnalystFinding } from '../../analyst/types'
import { CostLedger } from '../../cost-ledger'
import { isProposedCandidate, type ProposeContext, type ProposedCandidate } from '../types'
import { traceAnalystProposer } from './trace-analyst'

function asCandidate(v: unknown): ProposedCandidate {
  if (!isProposedCandidate(v as never)) throw new Error('expected a ProposedCandidate')
  return v as ProposedCandidate
}

function finding(over: Partial<AnalystFinding>): AnalystFinding {
  return {
    schema_version: '1.0.0',
    finding_id: 'f1',
    analyst_id: 'failure-mode',
    produced_at: '2026-01-01T00:00:00.000Z',
    severity: 'high',
    area: 'failure-mode',
    claim: 'agent under-fetched spotify APIs before planning',
    evidence_refs: [],
    confidence: 0.9,
    recommended_action: 'always fetch the relevant APIs before planning',
    ...over,
  }
}

// Stub fetch → an OpenAI-compatible chat-completion returning a revised prompt.
// Mocks ONLY the apply-step network boundary; the analyst engine is injected
// via `analyze` (its own real coverage lives in analyst.test.ts / kinds.test.ts).
function stubFetch(revisedPrompt: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: revisedPrompt } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

const ctx = (currentSurface: string, findings: unknown[] = []): ProposeContext =>
  ({
    currentSurface,
    history: [],
    findings,
    populationSize: 1,
    generation: 1,
    signal: new AbortController().signal,
  }) as unknown as ProposeContext

describe('traceAnalystProposer — wraps our trace-analyst registry as a SurfaceProposer', () => {
  it('reads our findings from the resolved traces and applies them to the prompt surface', async () => {
    const proposer = traceAnalystProposer({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      resolveTraces: () =>
        '{"name":"agent.Assistant","trace_id":"t1"}\n{"name":"function.spotify__login"}',
      analyze: async () => [finding({})],
      fetchImpl: stubFetch('IMPROVED PROMPT: always fetch spotify APIs before planning.'),
    })
    const out = await proposer.propose(ctx('BASE PROMPT: do the task.'))
    expect(out).toHaveLength(1)
    const c = asCandidate(out[0])
    expect(c.surface).toBe('IMPROVED PROMPT: always fetch spotify APIs before planning.')
    expect(c.label).toBe('trace-analyst')
    // Our findings (severity/area/claim/fix) are preserved in the rationale.
    expect(c.rationale).toContain('under-fetched spotify')
    expect(c.rationale).toContain('FIX:')
  })

  it('is a SurfaceProposer of kind "trace-analyst" (drops into compareProposers next to halo)', () => {
    const d = traceAnalystProposer({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => 'x',
    })
    expect(d.kind).toBe('trace-analyst')
    expect(typeof d.propose).toBe('function')
  })

  it('enables same-run chaining on the default analyst registry path', async () => {
    const run = vi.spyOn(AnalystRegistry.prototype, 'run').mockResolvedValue({
      run_id: 'trace-analyst-gen-1',
      correlation_id: 'ar_test',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:01.000Z',
      findings: [finding({})],
      per_analyst: [],
      total_cost_usd: 0,
      total_cost_provenance: { kind: 'uncaptured', usd: null },
    })
    try {
      const proposer = traceAnalystProposer({
        baseUrl: 'https://x/v1',
        apiKey: 'sk-test',
        model: 'm',
        resolveTraces: () => '{"name":"agent.Assistant","trace_id":"t1"}',
        fetchImpl: stubFetch('IMPROVED'),
      })
      const input = ctx('BASE')
      const costLedger = new CostLedger()
      input.costLedger = costLedger

      await proposer.propose(input)

      expect(run).toHaveBeenCalledWith(
        'trace-analyst-gen-1',
        expect.objectContaining({ traceStore: expect.anything() }),
        expect.objectContaining({
          chainFindings: true,
          signal: expect.any(AbortSignal),
          costLedger,
        }),
      )
      expect(run.mock.calls[0]?.[2]?.priorFindings).toBeUndefined()
      expect(costLedger.list().map((receipt) => receipt.actor)).toEqual(['trace-analyst.apply'])
    } finally {
      run.mockRestore()
    }
  })

  it('forwards context findings only through the explicit prior-findings resolver', async () => {
    const prior = [finding({ finding_id: 'prior-1', analyst_id: 'failure-mode' })]
    const run = vi.spyOn(AnalystRegistry.prototype, 'run').mockResolvedValue({
      run_id: 'trace-analyst-gen-1',
      correlation_id: 'ar_test',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:01.000Z',
      findings: [finding({ finding_id: 'new-1' })],
      per_analyst: [],
      total_cost_usd: 0,
      total_cost_provenance: { kind: 'uncaptured', usd: null },
    })
    try {
      const proposer = traceAnalystProposer<AnalystFinding>({
        baseUrl: 'https://x/v1',
        apiKey: 'sk-test',
        model: 'm',
        resolveTraces: () => '{"name":"agent.Assistant","trace_id":"t1"}',
        resolvePriorFindings: (input) => ({ '*': input.findings }),
        fetchImpl: stubFetch('IMPROVED'),
      })

      await proposer.propose(ctx('BASE', prior) as ProposeContext<AnalystFinding>)

      expect(run).toHaveBeenCalledWith(
        'trace-analyst-gen-1',
        expect.objectContaining({ traceStore: expect.anything() }),
        expect.objectContaining({ priorFindings: { '*': prior } }),
      )
    } finally {
      run.mockRestore()
    }
  })

  it('preserves every registry failure and the failed/total count without applying an edit', async () => {
    const run = vi.spyOn(AnalystRegistry.prototype, 'run').mockResolvedValue({
      run_id: 'trace-analyst-gen-1',
      correlation_id: 'ar_test',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:01.000Z',
      findings: [],
      per_analyst: [
        {
          analyst_id: 'failure-mode',
          status: 'failed',
          findings_count: 0,
          latency_ms: 1,
          cost_usd: 0,
          error: {
            class: 'TraceAnalysisTurnLimitError',
            message: "Trace analyst 'failure-mode' reached maxTurns=24",
          },
        },
        {
          analyst_id: 'knowledge-gap',
          status: 'failed',
          findings_count: 0,
          latency_ms: 1,
          cost_usd: 0,
          error: { class: 'Error', message: 'provider response was malformed' },
        },
        {
          analyst_id: 'knowledge-poisoning',
          status: 'ok',
          findings_count: 0,
          latency_ms: 1,
          cost_usd: 0,
        },
        {
          analyst_id: 'improvement',
          status: 'ok',
          findings_count: 0,
          latency_ms: 1,
          cost_usd: 0,
        },
      ],
      total_cost_usd: 0,
      total_cost_provenance: { kind: 'uncaptured', usd: null },
    })
    const apply = vi.fn(stubFetch('MUST NOT APPLY'))
    try {
      const proposer = traceAnalystProposer({
        baseUrl: 'https://x/v1',
        apiKey: 'sk-test',
        model: 'm',
        resolveTraces: () => '{"name":"agent.Assistant","trace_id":"t1"}',
        fetchImpl: apply,
      })

      const proposal = proposer.propose(ctx('BASE'))
      await expect(proposal).rejects.toThrow(/2\/4 analysts failed/)
      await expect(proposal).rejects.toThrow(
        /failure-mode \[TraceAnalysisTurnLimitError:.*reached maxTurns=24\]/,
      )
      await expect(proposal).rejects.toThrow(
        /knowledge-gap \[Error: provider response was malformed\]/,
      )
      expect(apply).not.toHaveBeenCalled()
    } finally {
      run.mockRestore()
    }
  })

  it('FAILS LOUD at construction when apiKey or model is missing (Ax has no env fallback)', () => {
    expect(() =>
      traceAnalystProposer({
        baseUrl: 'https://x/v1',
        apiKey: '',
        model: 'm',
        resolveTraces: () => 'x',
      }),
    ).toThrow(/apiKey is required/)
    expect(() =>
      traceAnalystProposer({
        baseUrl: 'https://x/v1',
        apiKey: 'k',
        model: '',
        resolveTraces: () => 'x',
      }),
    ).toThrow(/model is required/)
  })

  it('rejects a prior-findings resolver that a custom analyzer would bypass', () => {
    expect(() =>
      traceAnalystProposer({
        baseUrl: 'https://x/v1',
        apiKey: 'sk-test',
        model: 'm',
        resolveTraces: () => 'x',
        resolvePriorFindings: () => ({ '*': [] }),
        analyze: async () => [],
      }),
    ).toThrow(/custom analyze callbacks must consume ctx\.findings directly/)
  })

  it('FAILS LOUD when there are no traces (never fabricates a candidate)', async () => {
    const proposer = traceAnalystProposer({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => '   ',
      analyze: async () => [finding({})],
      fetchImpl: stubFetch('x'),
    })
    await expect(proposer.propose(ctx('p'))).rejects.toThrow(/no OTLP traces/)
  })

  it('FAILS LOUD when the analyst engine errors (no silent swallow)', async () => {
    const proposer = traceAnalystProposer({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => '{"name":"x"}',
      analyze: async () => {
        throw new Error('registry boom')
      },
      fetchImpl: stubFetch('x'),
    })
    await expect(proposer.propose(ctx('p'))).rejects.toThrow(/analyst engine failed.*registry boom/)
  })

  it('FAILS LOUD when the analyst produces zero findings (no empty improvement)', async () => {
    const proposer = traceAnalystProposer({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => '{"name":"x"}',
      analyze: async () => [],
      fetchImpl: stubFetch('x'),
    })
    await expect(proposer.propose(ctx('p'))).rejects.toThrow(/produced no findings/)
  })

  it('returns no candidate when the applied surface is unchanged (no fake lift)', async () => {
    const proposer = traceAnalystProposer({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => '{"name":"x"}',
      analyze: async () => [finding({})],
      fetchImpl: stubFetch('BASE PROMPT: do the task.'), // identical to parent
    })
    const out = await proposer.propose(ctx('BASE PROMPT: do the task.'))
    expect(out).toHaveLength(0)
  })
})
