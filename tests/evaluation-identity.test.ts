import { describe, expect, it, vi } from 'vitest'
import type { Scenario } from '../src/campaign/types'
import { CostLedger } from '../src/cost-ledger'
import {
  asAnalyst,
  asJudge,
  createEvaluator,
  type EvaluationAnalystOptions,
  type EvaluationJudgeOptions,
} from '../src/evaluation'
import { type JevQuestions, type JevRequest, jevAnalyst, jevJudge } from '../src/jev'

const score = (value: number) => ({ dimensions: { metric: value }, composite: value, notes: '' })
const dimensions = () => [{ key: 'metric', description: 'Fixed metric' }]
const receipt = () => ({ model: 'fixture', inputTokens: 1, outputTokens: 1, actualCostUsd: 0.01 })
const requestQuestions = (reversed = false): JevQuestions => ({
  next: {
    type: 'choice',
    instructions: { scope: 'supplied evidence' },
    criteria: reversed ? { inspect: null, proceed: null } : { proceed: null, inspect: null },
  },
})
const native = async (request: JevRequest) => ({
  model: request.model,
  usage: { input_tokens: 1, output_tokens: 1 },
  answers: Object.fromEntries(
    Object.entries(request.questions).map(([name, question]) => {
      if (question.type !== 'choice') return [name, { type: 'noul', noul: 0.7 }]
      return [
        name,
        {
          type: 'choice',
          choice: Object.keys(question.criteria)[0],
          confidence: 0,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [key, 0.5]),
          ),
        },
      ]
    }),
  ),
})
const judge = (questions: JevQuestions) =>
  jevJudge<string>('route', {
    model: 'fixture',
    version: 'v1',
    questions,
    dimensions: dimensions(),
    renderState: ({ artifact }) => artifact,
    evaluate: native,
    receipt,
    map: () => score(0.7),
  })
const analyst = (questions: JevQuestions) =>
  jevAnalyst<string>({
    id: 'route',
    description: 'A caller-owned native classifier',
    inputKind: 'custom',
    model: 'fixture',
    version: 'v1',
    questions,
    renderState: (input) => input,
    evaluate: native,
    receipt,
    findings: () => [],
  })

describe('native evaluator identity retains authored ordering', () => {
  it('choice reordering changes both judge and analyst versions', () => {
    expect(judge(requestQuestions()).judgeVersion).not.toBe(
      judge(requestQuestions(true)).judgeVersion,
    )
    expect(analyst(requestQuestions()).version).not.toBe(analyst(requestQuestions(true)).version)
  })

  it('question order changes identity even when explicit judge dimensions stay stable', () => {
    const next = requestQuestions().next!
    const check = { type: 'noul' } as const
    const a = { next, check }
    const b = { check, next }
    expect(judge(a).judgeVersion).not.toBe(judge(b).judgeVersion)
    expect(analyst(a).version).not.toBe(analyst(b).version)
  })

  it('dispatches the original order rather than canonical-key order', async () => {
    const execute = vi.fn(native)
    const questions = requestQuestions()
    const instance = jevJudge<string>('route', {
      model: 'fixture',
      version: 'v1',
      questions,
      dimensions: dimensions(),
      renderState: ({ artifact }) => artifact,
      evaluate: execute,
      receipt,
      map: () => score(1),
    })
    questions.next = requestQuestions(true).next!
    await instance.score({
      artifact: 'evidence',
      scenario: { id: 'case', kind: 'fixture' },
      signal: new AbortController().signal,
    })
    expect(Object.keys(execute.mock.calls[0]![0].questions.next!.criteria!)).toEqual([
      'proceed',
      'inspect',
    ])
  })

  it('is stable across JSON persistence and optional SDK undefined properties', () => {
    const questions = requestQuestions()
    questions.check = { type: 'noul', instructions: undefined, criteria: undefined }
    const restored = JSON.parse(JSON.stringify(questions)) as JevQuestions
    expect(judge(questions).judgeVersion).toBe(judge(restored).judgeVersion)
    expect(analyst(questions).version).toBe(analyst(restored).version)
  })

  it('still binds authored rubric values and model-independent configuration', () => {
    const a = requestQuestions()
    const b = requestQuestions()
    b.next = { type: 'choice', criteria: { proceed: { verified: true }, inspect: null } }
    expect(judge(a).judgeVersion).not.toBe(judge(b).judgeVersion)
  })
})

