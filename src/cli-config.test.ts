import { describe, expect, it } from 'vitest'
import { resolveCliLlmConfig } from './cli-config'

describe('resolveCliLlmConfig', () => {
  it('maps standard OpenAI variables to an explicit provider config', () => {
    expect(
      resolveCliLlmConfig({
        OPENAI_API_KEY: '  openai-key  ',
        OPENAI_MODEL: 'gpt-test',
      }),
    ).toEqual({
      client: { apiKey: 'openai-key', baseUrl: 'https://api.openai.com/v1' },
      model: 'gpt-test',
    })
  })

  it('prefers agent-eval variables over provider-specific fallbacks', () => {
    expect(
      resolveCliLlmConfig({
        AGENT_EVAL_LLM_API_KEY: 'explicit-key',
        AGENT_EVAL_LLM_BASE_URL: 'https://provider.example/v1',
        AGENT_EVAL_LLM_MODEL: 'explicit-model',
        OPENAI_API_KEY: 'fallback-key',
        OPENAI_MODEL: 'fallback-model',
      }),
    ).toEqual({
      client: { apiKey: 'explicit-key', baseUrl: 'https://provider.example/v1' },
      model: 'explicit-model',
    })
  })

  it('returns no provider config when no supported variables are set', () => {
    expect(resolveCliLlmConfig({})).toEqual({})
  })
})
