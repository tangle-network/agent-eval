import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  normalizeSystemOneResult,
  parseSystemOneRequest,
  parseSystemOneResult,
  type SystemOneRequest,
  type SystemOneResultProfile,
  systemOneConfidence,
} from '../src/systemone-protocol'

// One live call per provider model with the same request, recorded 2026-10-04 (see the file's note).
interface Call {
  provider: string
  request: SystemOneRequest
  response: Record<string, any>
}
const recording: { calls: Call[] } = JSON.parse(
  readFileSync(new URL('./fixtures/systemone/providers-2026-10-04.json', import.meta.url), 'utf8'),
)
const call = (model: string) => {
  const found = recording.calls.find((item) => item.request.model === model)
  if (!found) throw new Error(`No recorded call for ${model}`)
  return structuredClone(found)
}

// The route owner supplies these. The values are what the recording shows.
const typesafe: SystemOneResultProfile = { decimals: 2, confidence: 'canonical' }
const cloudflare: SystemOneResultProfile = { decimals: 4, confidence: 'provider-defined' }

/** Workers AI wraps results in its v4 envelope; unwrapping belongs to the route, not the protocol. */
function unwrap(body: Record<string, any>) {
  expect(body).toMatchObject({ success: true, errors: [], messages: [] })
  return body.result as Record<string, any>
}

const distributionAnswers = ['quality', 'fixed.file', 'risk', 'rubric4']

describe('recorded TypeSafe response', () => {
  it('fails the strict score check only by rounding, and normalization repairs just those scores', () => {
    const { request, response } = call('jev-1.13.0')
    parseSystemOneRequest(request)
    expect(response.model).toBe('jev-1.13.0')
    // Probabilities sum to 1 at 2 decimals, but the score is not their expectation.
    expect(() => parseSystemOneResult(response, request)).toThrow(
      'Score differs from its distribution',
    )

    const normalized = normalizeSystemOneResult(response, request, typesafe) as Record<string, any>
    expect(parseSystemOneResult(normalized, request)).toBe(normalized)
    for (const name of ['delivered', 'fixed.file', 'risk']) {
      expect(normalized.answers[name]).toBe(response.answers[name])
    }
    expect(response.answers.quality.score).toBe(8.79)
    expect(normalized.answers.quality.score).toBeCloseTo(8.86, 12)
    expect(response.answers.rubric4.score).toBe(2.98)
    expect(normalized.answers.rubric4.score).toBeCloseTo(2.99, 12)
    for (const name of ['quality', 'rubric4']) {
      const { score: _after, ...after } = normalized.answers[name]
      const { score: _before, ...before } = response.answers[name]
      expect(after).toEqual(before)
    }
    expect(normalizeSystemOneResult(normalized, request, typesafe)).toBe(normalized)
  })
})

describe.each([
  ['clef', true],
  ['clef-flash', false],
])('recorded Cloudflare %s response', (model, strictRejects) => {
  it('normalizes 4-decimal rounding and reports the one confidence definition', () => {
    const { request, response } = call(model)
    const body = unwrap(response)
    expect(body.model).toBe(model)
    expect(body.usage).toEqual({ input_tokens: 2037, output_tokens: 0 })
    if (strictRejects) expect(() => parseSystemOneResult(body, request)).toThrow()
    else parseSystemOneResult(body, request)

    const normalized = normalizeSystemOneResult(body, request, cloudflare) as Record<string, any>
    expect(parseSystemOneResult(normalized, request)).toBe(normalized)
    expect(normalized.answers.delivered).toBe(body.answers.delivered)
    for (const name of distributionAnswers) {
      const before = body.answers[name]
      const after = normalized.answers[name]
      expect(after.choice).toBe(before.choice)
      expect(after.provider_confidence).toBe(before.confidence)
      // Cloudflare's own value is the normalized concentration (Σp² − 1/n)/(1 − 1/n).
      const p = Object.values(before.probabilities as Record<string, number>)
      const n = p.length
      const concentration =
        (p.reduce((total, value) => total + value * value, 0) - 1 / n) / (1 - 1 / n)
      expect(Math.abs(before.confidence - concentration)).toBeLessThanOrEqual(0.0002)
    }
    expect(normalizeSystemOneResult(normalized, request, cloudflare)).toBe(normalized)
  })
})

describe('the shared confidence definition on recorded distributions', () => {
  it('gives the same answer a hand calculation does', () => {
    const { request, response } = call('clef')
    const normalized = normalizeSystemOneResult(unwrap(response), request, cloudflare) as Record<
      string,
      any
    >
    // risk: (0.5143 − 1/3)/(1 − 1/3); Cloudflare reported 0.091.
    expect(normalized.answers.risk.confidence).toBeCloseTo((0.5143 - 1 / 3) / (2 / 3), 12)
    expect(normalized.answers.risk.provider_confidence).toBe(0.091)
    // rubric4: mode 3, Σp·|i − 3| = 0.0126·3 + 0.0524·2 + 0.1412 = 0.2838, MAD of uniform = 1.
    expect(normalized.answers.rubric4.confidence).toBeCloseTo(1 - 0.2838, 4)
    // TypeSafe's recorded 50-option answer puts all mass on one option.
    expect(systemOneConfidence(call('jev-1.13.0').response.answers['fixed.file'])).toBe(1)
  })
})

describe('error beyond the declared rounding', () => {
  it('is a provider defect, not something normalization absorbs', () => {
    const { request, response } = call('clef-flash')
    const body = unwrap(response)
    body.answers.risk.probabilities.none += 0.01
    expect(() => normalizeSystemOneResult(body, request, cloudflare)).toThrow(
      'Distribution error exceeds declared rounding',
    )
    // The same error fits a 2-decimal provider's rounding.
    const coarse = normalizeSystemOneResult(body, request, { ...cloudflare, decimals: 2 })
    expect(parseSystemOneResult(coarse, request)).toBe(coarse)
    // A provider declared exact gets no repair; the strict parser names the defect.
    const exact = normalizeSystemOneResult(body, request, { confidence: 'canonical' })
    expect(exact).toBe(body)
    expect(() => parseSystemOneResult(exact, request)).toThrow('Invalid probability distribution')

    const clef = call('clef')
    const scored = unwrap(clef.response)
    scored.answers.quality.score += 0.01
    expect(() => normalizeSystemOneResult(scored, clef.request, cloudflare)).toThrow(
      'Score error exceeds declared rounding',
    )
  })
})
