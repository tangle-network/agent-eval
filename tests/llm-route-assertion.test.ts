import { describe, it, expect } from 'vitest'
import { assertLlmRoute, LlmRouteAssertionError } from '../src/llm-client'

describe('assertLlmRoute', () => {
  it('throws when requireExplicitBaseUrl is set and baseUrl is undefined', () => {
    expect(() => assertLlmRoute({ apiKey: 'k' }, { requireExplicitBaseUrl: true })).toThrow(
      LlmRouteAssertionError,
    )
  })

  it('passes when baseUrl is explicit', () => {
    expect(() => assertLlmRoute(
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'k' },
      { requireExplicitBaseUrl: true },
    )).not.toThrow()
  })

  it('rejects URLs in the blocklist regardless of allowlist', () => {
    expect(() => assertLlmRoute(
      { baseUrl: 'https://router.tangle.tools/v1', apiKey: 'k' },
      {
        allowedBaseUrls: [/.*/],
        blockedBaseUrls: ['https://router.tangle.tools'],
      },
    )).toThrow(/blocked pattern/i)
  })

  it('requires a baseUrl in the allowlist', () => {
    expect(() => assertLlmRoute(
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'k' },
      { allowedBaseUrls: ['https://router.tangle.tools'] },
    )).toThrow(/not in the allowed list/)
    expect(() => assertLlmRoute(
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'k' },
      { allowedBaseUrls: [/api\.openai\.com/] },
    )).not.toThrow()
  })

  it('requires auth when requireAuth is set', () => {
    expect(() => assertLlmRoute({ baseUrl: 'https://x' }, { requireAuth: true })).toThrow(
      /no apiKey, bearer, or authHeader/,
    )
    expect(() => assertLlmRoute({ baseUrl: 'https://x', bearer: 'b' }, { requireAuth: true })).not.toThrow()
  })

  it('checks expectedProvider against the resolved baseUrl', () => {
    expect(() => assertLlmRoute(
      { baseUrl: 'https://api.openai.com/v1' },
      { expectedProvider: 'anthropic' },
    )).toThrow(/expected provider anthropic/)
    expect(() => assertLlmRoute(
      { baseUrl: 'https://api.openai.com/v1' },
      { expectedProvider: 'openai' },
    )).not.toThrow()
  })

  it('exposes a structured error code for programmatic handling', () => {
    try {
      assertLlmRoute({}, { requireExplicitBaseUrl: true })
    } catch (err) {
      expect(err).toBeInstanceOf(LlmRouteAssertionError)
      expect((err as LlmRouteAssertionError).code).toBe('no_explicit_base_url')
    }
  })
})
