import { describe, it, expect } from 'vitest'
import { InMemoryTraceStore } from '../src/trace/store'
import { TraceEmitter } from '../src/trace/emitter'
import { traceMutator } from '../src/traced-mutator'
import type { MutateAdapter, EvolvableVariant, VariantAggregate, TrialResult } from '../src/prompt-evolution'

function makeEmitter() {
  const store = new InMemoryTraceStore()
  let counter = 0
  const emitter = new TraceEmitter(store, {
    runId: 'mutator-run',
    now: () => 1000 + counter++,
    id: () => `span-${counter++}`,
  })
  return { store, emitter }
}

function makeMockMutator<P>(children: EvolvableVariant<P>[]): MutateAdapter<P> {
  return {
    async mutate() {
      return children
    },
  }
}

describe('mutator tracing', () => {
  it('emits span with mutation context on success', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const children: EvolvableVariant<string>[] = [
      { id: 'child-1', label: 'strengthen imperative', generation: 1, payload: 'new prompt v1' },
      { id: 'child-2', label: 'add example', generation: 1, payload: 'new prompt v2' },
    ]
    const inner = makeMockMutator(children)
    const traced = traceMutator(inner, { emitter })

    const result = await traced.mutate({
      parent: { id: 'parent-1', label: 'baseline', generation: 0, payload: 'original prompt' },
      parentAggregate: { meanScore: 0.72, trials: 10, passRate: 0.8 } as VariantAggregate,
      topTrials: [{} as TrialResult, {} as TrialResult],
      bottomTrials: [{} as TrialResult],
      childCount: 2,
      generation: 1,
    })

    expect(result).toEqual(children)

    const spans = await store.spans({ runId: 'mutator-run' })
    expect(spans.length).toBe(1)
    expect(spans[0]!.name).toBe('mutator:gen-1')
    expect(spans[0]!.kind).toBe('llm')
    expect(spans[0]!.status).toBe('ok')
    expect(spans[0]!.attributes).toMatchObject({
      'mutator.parent_id': 'parent-1',
      'mutator.generation': 1,
      'mutator.child_count': 2,
      'mutator.produced_count': 2,
      'mutator.child_ids': 'child-1,child-2',
      'eval.phase': 'mutator',
    })
  })

  it('emits error span when mutation fails', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const failing: MutateAdapter<string> = {
      async mutate() {
        throw new Error('LLM rate limit')
      },
    }
    const traced = traceMutator(failing, { emitter })

    await expect(
      traced.mutate({
        parent: { id: 'p', label: 'x', generation: 0, payload: 'x' },
        parentAggregate: { meanScore: 0.5, trials: 5, passRate: 0.5 } as VariantAggregate,
        topTrials: [],
        bottomTrials: [],
        childCount: 2,
        generation: 0,
      }),
    ).rejects.toThrow('LLM rate limit')

    const spans = await store.spans({ runId: 'mutator-run' })
    expect(spans[0]!.status).toBe('error')
    expect(spans[0]!.error).toBe('LLM rate limit')
  })

  it('records parent score in span attributes', async () => {
    const { store, emitter } = makeEmitter()
    await emitter.startRun({ scenarioId: 'test', layer: 'meta', projectId: 'test' })

    const inner = makeMockMutator<string>([])
    const traced = traceMutator(inner, { emitter })

    await traced.mutate({
      parent: { id: 'p', label: 'x', generation: 2, payload: 'x' },
      parentAggregate: { meanScore: 0.85, trials: 15, passRate: 0.9 } as VariantAggregate,
      topTrials: [{} as TrialResult],
      bottomTrials: [{} as TrialResult, {} as TrialResult, {} as TrialResult],
      childCount: 3,
      generation: 2,
    })

    const spans = await store.spans({ runId: 'mutator-run' })
    expect(spans[0]!.attributes).toMatchObject({
      'mutator.parent_score': 0.85,
      'mutator.top_trials': 1,
      'mutator.bottom_trials': 3,
    })
  })
})
