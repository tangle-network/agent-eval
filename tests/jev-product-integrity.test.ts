import { describe, expect, it, vi } from 'vitest'
import type { JevRequest, JevResult } from '../src/jev'
import {
  type ProductIntegrityArtifact,
  productIntegrityJudge,
  type SourceFileArtifact,
  sourceFileJudge,
} from '../src/jev-product-integrity'

const signal = () => new AbortController().signal
const scenario = { id: 'diu-continuity-node', kind: 'product' as const }

/** A packet shaped like the ones the campaign actually produced. */
const artifact = (): ProductIntegrityArtifact => ({
  intent: 'Ingest space-domain feeds, raise conjunction alerts, and let an analyst correct one.',
  claims: [
    {
      dimension: 'latency',
      claim: 'median 0.122 ms per assessment',
      evidence: ['artifacts/measurements/latency.json'],
    },
    {
      dimension: 'correctness',
      claim: '40/40 tests pass',
      evidence: ['product/tests/test_continuity.py'],
    },
  ],
  sources: [
    {
      path: 'src/assess.py',
      content: 'def assess(record):\n    store.write(record)\n    return score(record)\n',
    },
  ],
  tests: [
    {
      path: 'tests/test_continuity.py',
      content: 'def test_assess():\n    assert assess(sample()) is not None\n',
    },
  ],
  measurements: [
    {
      claim: 'median 0.122 ms per assessment',
      code: 'start = now()\nscore(record)\nelapsed = now() - start',
    },
  ],
  walkthrough: {
    transcript: 'opened dashboard; filtered to critical; opened subject',
    frames: 900,
    seconds: 45,
  },
  inventory: { sourceLines: 5083, vendoredLines: 0, fileCount: 88 },
})

const file: SourceFileArtifact = {
  path: 'src/ingest.py',
  content: 'def ingest(rows):\n    raise NotImplementedError\n',
  expectation: 'Accept rows and persist them.',
}

/**
 * Build answers from the request, the way a provider does. The adapter refuses a legend that
 * differs from the rubric it asked about, which is what stops a judge from being scored against
 * levels nobody requested — so a fixture that invents its own legend is not a valid provider.
 */
const answersFor = (
  request: JevRequest,
  levels: Record<string, number> = {},
  nouls: Record<string, number> = {},
): JevResult['answers'] => {
  const answers: JevResult['answers'] = {}
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'score') {
      const chosen = levels[key] ?? question.criteria.length - 1
      answers[key] = {
        type: 'score',
        score: chosen,
        confidence: 0.9,
        legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])),
        probabilities: Object.fromEntries(
          question.criteria.map((_, index) => [String(index), index === chosen ? 1 : 0]),
        ),
      }
    } else if (question.type === 'noul') {
      answers[key] = { type: 'noul', noul: nouls[key] ?? 1 }
    }
  }
  return answers
}

/** Replace one score answer with an explicit distribution over the same rubric. */
const spread = (
  request: JevRequest,
  answers: JevResult['answers'],
  key: string,
  probabilities: number[],
) => {
  const question = request.questions[key]
  if (question.type !== 'score') throw new Error('fixture: not a score question')
  return {
    ...answers,
    [key]: {
      type: 'score' as const,
      score: probabilities.reduce((sum, probability, index) => sum + probability * index, 0),
      confidence: 0.6,
      legend: Object.fromEntries(question.criteria.map((label, index) => [String(index), label])),
      probabilities: Object.fromEntries(
        probabilities.map((probability, index) => [String(index), probability]),
      ),
    },
  }
}

/** `answer` shapes the provider's reply from the request; `capture` records what was asked. */
const integrityJudge = (
  answer: (request: JevRequest) => JevResult['answers'],
  capture?: (request: JevRequest) => void,
) =>
  productIntegrityJudge('product-integrity', {
    model: 'jev-1.13.0',
    version: 'integrity-v1',
    evaluate: vi.fn(async (request: JevRequest) => {
      capture?.(request)
      return {
        model: request.model,
        answers: answer(request),
        usage: { input_tokens: 4200, output_tokens: 0 },
      }
    }),
    pricing: { inputUsdPerMillion: 0.042, outputUsdPerMillion: 0 },
  })

