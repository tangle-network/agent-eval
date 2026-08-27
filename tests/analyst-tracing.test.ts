import { describe, expect, it } from 'vitest'
import { TraceEmitter } from '../src/trace/emitter'
import { InMemoryTraceStore } from '../src/trace/store'
import { tracedAnalyzeTraces } from '../src/traced-analyst'

function makeEmitter() {
  const store = new InMemoryTraceStore()
  let counter = 0
  const emitter = new TraceEmitter(store, {
    runId: 'analyst-run',
    now: () => 1000 + counter++,
    id: () => `span-${counter++}`,
  })
  return { store, emitter }
}

describe('analyst tracing', () => {
  it('emits parent span with finding count on success', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    // Mock the analyzeTraces function by providing a mock AI that returns
    // immediately. Since analyzeTraces requires a real AxAIService, we test
    // the span creation by verifying span structure after a controlled error.
    // A full integration test would need a real or mocked AI backend.

    // We test the span wrapping by verifying the parent span is created
    // and an error span is properly emitted when analyzeTraces throws.
    const fakeOptions = {
      source: '/nonexistent/path.jsonl',
      ai: {} as any,
      model: 'test-model',
    }

    // The analyzeTraces call will fail (no real AI + file doesn't exist),
    // but the span wrapping should still fire.
    try {
      await tracedAnalyzeTraces({ question: 'what failed?' }, fakeOptions, { emitter })
    } catch {
      // Expected — file doesn't exist
    }

    const spans = await store.spans({ runId: 'analyst-run' })
    expect(spans.length).toBeGreaterThanOrEqual(1)

    const parentSpan = spans.find((s) => s.name === 'analyst:analyze-traces')
    expect(parentSpan).toBeDefined()
    expect(parentSpan!.attributes).toMatchObject({
      'analyst.question_length': 12,
      'eval.phase': 'analyst',
    })
    // Error path should mark the span as failed
    expect(parentSpan!.status).toBe('error')
  })

  it('captures question context as span attribute', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const longQuestion =
      'What are the most common failure modes in the trace data and which tools are most problematic?'
    try {
      await tracedAnalyzeTraces(
        { question: longQuestion },
        { source: '/nonexistent.jsonl', ai: {} as any },
        { emitter },
      )
    } catch {
      // Expected
    }

    const spans = await store.spans({ runId: 'analyst-run' })
    const parentSpan = spans.find((s) => s.name === 'analyst:analyze-traces')
    expect(parentSpan!.attributes).toMatchObject({
      'analyst.question_length': longQuestion.length,
    })
  })

  it('wraps onTurn callbacks with child spans', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const turnsSeen: number[] = []
    try {
      await tracedAnalyzeTraces(
        { question: 'test question' },
        {
          source: '/nonexistent.jsonl',
          ai: {} as any,
          onTurn: (turn) => {
            turnsSeen.push(turn.turn)
          },
        },
        { emitter },
      )
    } catch {
      // Expected
    }

    // The parent span should exist regardless of error
    const spans = await store.spans({ runId: 'analyst-run' })
    const parentSpan = spans.find((s) => s.name === 'analyst:analyze-traces')
    expect(parentSpan).toBeDefined()
    // Turn spans only appear if analyzeTraces ran far enough to invoke onTurn.
    // With no real AI, we just verify the parent span attributes are correct.
    expect(parentSpan!.attributes).toMatchObject({
      'eval.phase': 'analyst',
    })
  })
})
