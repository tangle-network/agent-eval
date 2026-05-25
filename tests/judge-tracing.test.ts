import { describe, expect, it } from 'vitest'
import { TraceEmitter } from '../src/trace/emitter'
import { InMemoryTraceStore } from '../src/trace/store'
import { traceJudge, traceJudgeEnsemble } from '../src/traced-judges'
import type { JudgeFn, JudgeScore } from '../src/types'

function makeEmitter() {
  const store = new InMemoryTraceStore()
  let counter = 0
  const emitter = new TraceEmitter(store, {
    runId: 'test-run',
    now: () => 1000 + counter++,
    id: () => `span-${counter++}`,
  })
  return { store, emitter }
}

function makeMockJudge(scores: JudgeScore[]): JudgeFn {
  return async () => scores
}

describe('judge tracing', () => {
  it('single judge emits an llm span with model and scores', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const mockScores: JudgeScore[] = [
      { judgeName: 'domain', dimension: 'accuracy', score: 8, reasoning: 'good' },
      { judgeName: 'domain', dimension: 'depth', score: 7, reasoning: 'ok' },
    ]
    const judge = makeMockJudge(mockScores)
    const traced = traceJudge(judge, 'domain_expert', { emitter })

    const input = {
      scenario: { id: 's1', persona: 'dev', label: 'test', thesis: 'test goal' } as any,
      turns: [{ userMessage: 'hi', agentResponse: 'hello' }] as any,
      artifacts: { codeBlocks: [] } as any,
    }
    const result = await traced({} as any, input)

    expect(result).toEqual(mockScores)

    const spans = await store.spans({ runId: 'test-run' })
    expect(spans.length).toBe(1)
    expect(spans[0]!.name).toBe('judge:domain_expert')
    expect(spans[0]!.kind).toBe('llm')
    expect(spans[0]!.status).toBe('ok')
    expect(spans[0]!.attributes).toMatchObject({
      'judge.name': 'domain_expert',
      'judge.composite_score': 7.5,
      'judge.dimension_count': 2,
      'eval.phase': 'judge',
    })
  })

  it('ensemble wraps all judges under a parent span', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const judge1 = makeMockJudge([
      { judgeName: 'j1', dimension: 'd1', score: 9, reasoning: 'great' },
    ])
    const judge2 = makeMockJudge([{ judgeName: 'j2', dimension: 'd2', score: 6, reasoning: 'mid' }])

    const ensemble = traceJudgeEnsemble([judge1, judge2], ['judge_1', 'judge_2'], { emitter })

    const input = {
      scenario: { id: 's1', persona: 'dev', label: 'test', thesis: 'test goal' } as any,
      turns: [{ userMessage: 'hi', agentResponse: 'hello' }] as any,
      artifacts: { codeBlocks: [] } as any,
    }
    const result = await ensemble({} as any, input)

    expect(result).toHaveLength(2)
    expect(result[0]!.score).toBe(9)
    expect(result[1]!.score).toBe(6)

    const spans = await store.spans({ runId: 'test-run' })
    // 1 ensemble parent + 2 child judge spans = 3
    expect(spans.length).toBe(3)

    const ensembleSpan = spans.find((s) => s.name === 'judge:ensemble')
    expect(ensembleSpan).toBeDefined()
    expect(ensembleSpan!.kind).toBe('custom')

    const childSpans = spans.filter((s) => s.parentSpanId === ensembleSpan!.spanId)
    expect(childSpans.length).toBe(2)
    expect(childSpans.map((s) => s.name).sort()).toEqual(['judge:judge_1', 'judge:judge_2'])
  })

  it('multi-judge all traced — each gets unique span', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const judges = Array.from({ length: 4 }, (_, i) =>
      makeMockJudge([{ judgeName: `j${i}`, dimension: `d${i}`, score: 5 + i, reasoning: `r${i}` }]),
    )
    const names = judges.map((_, i) => `judge_${i}`)

    const ensemble = traceJudgeEnsemble(judges, names, { emitter })
    const input = {
      scenario: { id: 's1', persona: 'dev', label: 'test', thesis: 'test' } as any,
      turns: [{ userMessage: 'x', agentResponse: 'y' }] as any,
      artifacts: { codeBlocks: [] } as any,
    }
    await ensemble({} as any, input)

    const spans = await store.spans({ runId: 'test-run' })
    // 1 ensemble + 4 child spans
    expect(spans.length).toBe(5)
    const judgeSpans = spans.filter((s) => s.name.startsWith('judge:judge_'))
    expect(judgeSpans.length).toBe(4)
    // Each has a unique spanId
    const ids = new Set(judgeSpans.map((s) => s.spanId))
    expect(ids.size).toBe(4)
  })

  it('judge failure emits error status on span', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const failingJudge: JudgeFn = async () => {
      throw new Error('LLM timeout')
    }
    const traced = traceJudge(failingJudge, 'failing', { emitter })

    const input = {
      scenario: { id: 's1', persona: 'dev', label: 'test', thesis: 'test' } as any,
      turns: [{ userMessage: 'x', agentResponse: 'y' }] as any,
      artifacts: { codeBlocks: [] } as any,
    }
    await expect(traced({} as any, input)).rejects.toThrow('LLM timeout')

    const spans = await store.spans({ runId: 'test-run' })
    expect(spans[0]!.status).toBe('error')
    expect(spans[0]!.error).toBe('LLM timeout')
  })
})