describe('product integrity judge', () => {
  it('asks the eight questions the campaign lost products to, and shows the artifact itself', async () => {
    let seen: JevRequest | undefined
    await integrityJudge(
      (request) => answersFor(request),
      (request) => {
        seen = request
      },
    ).score({ artifact: artifact(), scenario, signal: signal() })
    expect(Object.keys(seen?.questions ?? {}).sort()).toEqual([
      'claimsSupportedByEvidence',
      'deliverablesAreFinished',
      'intentCoverage',
      'measurementHonesty',
      'operatorWalkthrough',
      'productMaturity',
      'sizeIsAuthored',
      'testsExerciseTheProduct',
    ])
    // The judge reads the sources, not a description of them: a summary is where a director's
    // account of its own work would re-enter, and that account is the thing under test.
    const state = seen?.state as Record<string, unknown>
    expect(JSON.stringify(state.sources)).toContain('store.write(record)')
    expect(JSON.stringify(state.measurements)).toContain('elapsed = now() - start')
    expect(state.intent).toBe(artifact().intent)
  })

  it('scores a packet answered at the top of every rubric as one', async () => {
    const score = await integrityJudge((request) => answersFor(request)).score({
      artifact: artifact(),
      scenario,
      signal: signal(),
    })
    expect(score.composite).toBe(1)
    expect(score.dimensions.measurementHonesty).toBe(1)
  })

  it('separates a mis-scoped measurement from the rest of a healthy packet', async () => {
    // The wave-f defect: the timed region excluded the durable write, so latency read about
    // 6,500 times too fast while every other dimension stayed correct.
    const score = await integrityJudge((request) =>
      spread(request, answersFor(request), 'measurementHonesty', [0.8, 0.2, 0, 0]),
    ).score({ artifact: artifact(), scenario, signal: signal() })
    expect(score.dimensions.measurementHonesty).toBeCloseTo(0.2 / 3, 6)
    expect(score.dimensions.productMaturity).toBe(1)
    expect(score.composite).toBeLessThan(1)
  })

  it('carries the answer distribution through, so a gate thresholds on a failure mode', async () => {
    let seen: JevRequest | undefined
    const score = await integrityJudge(
      (request) =>
        spread(request, answersFor(request), 'testsExerciseTheProduct', [0.3, 0.4, 0.2, 0.1]),
      (request) => {
        seen = request
      },
    ).score({ artifact: artifact(), scenario, signal: signal() })
    // P(tautological) is the number a gate compares; the label alone would not carry it.
    expect(score.dimensions.testsExerciseTheProduct).toBeCloseTo(1.1 / 3, 6)
    const rubric = seen?.questions.testsExerciseTheProduct
    expect(rubric?.type === 'score' && rubric.criteria[0]).toMatch(/assert constants/u)
  })

  it('reports a boolean failure as a probability rather than a verdict', async () => {
    const score = await integrityJudge((request) =>
      answersFor(request, {}, { deliverablesAreFinished: 0.05 }),
    ).score({ artifact: artifact(), scenario, signal: signal() })
    expect(score.dimensions.deliverablesAreFinished).toBe(0.05)
    expect(score.composite).toBeLessThan(1)
  })

  it('refuses an answer set that omits a question, rather than scoring the rest', async () => {
    const judge = integrityJudge((request) => {
      const answers = answersFor(request)
      delete answers.sizeIsAuthored
      return answers
    })
    await expect(
      judge.score({ artifact: artifact(), scenario, signal: signal() }),
    ).rejects.toThrow()
  })

  it('accepts caller weights and refuses ones that name an unknown question', async () => {
    const weighted = productIntegrityJudge('weighted', {
      model: 'jev-1.13.0',
      version: 'integrity-v1',
      evaluate: vi.fn(async (request: JevRequest) => ({
        model: request.model,
        answers: answersFor(request, { measurementHonesty: 0 }),
        usage: { input_tokens: 1, output_tokens: 0 },
      })),
      weights: {
        measurementHonesty: 4,
        testsExerciseTheProduct: 2,
        productMaturity: 1,
        intentCoverage: 1,
        operatorWalkthrough: 1,
        claimsSupportedByEvidence: 1,
        deliverablesAreFinished: 1,
        sizeIsAuthored: 1,
      },
    })
    const score = await weighted.score({ artifact: artifact(), scenario, signal: signal() })
    // Four of twelve weight units sit on the failing question, so the composite is 8/12.
    expect(score.composite).toBeCloseTo(8 / 12, 6)
    expect(() =>
      productIntegrityJudge('bad', {
        model: 'jev-1.13.0',
        version: 'integrity-v1',
        evaluate: vi.fn(),
        weights: { notAQuestion: 1 },
      }),
    ).toThrow()
  })
})

describe('source file judge', () => {
  const fileJudge = (
    levels: Record<string, number>,
    nouls: Record<string, number> = {},
    capture?: (request: JevRequest) => void,
  ) =>
    sourceFileJudge('file', {
      model: 'jev-1.13.0',
      version: 'file-v1',
      evaluate: vi.fn(async (request: JevRequest) => {
        capture?.(request)
        return {
          model: request.model,
          answers: answersFor(request, levels, nouls),
          usage: { input_tokens: 300, output_tokens: 0 },
        }
      }),
    })

  it('ranks a stub below a finished file', async () => {
    const stub = await fileJudge({ completeness: 0 }, { leftoverScaffolding: 0 }).score({
      artifact: file,
      scenario,
      signal: signal(),
    })
    const done = await fileJudge({ completeness: 3 }, { leftoverScaffolding: 0 }).score({
      artifact: file,
      scenario,
      signal: signal(),
    })
    expect(stub.dimensions.completeness).toBe(0)
    expect(done.dimensions.completeness).toBe(1)
  })

  it('shows the file and its expectation, so the judgement is against a contract', async () => {
    let seen: JevRequest | undefined
    await fileJudge({ completeness: 2 }, { leftoverScaffolding: 0 }, (request) => {
      seen = request
    }).score({ artifact: file, scenario, signal: signal() })
    const state = seen?.state as Record<string, unknown>
    expect(state.path).toBe('src/ingest.py')
    expect(state.expectation).toBe('Accept rows and persist them.')
    expect(String(state.content)).toContain('NotImplementedError')
  })
})
