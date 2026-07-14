import { describe, expect, it } from 'vitest'
import {
  firstNumberAttr,
  LLM_CACHE_WRITE_TOKEN_ATTR_KEYS,
  LLM_CACHED_TOKEN_ATTR_KEYS,
  LLM_COST_ATTR_KEYS,
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
  LLM_REASONING_TOKEN_ATTR_KEYS,
} from './attribute-vocabulary'

describe('lightweight trace attribute readers', () => {
  it('reads standard GenAI usage aliases and numeric strings', () => {
    const attributes = {
      'gen_ai.usage.input_tokens': '10',
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.reasoning_tokens': 3,
      'gen_ai.usage.cache_read_input_tokens': 40,
      'gen_ai.usage.cache_creation_input_tokens': 5,
      'gen_ai.usage.cost': '0.125',
    }

    expect(firstNumberAttr(attributes, LLM_INPUT_TOKEN_ATTR_KEYS)).toBe(10)
    expect(firstNumberAttr(attributes, LLM_OUTPUT_TOKEN_ATTR_KEYS)).toBe(20)
    expect(firstNumberAttr(attributes, LLM_REASONING_TOKEN_ATTR_KEYS)).toBe(3)
    expect(firstNumberAttr(attributes, LLM_CACHED_TOKEN_ATTR_KEYS)).toBe(40)
    expect(firstNumberAttr(attributes, LLM_CACHE_WRITE_TOKEN_ATTR_KEYS)).toBe(5)
    expect(firstNumberAttr(attributes, LLM_COST_ATTR_KEYS)).toBe(0.125)
  })
})