describe('constructed adapters retain the versioned callbacks and metadata', () => {
  it('judge callbacks cannot be swapped by mutating the supplied options', async () => {
    const ledger = new CostLedger()
    const evaluate = createEvaluator<{ artifact: number; scenario: Scenario }, number>({
      execute: async (input) => input.artifact,
      receipt,
    })
    const map = vi.fn(score)
    const record = vi.fn()
    const options: EvaluationJudgeOptions<number, Scenario, number> = {
      name: 'original',
      version: 'v1',
      dimensions: dimensions(),
      evaluate,
      map,
      record,
    }
    const instance = asJudge(options)
    options.name = 'replaced'
    options.version = 'v2'
    options.evaluate = vi.fn(async () => {
      throw new Error('replacement executed')
    })
    options.map = () => score(0)
    options.record = () => {
      throw new Error('replacement recorded')
    }
    options.dimensions[0]!.key = 'changed'
    const result = await instance.score({
      artifact: 0.7,
      scenario: { id: 'case', kind: 'fixture' },
      signal: new AbortController().signal,
      costLedger: ledger,
    })
    expect(result.composite).toBe(0.7)
    expect(instance.name).toBe('original')
    expect(instance.judgeVersion).toBe('v1')
    expect(instance.dimensions).toEqual(dimensions())
    expect(map).toHaveBeenCalledOnce()
    expect(record).toHaveBeenCalledOnce()
    expect(ledger.summary().totalCostUsd).toBe(0.01)
    expect(options.evaluate).not.toHaveBeenCalled()
  })

  it('analyst callbacks and cost metadata are detached from supplied options', async () => {
    const ledger = new CostLedger()
    const evaluate = createEvaluator<string, string>({ execute: async (input) => input, receipt })
    const map = vi.fn(() => [])
    const record = vi.fn()
    const cost = { kind: 'llm', models: ['fixture'] } as const
    const options: EvaluationAnalystOptions<string, string> = {
      id: 'original',
      description: 'Original analyst',
      version: 'v1',
      inputKind: 'custom',
      cost: { kind: cost.kind, models: [...cost.models] },
      evaluate: (input, context) => evaluate(input, context),
      map,
      record,
    }
    const instance = asAnalyst(options)
    options.evaluate = vi.fn(async () => {
      throw new Error('replacement executed')
    })
    options.map = () => {
      throw new Error('replacement mapped')
    }
    options.record = () => {
      throw new Error('replacement recorded')
    }
    options.id = 'replaced'
    if (options.cost.kind === 'llm' && options.cost.models) options.cost.models[0] = 'wrong-model'
    const result = await instance.analyze('evidence', {
      runId: 'run',
      correlationId: 'run',
      costLedger: ledger,
    })
    expect(result).toEqual([])
    expect(instance.id).toBe('original')
    expect(instance.cost).toEqual(cost)
    expect(record).toHaveBeenCalledOnce()
    expect(map).toHaveBeenCalledOnce()
    expect(options.evaluate).not.toHaveBeenCalled()
    expect(ledger.summary().totalCostUsd).toBe(0.01)
  })

  it('a native judge does not publish caller-mutable dimensions under a stable hash', () => {
    const declared = dimensions()
    const instance = jevJudge<string>('route', {
      model: 'fixture',
      version: 'v1',
      questions: requestQuestions(),
      dimensions: declared,
      renderState: () => null,
      evaluate: native,
      map: () => score(1),
    })
    const before = instance.judgeVersion
    declared[0]!.description = 'different metric'
    expect(instance.dimensions).toEqual(dimensions())
    expect(instance.judgeVersion).toBe(before)
  })
})
