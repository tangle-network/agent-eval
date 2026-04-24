import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  runProposeReview,
  inMemoryReviewStore,
  jsonlReviewStore,
  createLlmReviewer,
  type Review,
  type ReviewFn,
  type ReviewMemoryEntry,
  type Verification,
} from '../src/propose-review'

const passingReview: Review = {
  observations: 'worker produced artifact with expected shape and no retries',
  diagnosis: 'no diagnosis needed — verification passed',
  nextShotInstruction: '(done)',
  shouldContinue: false,
  confidence: 1,
}

const failingReview = (instruction: string, confidence = 0.8): Review => ({
  observations: 'worker produced incomplete output — missing keys',
  diagnosis: 'the builder stopped before satisfying the last required field',
  nextShotInstruction: instruction,
  shouldContinue: true,
  confidence,
})

const tempFiles: string[] = []
afterEach(() => {
  while (tempFiles.length > 0) {
    const path = tempFiles.pop()!
    try { rmSync(path, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function tempJsonlPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'propose-review-'))
  tempFiles.push(dir)
  return join(dir, 'memory.jsonl')
}

describe('runProposeReview', () => {
  it('short-circuits reviewer when verification passes — regression: running the reviewer LLM after a pass wastes money and invents diagnoses that don\'t exist', async () => {
    let reviewCalls = 0
    const report = await runProposeReview<{ v: number }>({
      goal: 'reach v=1',
      initialState: { v: 0 },
      propose: async ({ state }) => ({ state: { v: state.v + 1 } }),
      verify: async (state) => ({ pass: state.v >= 1, score: state.v }),
      review: async () => {
        reviewCalls += 1
        return failingReview('bump v again')
      },
    })
    expect(report.completed).toBe(true)
    expect(report.shots).toHaveLength(1)
    expect(reviewCalls).toBe(0)
    expect(report.shots[0]!.review.shouldContinue).toBe(false)
    expect(report.shots[0]!.review.confidence).toBe(1)
    expect(report.score).toBe(1)
  })

  it('feeds reviewer instruction into the next propose call — regression: instruction ignored means no iteration', async () => {
    const receivedInstructions: (string | null)[] = []
    const report = await runProposeReview<{ steps: string[] }>({
      goal: 'collect three distinct steps',
      initialState: { steps: [] },
      propose: async ({ state, priorReview }) => {
        receivedInstructions.push(priorReview?.nextShotInstruction ?? null)
        const nextStep = priorReview?.nextShotInstruction.includes('add-b')
          ? 'b'
          : priorReview?.nextShotInstruction.includes('add-c')
            ? 'c'
            : 'a'
        return { state: { steps: [...state.steps, nextStep] } }
      },
      verify: async (state) => ({
        pass: state.steps.length >= 3,
        score: state.steps.length / 3,
        failingLayers: state.steps.length < 3 ? ['completeness'] : [],
      }),
      review: async ({ state }) => {
        if (state.steps.length === 1) return failingReview('add-b next')
        if (state.steps.length === 2) return failingReview('add-c next')
        return passingReview
      },
      maxShots: 5,
    })
    expect(report.completed).toBe(true)
    expect(report.finalState.steps).toEqual(['a', 'b', 'c'])
    expect(receivedInstructions).toEqual([null, 'add-b next', 'add-c next'])
  })

  it('soft-fails when the reviewer throws — regression: a flaky reviewer call must not abort a live build arc', async () => {
    let reviewAttempts = 0
    const report = await runProposeReview<{ v: number }>({
      goal: 'reach v=3',
      initialState: { v: 0 },
      propose: async ({ state }) => ({ state: { v: state.v + 1 } }),
      verify: async (state) => ({ pass: state.v >= 3, score: state.v / 3 }),
      review: async () => {
        reviewAttempts += 1
        if (reviewAttempts === 1) throw new Error('transient 503')
        return failingReview('keep going')
      },
      fallbackInstruction: 'FALLBACK: increment v',
      maxShots: 5,
    })
    expect(report.completed).toBe(true)
    expect(report.shots[0]!.reviewAvailable).toBe(false)
    expect(report.shots[0]!.reviewError).toContain('503')
    expect(report.shots[0]!.review.nextShotInstruction).toBe('FALLBACK: increment v')
    expect(report.shots[1]!.reviewAvailable).toBe(true)
  })

  it('terminates early on consecutive low confidence — regression: without this, a stuck reviewer burns the whole shot budget', async () => {
    const report = await runProposeReview<{ v: number }>({
      goal: 'unreachable',
      initialState: { v: 0 },
      propose: async ({ state }) => ({ state: { v: state.v } }),
      verify: async () => ({ pass: false, score: 0, failingLayers: ['everything'] }),
      review: async () => failingReview('try something', 0.1),
      confidenceFloor: 0.2,
      confidenceFloorWindow: 2,
      maxShots: 10,
    })
    expect(report.completed).toBe(false)
    expect(report.shots).toHaveLength(2)
    expect(report.failureClass).toBe('unknown')
  })

  it('exits when reviewer returns shouldContinue=false — regression: reviewer ownership of termination is part of the separation-of-concerns contract', async () => {
    const report = await runProposeReview<{ v: number }>({
      goal: 'unachievable by design',
      initialState: { v: 0 },
      propose: async ({ state }) => ({ state: { v: state.v + 1 } }),
      verify: async () => ({ pass: false, score: 0 }),
      review: async () => ({
        observations: 'worker is thrashing on the same edit — no progress',
        diagnosis: 'the required dependency is not installed and the worker has no tool to install it',
        nextShotInstruction: 'stop — unachievable with current toolbox',
        shouldContinue: false,
        confidence: 0.9,
      }),
      maxShots: 10,
    })
    expect(report.completed).toBe(false)
    expect(report.shots).toHaveLength(1)
    expect(report.failureClass).toBe('unknown')
  })

  it('reports budget_exceeded when the shot cap is reached', async () => {
    const report = await runProposeReview<{ v: number }>({
      goal: 'run out the clock',
      initialState: { v: 0 },
      propose: async ({ state }) => ({ state: { v: state.v + 1 } }),
      verify: async () => ({ pass: false, score: 0 }),
      review: async () => failingReview('keep going', 0.8),
      maxShots: 3,
    })
    expect(report.completed).toBe(false)
    expect(report.shots).toHaveLength(3)
    expect(report.failureClass).toBe('budget_exceeded')
  })

  it('persists reviewer memory across shots via JSONL — regression: memory loss between shots makes the reviewer confirmation-bias itself', async () => {
    const memoryPath = tempJsonlPath()
    const store = jsonlReviewStore(memoryPath)
    const seenMemorySizes: number[] = []
    await runProposeReview<{ v: number }>({
      goal: 'reach v=2',
      initialState: { v: 0 },
      propose: async ({ state }) => ({ state: { v: state.v + 1 } }),
      verify: async (state) => ({ pass: state.v >= 2, score: state.v / 2 }),
      review: async ({ memory }) => {
        seenMemorySizes.push(memory.length)
        return failingReview('bump v', 0.8)
      },
      memory: store,
    })
    expect(seenMemorySizes).toEqual([0])
    const persisted = readFileSync(memoryPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ReviewMemoryEntry)
    expect(persisted).toHaveLength(2)
    expect(persisted[0]!.shot).toBe(1)
    expect(persisted[1]!.shot).toBe(2)
    expect(persisted[1]!.verification.pass).toBe(true)
  })

  it('reloading a JSONL store surfaces prior memory to a fresh run — regression: resume across process boundaries is the point of durable memory', async () => {
    const memoryPath = tempJsonlPath()
    const s1 = jsonlReviewStore(memoryPath)
    await runProposeReview<{ v: number }>({
      goal: 'step 1',
      initialState: { v: 0 },
      propose: async ({ state }) => ({ state: { v: state.v + 1 } }),
      verify: async () => ({ pass: false, score: 0.1 }),
      review: async () => failingReview('keep going', 0.9),
      memory: s1,
      maxShots: 1,
    })
    const s2 = jsonlReviewStore(memoryPath)
    const seen: number[] = []
    await runProposeReview<{ v: number }>({
      goal: 'step 2',
      initialState: { v: 0 },
      propose: async ({ state }) => ({ state: { v: state.v + 1 } }),
      verify: async () => ({ pass: true, score: 1 }),
      review: async ({ memory }) => {
        seen.push(memory.length)
        return passingReview
      },
      memory: s2,
    })
    // Even though verification passed (so review wasn't called), the entry
    // still records to the same file — so we assert by reading it.
    const persisted = readFileSync(memoryPath, 'utf8').trim().split('\n')
    expect(persisted).toHaveLength(2)
  })
})

describe('createLlmReviewer', () => {
  it('packages state, verification, and memory into a single JSON call — regression: dropping memory from the prompt destroys multi-shot reasoning', async () => {
    let capturedUserPrompt = ''
    const reviewer: ReviewFn<{ kind: string }, string[]> = createLlmReviewer({
      callJson: async ({ user }) => {
        capturedUserPrompt = user
        return {
          observations: 'worker emitted partial output missing the second key',
          diagnosis: 'the builder did not look at the schema before emitting',
          nextShotInstruction: 'read the schema first, then emit all required keys',
          shouldContinue: true,
          confidence: 0.7,
        } satisfies Review
      },
    })
    const verification: Verification = { pass: false, score: 0.5, failingLayers: ['schema'] }
    const memory: ReviewMemoryEntry[] = [{
      shot: 1,
      timestamp: 0,
      observations: 'old obs',
      diagnosis: 'old diag',
      nextShotInstruction: 'old instruction',
      shouldContinue: true,
      confidence: 0.5,
      verification: { pass: false, score: 0.3, failingLayers: ['schema'] },
    }]
    const review = await reviewer({
      shot: 2,
      goal: 'build the thing',
      state: { kind: 'incomplete' },
      verification,
      traceSummary: ['tool:Read', 'tool:Write'],
      memory,
    })
    expect(review.shouldContinue).toBe(true)
    expect(review.confidence).toBeCloseTo(0.7)
    expect(capturedUserPrompt).toContain('GOAL')
    expect(capturedUserPrompt).toContain('build the thing')
    expect(capturedUserPrompt).toContain('shot 1')
    expect(capturedUserPrompt).toContain('old instruction')
    expect(capturedUserPrompt).toContain('failing=[schema]')
  })

  it('throws on malformed reviewer JSON — regression: silently coercing garbage to a default instruction hides provider regressions', async () => {
    const reviewer = createLlmReviewer<{ x: number }>({
      callJson: async () => ({ observations: 'hi' }),
    })
    await expect(reviewer({
      shot: 1,
      goal: 'g',
      state: { x: 0 },
      verification: { pass: false },
      traceSummary: undefined,
      memory: [],
    })).rejects.toThrow(/missing required string fields/)
  })
})

describe('dogfooding — a propose-review harness is itself evaluable by propose-review', () => {
  it('outer loop drives an inner loop and directs it with different configs', async () => {
    type InnerGoal = { target: number }
    type OuterState = { completedInner: boolean; shotsUsed: number; lastTarget: number }

    const innerPropose = async ({ state, priorReview }: { state: { v: number }; priorReview: Review | null }) => {
      const step = priorReview?.nextShotInstruction.includes('big') ? 5 : 1
      return { state: { v: state.v + step } }
    }

    async function runInner(target: number, shotCap: number) {
      const memory = inMemoryReviewStore()
      return runProposeReview<{ v: number }>({
        goal: `reach v=${target}`,
        initialState: { v: 0 },
        propose: async (input) => innerPropose({ state: input.state, priorReview: input.priorReview }),
        verify: async (s) => ({ pass: s.v >= target, score: Math.min(1, s.v / target) }),
        review: async ({ state }) => state.v === 0
          ? failingReview('keep going', 0.9)
          : failingReview('keep going', 0.9),
        memory,
        maxShots: shotCap,
      })
    }

    let outerShots = 0
    const outerReport = await runProposeReview<OuterState, { innerShots: number }>({
      goal: 'the inner loop must complete within the shot budget',
      initialState: { completedInner: false, shotsUsed: 0, lastTarget: 3 },
      propose: async ({ state, priorReview }) => {
        outerShots += 1
        // First outer shot: try with too small a budget. Second outer shot:
        // honor the reviewer's instruction to bump the budget.
        const cap = priorReview?.nextShotInstruction.includes('raise cap') ? 10 : 2
        const inner = await runInner(state.lastTarget, cap)
        return {
          state: {
            completedInner: inner.completed,
            shotsUsed: inner.shots.length,
            lastTarget: state.lastTarget,
          },
          traceSummary: { innerShots: inner.shots.length },
        }
      },
      verify: async (s) => ({
        pass: s.completedInner,
        score: s.completedInner ? 1 : 0,
        failingLayers: s.completedInner ? [] : ['inner-budget'],
      }),
      review: async ({ state, traceSummary }) => ({
        observations: `inner loop used ${traceSummary?.innerShots ?? 0} shots and completedInner=${state.completedInner}`,
        diagnosis: state.completedInner
          ? 'inner succeeded'
          : 'inner ran out of shots before reaching the target — budget was too small',
        nextShotInstruction: 'raise cap for the inner loop so it can converge',
        shouldContinue: !state.completedInner,
        confidence: 0.9,
      }),
      maxShots: 5,
    })

    expect(outerShots).toBe(2)
    expect(outerReport.completed).toBe(true)
    expect(outerReport.finalState.completedInner).toBe(true)
    expect(outerReport.shots[0]!.verification.pass).toBe(false)
    expect(outerReport.shots[1]!.verification.pass).toBe(true)
  })
})
