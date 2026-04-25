/**
 * dispatchRpc — error envelope and method routing.
 *
 * No live LLM here — we test routing, validation, and error wrapping.
 * Live judge calls live in `judge-integration.test.ts` (skipped by
 * default, opt in via JUDGE_LIVE=1).
 */
import { describe, expect, it } from 'vitest'

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
})
