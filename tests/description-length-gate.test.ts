import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type DescriptionLengthCandidate,
  DescriptionLengthGate,
  dataDescriptionBits,
  modelDescriptionBits,
} from '../src/description-length-gate'
import type { RunRecord } from '../src/run-record'

function record(candidateId: string, task: string, score: number): RunRecord {
  return {
    runId: `${candidateId}-${task}`,
    experimentId: `exp:${task}`,
    candidateId,
    seed: 0,
    model: 'claude-sonnet-4-6@2025-04-15',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: 1000,
    costUsd: 0,
    tokenUsage: { input: 100, output: 100 },
    outcome: { holdoutScore: score, raw: { score } },
    splitTag: 'holdout',
    scenarioId: task,
  }
}

function candidate(
  id: string,
  content: string,
  scores: Record<string, number>,
): DescriptionLengthCandidate {
  return { content, runs: Object.entries(scores).map(([task, s]) => record(id, task, s)) }
}

const small = 'follow the protocol exactly; verify before finishing.'

describe('description-length primitives', () => {
  it('model bits grow with model size', () => {
    expect(modelDescriptionBits(small.repeat(50))).toBeGreaterThan(modelDescriptionBits(small))
  })

  it('data bits fall as scores rise; perfect scores cost ~0', () => {
    const keys = ['a', 'b', 'c']
    const perfect = new Map(keys.map((k) => [k, 1]))
    const mediocre = new Map(keys.map((k) => [k, 0.5]))
    expect(dataDescriptionBits(perfect, keys, 2 ** -10)).toBeCloseTo(0, 6)
    expect(dataDescriptionBits(mediocre, keys, 2 ** -10)).toBeCloseTo(3, 6) // each 0.5 task = 1 bit
  })

  it('a failed task is capped by the score floor, not infinite', () => {
    const bits = dataDescriptionBits(new Map([['a', 0]]), ['a'], 2 ** -10)
    expect(bits).toBeCloseTo(10, 6) // −log2(2^-10)
    expect(Number.isFinite(bits)).toBe(true)
  })
})

describe('DescriptionLengthGate', () => {
  const tasks = { a: 0.5, b: 0.5, c: 0.5, d: 0.5 }

  it('promotes a compact candidate that improves outcomes', () => {
    const gate = new DescriptionLengthGate({ baselineKey: 'baseline' })
    const decision = gate.evaluate(
      candidate('cand', small, { a: 0.9, b: 0.9, c: 0.9, d: 0.9 }),
      candidate('baseline', small, tasks),
    )
    expect(decision.promote).toBe(true)
    expect(decision.evidence.dataBitsDelta).toBeLessThan(0)
    expect(decision.rejectionCode).toBeNull()
  })

  it('rejects a model that improves outcomes but bloats — the MDL anti-overfit core', () => {
    const gate = new DescriptionLengthGate({ baselineKey: 'baseline' })
    // Genuine bloat must be high-entropy — gzip correctly sees through
    // low-entropy repetition. Incompressible hex stands in for memorization.
    const entropy = Array.from({ length: 30 }, (_, i) =>
      createHash('sha256').update(`b${i}`).digest('hex'),
    ).join('')
    const bloated = `${small} ${entropy}`
    const decision = gate.evaluate(
      candidate('cand', bloated, { a: 0.55, b: 0.55, c: 0.55, d: 0.55 }),
      candidate('baseline', small, tasks),
    )
    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('model_bloat')
    expect(decision.evidence.dataBitsDelta).toBeLessThan(0) // outcomes DID improve
    expect(decision.evidence.modelBitsDelta).toBeGreaterThan(0) // but the model grew more
  })

  it('rejects when outcomes do not improve', () => {
    const gate = new DescriptionLengthGate({ baselineKey: 'baseline' })
    const decision = gate.evaluate(
      candidate('cand', small, { a: 0.4, b: 0.4, c: 0.4, d: 0.4 }),
      candidate('baseline', small, tasks),
    )
    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('no_total_gain')
  })

  const bigger = `${small} additionally, double-check each edge case named in the tests.`
  const manyTasks = (score: number) =>
    Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`t${i}`, score]))

  it('a bigger model wins once enough evidence justifies its bits', () => {
    const gate = new DescriptionLengthGate({ baselineKey: 'baseline' })
    const decision = gate.evaluate(
      candidate('cand', bigger, manyTasks(1)),
      candidate('baseline', small, manyTasks(0.5)),
    )
    expect(decision.evidence.modelBitsDelta).toBeGreaterThan(0)
    expect(decision.evidence.dataBitsDelta).toBeLessThan(-decision.evidence.modelBitsDelta)
    expect(decision.promote).toBe(true)
  })

  it('lambda scales the model penalty: doubling it rejects the same bigger model', () => {
    const cand = candidate('cand', bigger, manyTasks(1))
    const base = candidate('baseline', small, manyTasks(0.5))
    expect(
      new DescriptionLengthGate({ baselineKey: 'baseline', lambda: 1 }).evaluate(cand, base)
        .promote,
    ).toBe(true)
    expect(
      new DescriptionLengthGate({ baselineKey: 'baseline', lambda: 2 }).evaluate(cand, base)
        .promote,
    ).toBe(false)
  })

  it('refuses to promote below the task floor', () => {
    const gate = new DescriptionLengthGate({ baselineKey: 'baseline', minTasks: 3 })
    const decision = gate.evaluate(
      candidate('cand', small, { a: 0.9, b: 0.9 }),
      candidate('baseline', small, { a: 0.5, b: 0.5 }),
    )
    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('few_tasks')
  })
})
