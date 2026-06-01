import { describe, expect, it } from 'vitest'
import type { AnalystFinding } from '../../analyst/types'
import { isProposedCandidate, type ProposeContext, type ProposedCandidate } from '../types'
import { traceAnalystDriver } from './trace-analyst'

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

const ctx = (currentSurface: string): ProposeContext =>
  ({
    currentSurface,
    history: [],
    findings: [],
    populationSize: 1,
    generation: 1,
    signal: new AbortController().signal,
  }) as unknown as ProposeContext

describe('traceAnalystDriver — wraps our trace-analyst registry as an ImprovementDriver', () => {
  it('reads our findings from the resolved traces and applies them to the prompt surface', async () => {
    const driver = traceAnalystDriver({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      resolveTraces: () =>
        '{"name":"agent.Assistant","trace_id":"t1"}\n{"name":"function.spotify__login"}',
      analyze: async () => [finding({})],
      fetchImpl: stubFetch('IMPROVED PROMPT: always fetch spotify APIs before planning.'),
    })
    const out = await driver.propose(ctx('BASE PROMPT: do the task.'))
    expect(out).toHaveLength(1)
    const c = asCandidate(out[0])
    expect(c.surface).toBe('IMPROVED PROMPT: always fetch spotify APIs before planning.')
    expect(c.label).toBe('trace-analyst')
    // Our findings (severity/area/claim/fix) are preserved in the rationale.
    expect(c.rationale).toContain('under-fetched spotify')
    expect(c.rationale).toContain('FIX:')
  })

  it('is an ImprovementDriver of kind "trace-analyst" (drops into compareDrivers next to halo)', () => {
    const d = traceAnalystDriver({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => 'x',
    })
    expect(d.kind).toBe('trace-analyst')
    expect(typeof d.propose).toBe('function')
  })

  it('FAILS LOUD at construction when apiKey or model is missing (Ax has no env fallback)', () => {
    expect(() =>
      traceAnalystDriver({
        baseUrl: 'https://x/v1',
        apiKey: '',
        model: 'm',
        resolveTraces: () => 'x',
      }),
    ).toThrow(/apiKey is required/)
    expect(() =>
      traceAnalystDriver({
        baseUrl: 'https://x/v1',
        apiKey: 'k',
        model: '',
        resolveTraces: () => 'x',
      }),
    ).toThrow(/model is required/)
  })

  it('FAILS LOUD when there are no traces (never fabricates a candidate)', async () => {
    const driver = traceAnalystDriver({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => '   ',
      analyze: async () => [finding({})],
      fetchImpl: stubFetch('x'),
    })
    await expect(driver.propose(ctx('p'))).rejects.toThrow(/no OTLP traces/)
  })

  it('FAILS LOUD when the analyst engine errors (no silent swallow)', async () => {
    const driver = traceAnalystDriver({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => '{"name":"x"}',
      analyze: async () => {
        throw new Error('registry boom')
      },
      fetchImpl: stubFetch('x'),
    })
    await expect(driver.propose(ctx('p'))).rejects.toThrow(/analyst engine failed.*registry boom/)
  })

  it('FAILS LOUD when the analyst produces zero findings (no empty improvement)', async () => {
    const driver = traceAnalystDriver({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => '{"name":"x"}',
      analyze: async () => [],
      fetchImpl: stubFetch('x'),
    })
    await expect(driver.propose(ctx('p'))).rejects.toThrow(/produced no findings/)
  })

  it('returns no candidate when the applied surface is unchanged (no fake lift)', async () => {
    const driver = traceAnalystDriver({
      baseUrl: 'https://x/v1',
      apiKey: 'sk-test',
      model: 'm',
      resolveTraces: () => '{"name":"x"}',
      analyze: async () => [finding({})],
      fetchImpl: stubFetch('BASE PROMPT: do the task.'), // identical to parent
    })
    const out = await driver.propose(ctx('BASE PROMPT: do the task.'))
    expect(out).toHaveLength(0)
  })
})
