import { describe, expect, it, vi } from 'vitest'
import type { ProductIntegrityArtifact } from '../examples/jev-product-integrity'
import { productIntegrityJudge, sourceFileJudge } from '../examples/jev-product-integrity'
import type { JevAnswer, JevRequest } from '../src/jev'

const scenario = { id: 'product', kind: 'product' }
const signal = () => new AbortController().signal
const artifact: ProductIntegrityArtifact = {
  intent: 'Persist records and show the result.',
  claims: [{ dimension: 'latency', claim: '1 ms', evidence: ['measurement.txt'] }],
  sources: [{ path: 'store.ts', content: 'await store.write(record)' }],
  tests: [{ path: 'store.test.ts', content: 'expect(await read()).toEqual(record)' }],
  measurements: [{ claim: '1 ms', code: 'start(); score(record); stop()' }],
}

function reply(request: JevRequest, overrides: Record<string, number[]> = {}) {
  const answers: Record<string, JevAnswer> = {}
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') {
      answers[key] = { type: 'noul', noul: overrides[key]?.[0] ?? 1 }
    } else if (question.type === 'score') {
      const probabilities = overrides[key]
        ?? question.criteria.map((_, index) => index === question.criteria.length - 1 ? 1 : 0)
      answers[key] = {
        type: 'score',
        score: probabilities.reduce((sum, probability, index) => sum + probability * index, 0),
        confidence: 0.5,
        legend: Object.fromEntries(question.criteria.map((value, index) => [index, value])),
        probabilities: Object.fromEntries(probabilities.map((value, index) => [index, value])),
      }
    }
  }
  return { model: request.model, answers, usage: { input_tokens: 100, output_tokens: 0 } }
}

function judge(overrides: Record<string, number[]> = {}) {
  const evaluate = vi.fn(async (request: JevRequest) => reply(request, overrides))
  return {
    evaluate,
    judge: productIntegrityJudge('product', { model: 'jev-test', version: 'v1', evaluate }),
  }
}

describe('application-owned Jev examples', () => {
  it('keeps product questions in an opt-in example and sends actual artifact evidence', async () => {
    const fixture = judge()
    await fixture.judge.score({ artifact, scenario, signal: signal() })
    const request = fixture.evaluate.mock.calls[0]?.[0]
    expect(Object.keys(request?.questions ?? {})).toHaveLength(8)
    expect(request?.state).toMatchObject({ intent: artifact.intent, sources: artifact.sources })
  })

  it('scores the highest levels as one', async () => {
    expect((await judge().judge.score({ artifact, scenario, signal: signal() })).composite).toBe(1)
  })

  it('separates a measurement defect from other dimensions', async () => {
    const result = await judge({ measurementHonesty: [0.8, 0.2, 0, 0] }).judge.score({ artifact, scenario, signal: signal() })
    expect(result.dimensions.measurementHonesty).toBeCloseTo(0.2 / 3)
    expect(result.dimensions.productMaturity).toBe(1)
  })

  it('preserves the score distribution', async () => {
    const result = await judge({ testsExerciseTheProduct: [0.3, 0.4, 0.2, 0.1] }).judge.score({ artifact, scenario, signal: signal() })
    expect(result.dimensions.testsExerciseTheProduct).toBeCloseTo(1.1 / 3)
    expect(result.distribution?.testsExerciseTheProduct?.[0]?.probability).toBe(0.3)
  })

  it('retains a boolean probability rather than thresholding it', async () => {
    const result = await judge({ deliverablesAreFinished: [0.05] }).judge.score({ artifact, scenario, signal: signal() })
    expect(result.dimensions.deliverablesAreFinished).toBe(0.05)
  })

  it('rejects missing answers', async () => {
    const instance = productIntegrityJudge('product', {
      model: 'jev-test', version: 'v1',
      evaluate: async (request) => {
        const response = reply(request)
        delete response.answers.sizeIsAuthored
        return response
      },
    })
    await expect(instance.score({ artifact, scenario, signal: signal() })).rejects.toThrow()
  })

  it('honors explicit weights', async () => {
    const instance = productIntegrityJudge('weighted', {
      model: 'jev-test', version: 'v1',
      evaluate: async (request) => reply(request, { measurementHonesty: [1, 0, 0, 0] }),
      weights: { measurementHonesty: 2, intentCoverage: 1 },
    })
    expect((await instance.score({ artifact, scenario, signal: signal() })).composite).toBeCloseTo(1 / 3)
  })

  it('refuses weights for undeclared dimensions', async () => {
    expect(() => productIntegrityJudge('bad', {
      model: 'jev-test', version: 'v1', evaluate: async (request) => reply(request), weights: { missing: 1 },
    })).toThrow()
  })

  it('can apply the same evaluator to a file contract', async () => {
    const evaluate = vi.fn(async (request: JevRequest) => reply(request, { completeness: [1, 0, 0, 0] }))
    const instance = sourceFileJudge('file', { model: 'jev-test', version: 'v1', evaluate })
    const file = { path: 'store.ts', content: 'throw new Error()', expectation: 'Persist records' }
    const result = await instance.score({ artifact: file, scenario, signal: signal() })
    expect(result.dimensions.completeness).toBe(0)
    expect(evaluate.mock.calls[0]?.[0]?.state).toEqual(file)
  })
})
