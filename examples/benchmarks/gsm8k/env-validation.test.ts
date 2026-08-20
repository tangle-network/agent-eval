import { describe, expect, it } from 'vitest'
import { missingGsm8kEnv } from './env-validation'

describe('missingGsm8kEnv', () => {
  it('reports every missing requirement in one pass', () => {
    const missing = missingGsm8kEnv({})
    expect(missing).toHaveLength(5)
    expect(missing[0]).toContain('AGENT_EVAL_GSM8K_PATH')
    expect(missing[1]).toContain('LLM_API_KEY')
    expect(missing[2]).toContain('LLM_BASE_URL')
    expect(missing[3]).toContain('GEPA_PRICE_IN_PER_M')
    expect(missing[4]).toContain('SKILLOPT_PRICE_IN_PER_M')
  })

  it('accepts the documented verbatim command environment', () => {
    expect(
      missingGsm8kEnv({
        AGENT_EVAL_GSM8K_PATH: '/data/gsm8k.jsonl',
        LLM_BASE_URL: 'https://api.deepseek.com/v1',
        LLM_API_KEY: 'key',
        PRICE_IN_PER_M: '0.27',
        PRICE_OUT_PER_M: '1.1',
      }),
    ).toEqual([])
  })

  it('accepts per-optimizer rates in place of the shared rates', () => {
    expect(
      missingGsm8kEnv({
        AGENT_EVAL_GSM8K_PATH: '/data/gsm8k.jsonl',
        LLM_BASE_URL: 'https://api.deepseek.com/v1',
        LLM_API_KEY: 'key',
        GEPA_PRICE_IN_PER_M: '0.4',
        GEPA_PRICE_OUT_PER_M: '1.6',
        SKILLOPT_PRICE_IN_PER_M: '0.4',
        SKILLOPT_PRICE_OUT_PER_M: '1.6',
      }),
    ).toEqual([])
  })

  it('requires both halves of an optimizer rate pair', () => {
    const missing = missingGsm8kEnv({
      AGENT_EVAL_GSM8K_PATH: '/data/gsm8k.jsonl',
      LLM_BASE_URL: 'https://api.deepseek.com/v1',
      LLM_API_KEY: 'key',
      GEPA_PRICE_IN_PER_M: '0.4',
      SKILLOPT_PRICE_IN_PER_M: '0.4',
      SKILLOPT_PRICE_OUT_PER_M: '1.6',
    })
    expect(missing).toHaveLength(1)
    expect(missing[0]).toContain('GEPA_PRICE_OUT_PER_M')
  })

  it('lets an execution-owner module stand in for the endpoint variables', () => {
    expect(
      missingGsm8kEnv({
        AGENT_EVAL_GSM8K_PATH: '/data/gsm8k.jsonl',
        LLM_API_KEY: 'key',
        OPTIMIZER_EXECUTION_OWNER_MODULE: '@acme/runtime-optimizer-owner',
        PRICE_IN_PER_M: '0.27',
        PRICE_OUT_PER_M: '1.1',
      }),
    ).toEqual([])
  })

  it('accepts the TANGLE_* credential aliases', () => {
    expect(
      missingGsm8kEnv({
        AGENT_EVAL_GSM8K_PATH: '/data/gsm8k.jsonl',
        TANGLE_ROUTER_URL: 'https://router.tangle.tools/v1',
        TANGLE_API_KEY: 'key',
        PRICE_IN_PER_M: '0.27',
        PRICE_OUT_PER_M: '1.1',
      }),
    ).toEqual([])
  })
})
