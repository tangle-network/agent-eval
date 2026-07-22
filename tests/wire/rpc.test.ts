/**
 * dispatchRpc — error envelope and method routing.
 *
 * No live LLM here — we test routing, validation, and error wrapping.
 * Live judge calls live in `judge-integration.test.ts` (skipped by
 * default, opt in via JUDGE_LIVE=1).
 */
import { describe, expect, it, vi } from 'vitest'

import { dispatchRpc } from '../../src/wire/rpc'

describe('dispatchRpc', () => {
  it('routes listRubrics to a {result} envelope', async () => {
    const out = await dispatchRpc({ method: 'listRubrics' })
    expect(out).toHaveProperty('result')
    if ('result' in out) {
      expect(Array.isArray((out.result as { rubrics: unknown[] }).rubrics)).toBe(true)
    }
  })

  it('routes version to a {result} envelope', async () => {
    const out = await dispatchRpc({ method: 'version' })
    expect(out).toHaveProperty('result')
    if ('result' in out) {
      const r = out.result as { package: string }
      expect(r.package).toBe('@tangle-network/agent-eval')
    }
  })

  it('returns {error} for unknown method (regression: silent fail-through)', async () => {
    // @ts-expect-error testing runtime guard
    const out = await dispatchRpc({ method: 'bogus' })
    expect(out).toHaveProperty('error')
    if ('error' in out) {
      expect(out.error.code).toBe('unknown_method')
    }
  })

  it('returns {error} with code "validation_error" when judge params are malformed', async () => {
    const out = await dispatchRpc({ method: 'judge', params: { content: '' } })
    expect(out).toHaveProperty('error')
    if ('error' in out) {
      expect(out.error.code).toBe('validation_error')
    }
  })

  it('refuses CLI judge calls before a provider endpoint is configured', async () => {
    const out = await dispatchRpc(
      {
        method: 'judge',
        params: { rubricName: 'anti-slop', content: 'hello' },
      },
      { llmRouteRequirements: { requireExplicitBaseUrl: true } },
    )

    expect(out).toEqual({
      error: {
        code: 'llm_not_configured',
        message:
          'No model endpoint is configured. Pass llm.baseUrl or configure the CLI provider environment variables.',
        details: { reason: 'no_explicit_base_url' },
      },
    })
  })

  it('forwards provider config and the default model to judge calls', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { model: string }
      expect(request.model).toBe('configured-model')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer provider-key')
      return new Response(
        JSON.stringify({
          model: 'configured-model',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  dimensions: { quality: 0.75 },
                  failureModes: [],
                  wins: [],
                  rationale: 'Clear.',
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof globalThis.fetch

    const out = await dispatchRpc(
      {
        method: 'judge',
        params: {
          content: 'hello',
          rubric: {
            name: 'quality',
            description: 'Quality',
            systemPrompt: 'Score quality.',
            dimensions: [{ id: 'quality', description: 'Quality', weight: 1, min: 0, max: 1 }],
            failureModes: [],
            wins: [],
          },
        },
      },
      {
        llm: { baseUrl: 'https://provider.example/v1', apiKey: 'provider-key', fetch },
        judgeModel: 'configured-model',
        llmRouteRequirements: { requireExplicitBaseUrl: true },
      },
    )

    expect(fetch).toHaveBeenCalledOnce()
    expect(out).toMatchObject({
      result: { composite: 0.75, model: 'configured-model' },
    })
  })
})
