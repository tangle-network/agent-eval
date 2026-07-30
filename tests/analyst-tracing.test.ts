import { describe, expect, it } from 'vitest'
import type { TraceAnalysisEngine } from '../src/analyst/engine'
import { TraceEmitter } from '../src/trace/emitter'
import { InMemoryTraceStore } from '../src/trace/store'
import { tracedAnalyzeTraces } from '../src/traced-analyst'

const engine: TraceAnalysisEngine = {
  id: 'test-engine',
  description: 'Unused because the source path is intentionally absent.',
  async analyze() {
    throw new Error('test engine should not run')
  },
}

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

    const fakeOptions = {
      source: '/nonexistent/path.jsonl',
      engine,
    }

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
        { source: '/nonexistent.jsonl', engine },
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
})
