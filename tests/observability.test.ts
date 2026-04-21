import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import { replayTraceThroughJudge, toLangfuseEnvelope, toPrometheusText } from '../src/observability'

describe('toLangfuseEnvelope', () => {
  it('maps llm + judge spans to generations + scores', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const llm = await e.span({
      kind: 'llm',
      name: 'gen',
      model: 'claude',
      messages: [{ role: 'user', content: 'hi' }],
      output: 'hello',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    })
    await llm.end()
    await e.recordJudge({ judgeId: 'j', targetSpanId: llm.span.spanId, dimension: 'quality', score: 0.9, name: 'q' })
    await e.endRun({ pass: true })
    const env = await toLangfuseEnvelope(store, e.runId)
    expect(env.generations).toHaveLength(1)
    expect(env.generations[0].model).toBe('claude')
    expect(env.generations[0].usage.total).toBe(15)
    expect(env.scores).toHaveLength(1)
    expect(env.scores[0].value).toBe(0.9)
  })

  it('throws when run is missing — regression: silent no-op would produce empty envelope', async () => {
    await expect(toLangfuseEnvelope(new InMemoryTraceStore(), 'missing')).rejects.toThrow(/not found/)
  })
})

describe('toPrometheusText', () => {
  it('emits counters for runs + tokens + cost + tool usage', async () => {
    const store = new InMemoryTraceStore()
    for (let i = 0; i < 3; i++) {
      const e = new TraceEmitter(store)
      await e.startRun({ scenarioId: 's' })
      const h = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await h.end()
      const llm = await e.span({ kind: 'llm', name: 'g', model: 'm', messages: [], inputTokens: 100, outputTokens: 50, costUsd: 0.01 })
      await llm.end()
      await e.endRun({ pass: i < 2 })
    }
    const text = await toPrometheusText(store)
    expect(text).toMatch(/agent_eval_runs_total 3/)
    expect(text).toMatch(/agent_eval_runs_passed_total 2/)
    expect(text).toMatch(/agent_eval_runs_failed_total 1/)
    expect(text).toMatch(/agent_eval_llm_input_tokens_total 300/)
    expect(text).toMatch(/agent_eval_tool_calls_total\{tool="search"\} 3/)
  })
})

describe('replayTraceThroughJudge', () => {
  it('re-scores existing LLM spans without re-executing the agent — regression: retroactive eval must be cheap', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const llm = await e.span({ kind: 'llm', name: 'g', model: 'm', messages: [], output: 'the answer is 42' })
    await llm.end()
    await e.endRun({ pass: true })
    const results = await replayTraceThroughJudge(store, e.runId, {
      id: 'contains-42',
      dimension: 'numeric-answer-present',
      score: async (span) => ({ score: span.output?.includes('42') ? 1 : 0 }),
    })
    expect(results).toHaveLength(1)
    expect(results[0].score).toBe(1)
    const judgeSpans = (await store.spans({ runId: e.runId, kind: 'judge' }))
    expect(judgeSpans).toHaveLength(1)
  })
})
