import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseSystemOneRecordedRequest,
  parseSystemOneRequest,
  parseSystemOneResult,
} from '../src/systemone-protocol'

const archived = () => ({
  request: {
    model: 'jev-1.13.0',
    state: null,
    questions: { grade: { type: 'score', criteria: [null, { satisfied: true }] } },
  },
  result: {
    model: 'jev-1.13.0',
    answers: {
      grade: {
        type: 'score',
        score: 0.8,
        confidence: 0.6,
        legend: { 0: null, 1: { satisfied: true } },
        probabilities: { 0: 0.2, 1: 0.8 },
      },
    },
    usage: { input_tokens: 42, output_tokens: 3 },
  },
  costHeader: '0.0100',
})

describe('recorded System One evidence is not live request admission', () => {
  it('reads an old persisted decision twice without changing evidence or allowing redispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'systemone-archive-'))
    try {
      const file = join(root, 'observation.json')
      const bytes = JSON.stringify(archived())
      await writeFile(file, bytes)
      for (let pass = 0; pass < 2; pass++) {
        const observation = JSON.parse(await readFile(file, 'utf8'))
        const request = parseSystemOneRecordedRequest(observation.request)
        expect(parseSystemOneResult(observation.result, request)).toBe(observation.result)
        expect(() => parseSystemOneRequest(request)).toThrow()
        expect(observation.costHeader).toBe('0.0100')
        expect(JSON.stringify(observation)).toBe(bytes)
      }
      expect(await readFile(file, 'utf8')).toBe(bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies identical result checks to old and current requests', () => {
    const observation = archived()
    const request = parseSystemOneRecordedRequest(observation.request)
    observation.result.answers.grade.legend[0] = 'rewritten' as never
    expect(() => parseSystemOneResult(observation.result, request)).toThrow(/rubric/)
    const malformed = archived()
    malformed.result.answers.grade.probabilities[1] = 0.4
    expect(() => parseSystemOneResult(malformed.result, request)).toThrow(/distribution/)
  })

  it('allows current observations through either reader, preserving authored option order', () => {
    const request = {
      model: 'jev-1.13.0',
      state: { action: 'review' },
      questions: { next: { type: 'choice', criteria: { review: null, finish: { done: true } } } },
    }
    const bytes = JSON.stringify(request)
    expect(parseSystemOneRecordedRequest(request)).toBe(request)
    expect(parseSystemOneRequest(request)).toBe(request)
    expect(JSON.stringify(request)).toBe(bytes)
  })

  it('does not widen historical decoding to corrupted or lossy records', () => {
    for (const state of [false, 7, undefined, new Date(), { count: Infinity }]) {
      expect(() => parseSystemOneRecordedRequest({ ...archived().request, state })).toThrow()
    }
    const invalid = archived().request
    invalid.questions.grade.criteria = [null] as never
    expect(() => parseSystemOneRecordedRequest(invalid)).toThrow(/two/)
  })

  it('still rejects null score levels on the paid path when state is valid', () => {
    const request = { ...archived().request, state: 'evidence' }
    expect(parseSystemOneRecordedRequest(request)).toBe(request)
    expect(() => parseSystemOneRequest(request)).toThrow(/score level/)
  })
})
