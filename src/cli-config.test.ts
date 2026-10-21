import { describe, expect, it } from 'vitest'
import { resolveCliLlmConfig } from './cli-config'



describe('resolveCliLlmConfig', () => {
  it('binds the resolved route into the transport the wire handlers take', () => {
    const config = resolveCliLlmConfig({
      AGENT_EVAL_LLM_API_KEY: 'explicit-key',
      AGENT_EVAL_LLM_BASE_URL: 'https://provider.example/v1',
      AGENT_EVAL_LLM_MODEL: 'explicit-model',
    })
    expect(config.model).toBe('explicit-model')
    expect(config.chat?.defaultModel).toBe('explicit-model')
  })

  it('returns no transport when no supported variables are set', () => {
    expect(resolveCliLlmConfig({})).toEqual({})
  })
})
