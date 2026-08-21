import { describe, expect, it } from 'vitest'
import { resolveCliLlmConfig, resolveCliProviderRoute } from './cli-config'

describe('resolveCliProviderRoute', () => {
  it('maps standard OpenAI variables to an explicit provider route', () => {
    expect(
      resolveCliProviderRoute({
        OPENAI_API_KEY: '  openai-key  ',
        OPENAI_MODEL: 'gpt-test',
      }),
    ).toEqual({
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
    })
  })

  it('prefers agent-eval variables over provider-specific fallbacks', () => {
    expect(
      resolveCliProviderRoute({
        AGENT_EVAL_LLM_API_KEY: 'explicit-key',
        AGENT_EVAL_LLM_BASE_URL: 'https://provider.example/v1',
        AGENT_EVAL_LLM_MODEL: 'explicit-model',
        OPENAI_API_KEY: 'fallback-key',
        OPENAI_MODEL: 'fallback-model',
      }),
    ).toEqual({
      apiKey: 'explicit-key',
      baseUrl: 'https://provider.example/v1',
      model: 'explicit-model',
    })
  })

  it('refuses a half-configured route rather than calling an unintended endpoint', () => {
    expect(
      resolveCliProviderRoute({ AGENT_EVAL_LLM_BASE_URL: 'https://provider.example/v1' }),
    ).toBeUndefined()
    expect(resolveCliProviderRoute({})).toBeUndefined()
  })
})

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
