import { describe, expect, it } from 'vitest'
import { CostLedger } from '../src/cost-ledger'
import { jevEvaluator } from '../src/jev'
import { type JevRequest, parseJevResult } from '../src/jev-protocol'

const request: JevRequest = { model: 'fixture', state: null, questions: { q: { type: 'noul' } } }
const response = () => ({
  model: 'fixture',
  answers: { q: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 2, output_tokens: 1 },
})

describe('native observations retain extension evidence faithfully', () => {
  it('retains extensions and caller keys without changing native order or identity', () => {
    const raw = {
      ...response(),
      metadata: JSON.parse('{"z":true,"__proto__":{"observed":true},"a":[null,1]}'),
    }
    expect(parseJevResult(raw, request)).toBe(raw)
    expect(JSON.parse(JSON.stringify(parseJevResult(raw, request)))).toEqual(raw)
    expect(Object.keys(raw.metadata)).toEqual(['z', '__proto__', 'a'])
    expect(Object.prototype).not.toHaveProperty('observed')
  })
  it.each([Infinity, Number.NaN, new Map([['evidence', 1]]), new Date(), undefined])(
    'rejects lossy extension evidence %s',
    (extra) => {
      expect(() => parseJevResult({ ...response(), extra }, request)).toThrow()
    },
  )
  it('does not erase a known paid receipt when extension validation fails', async () => {
    const ledger = new CostLedger()
    const evaluate = jevEvaluator({
      evaluate: async () => ({ ...response(), extra: Infinity }),
      receipt: () => ({ model: 'fixture', inputTokens: 2, outputTokens: 1, actualCostUsd: 0.01 }),
    })
    await expect(evaluate(request, { costLedger: ledger })).rejects.toThrow()
    expect(ledger.summary()).toMatchObject({ totalCalls: 1, totalCostUsd: 0.01 })
  })
})
