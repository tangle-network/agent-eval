import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnalystAi, getConfiguredAnalystModel } from './ax-service'

const axMock = vi.hoisted(() => ({
  ai: vi.fn(() => ({ chat: vi.fn() })),
}))

vi.mock('@ax-llm/ax', () => ({ ai: axMock.ai }))

describe('createAnalystAi', () => {
  beforeEach(() => axMock.ai.mockClear())

  it('retains the configured model for pre-call spend estimation', () => {
    const service = createAnalystAi({
      apiKey: 'test',
      baseUrl: 'https://example.test/v1',
      model: 'gpt-4o-mini',
    })

    expect(getConfiguredAnalystModel(service)).toBe('gpt-4o-mini')
    expect(axMock.ai).toHaveBeenCalledWith({
      name: 'openai',
      apiKey: 'test',
      apiURL: 'https://example.test/v1',
      config: { model: 'gpt-4o-mini' },
    })
  })

  it('rejects a blank model before constructing a provider service', () => {
    expect(() =>
      createAnalystAi({
        apiKey: 'test',
        baseUrl: 'https://example.test/v1',
        model: '   ',
      }),
    ).toThrow(/model must be a non-empty string/)
    expect(axMock.ai).not.toHaveBeenCalled()
  })
})
