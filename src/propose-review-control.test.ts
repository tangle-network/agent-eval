import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore, inMemoryReviewStore } from './index'
import { runProposeReviewAsControlLoop } from './propose-review-control'

interface State {
  text: string
}

describe('runProposeReviewAsControlLoop', () => {
  it('adapts propose/verify/review into the generic control loop', async () => {
    const store = new InMemoryTraceStore()
    const result = await runProposeReviewAsControlLoop<State>({
      goal: 'make text contain done',
      initialState: { text: '' },
      maxShots: 3,
      store,
      propose: async ({ state, priorReview }) => ({
        state: {
          text: priorReview ? `${state.text} done` : `${state.text} draft`,
        },
        traceSummary: { chars: state.text.length },
      }),
      verify: async (state) => ({
        pass: state.text.includes('done'),
        score: state.text.includes('done') ? 1 : 0.2,
        failingLayers: state.text.includes('done') ? [] : ['content'],
      }),
      review: async () => ({
        observations: 'missing required word',
        diagnosis: 'content incomplete',
        nextShotInstruction: 'add done',
        shouldContinue: true,
        confidence: 0.8,
      }),
    })

    expect(result.pass).toBe(true)
    expect(result.finalState?.state.text).toBe(' draft done')
    expect(result.steps).toHaveLength(2)
    expect(result.finalState?.memory).toHaveLength(2)
    expect(result.finalState?.verification.pass).toBe(true)
    expect(result.runId).toBeTruthy()
    const spans = await store.spans({ runId: result.runId! })
    expect(spans.some((span) => span.name === 'control-step-0')).toBe(true)
    expect(spans.some((span) => span.name === 'control-step-1')).toBe(true)
    expect(spans.some((span) => span.name === 'control-eval/verification')).toBe(true)
  })

  it('persists reviewer memory and feeds review instructions into the next shot', async () => {
    const memory = inMemoryReviewStore()
    const receivedInstructions: (string | null)[] = []

    const result = await runProposeReviewAsControlLoop<{ steps: string[] }>({
      goal: 'collect two directed steps',
      initialState: { steps: [] },
      maxShots: 4,
      memory,
      propose: async ({ state, priorReview }) => {
        receivedInstructions.push(priorReview?.nextShotInstruction ?? null)
        const next = priorReview?.nextShotInstruction === 'add b' ? 'b' : 'a'
        return { state: { steps: [...state.steps, next] } }
      },
      verify: async (state) => ({
        pass: state.steps.includes('a') && state.steps.includes('b'),
        score: state.steps.length / 2,
        failingLayers: state.steps.includes('b') ? [] : ['sequence'],
      }),
      review: async () => ({
        observations: 'b is missing',
        diagnosis: 'worker needs the second step',
        nextShotInstruction: 'add b',
        shouldContinue: true,
        confidence: 0.9,
      }),
    })

    expect(result.pass).toBe(true)
    expect(result.finalState?.state.steps).toEqual(['a', 'b'])
    expect(receivedInstructions).toEqual([null, 'add b'])
    expect(await memory.load()).toHaveLength(2)
  })

  it('uses verifier failure taxonomy when reviewer stops continuation', async () => {
    const result = await runProposeReviewAsControlLoop<State>({
      goal: 'unreachable',
      initialState: { text: '' },
      maxShots: 5,
      propose: async ({ state }) => ({ state }),
      verify: async () => ({
        pass: false,
        score: 0,
        failingLayers: ['required-output'],
      }),
      review: async () => ({
        observations: 'worker cannot produce the required output',
        diagnosis: 'missing capability',
        nextShotInstruction: 'stop',
        shouldContinue: false,
        confidence: 0.95,
      }),
    })

    expect(result.pass).toBe(false)
    expect(result.completed).toBe(true)
    expect(result.failureClass).toBe('instruction_following')
    expect(result.steps).toHaveLength(1)
  })

  it('lets callers map domain verification failures into shared failure classes', async () => {
    const result = await runProposeReviewAsControlLoop<State>({
      goal: 'unreachable because budget is gone',
      initialState: { text: '' },
      maxShots: 2,
      failureClassFromVerification: (verification) =>
        verification.failingLayers?.includes('cost') ? 'budget_exceeded' : 'unknown',
      propose: async ({ state }) => ({ state }),
      verify: async () => ({
        pass: false,
        score: 0,
        failingLayers: ['cost'],
      }),
      review: async () => ({
        observations: 'budget exhausted',
        diagnosis: 'no further useful shot',
        nextShotInstruction: 'stop',
        shouldContinue: false,
        confidence: 1,
      }),
    })

    expect(result.pass).toBe(false)
    expect(result.failureClass).toBe('budget_exceeded')
  })
})
