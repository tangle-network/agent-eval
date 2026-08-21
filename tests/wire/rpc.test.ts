/**
 * dispatchRpc — error envelope and method routing.
 *
 * No live LLM here — we test routing, validation, and error wrapping.
 * Live judge calls live in `judge-integration.test.ts` (skipped by
 * default, opt in via JUDGE_LIVE=1).
 */
import { describe, expect, it, vi } from 'vitest'

import { createChatClient } from '../../src/analyst/chat-client'
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

  it('refuses CLI judge calls before a model transport is configured', async () => {
    const out = await dispatchRpc({
      method: 'judge',
      params: { rubricName: 'anti-slop', content: 'hello' },
    })

    expect(out).toEqual({
      error: {
        code: 'llm_not_configured',
        message:
          'No model transport is configured. Pass a ChatClient, or configure the CLI provider environment variables.',
      },
    })
  })

  it("forwards the caller's ChatClient and the default model to judge calls", async () => {
    const chat = vi.fn(async (req: { model?: string }) => {
      expect(req.model).toBe('configured-model')
      return {
        content: JSON.stringify({
          dimensions: { quality: 0.75 },
          failureModes: [],
          wins: [],
          rationale: 'Clear.',
        }),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, captured: true },
        costUsd: null,
        model: 'configured-model',
        servedModel: 'configured-model',
        durationMs: 1,
        raw: {},
      }
    })

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
        chat: createChatClient({ transport: 'custom', maximumAttempts: 1, chat }),
        judgeModel: 'configured-model',
      },
    )

    expect(chat).toHaveBeenCalledOnce()
    expect(out).toMatchObject({
      result: { composite: 0.75, model: 'configured-model' },
    })
  })
})
