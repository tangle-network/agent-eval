/**
 * The deprecated product-coupled surfaces (`ProductClient`,
 * `decideNextUserTurn`, `buildDriverSystemPrompt`) must warn LOUDLY — but
 * exactly once per process per surface, so a matrix run that constructs one
 * per cell is not flooded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductClient } from './client'
import { resetDeprecationWarnings, warnDeprecatedOnce } from './deprecation'
import { buildDriverSystemPrompt } from './driver'
import type { DriverState, PersonaConfig } from './types'

const STATE: DriverState = {
  tasks: 0,
  events: 0,
  proposals: { pending: 0, approved: 0, rejected: 0 },
  vaultFiles: [],
  codeBlocks: 0,
  generations: 0,
}

const PERSONA: PersonaConfig = {
  id: 'p1',
  role: 'reviewer',
  goal: 'review',
  completionCriteria: [],
  maxTurns: 1,
}

describe('warnDeprecatedOnce', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetDeprecationWarnings()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('warns once per key, tagged as an agent-eval deprecation', () => {
    warnDeprecatedOnce('k1', 'k1 is deprecated')
    warnDeprecatedOnce('k1', 'k1 is deprecated')
    warnDeprecatedOnce('k2', 'k2 is deprecated')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]![0]).toContain('[agent-eval deprecation]')
  })

  it('ProductClient warns once across repeated constructions', () => {
    new ProductClient({ baseUrl: 'http://localhost:1', routes: {} })
    new ProductClient({ baseUrl: 'http://localhost:2', routes: {} })
    const calls = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('ProductClient'))
    expect(calls).toHaveLength(1)
    expect(String(calls[0]![0])).toContain('#694')
  })

  it('buildDriverSystemPrompt warns once and still returns the full prompt', () => {
    const first = buildDriverSystemPrompt(PERSONA, STATE)
    const second = buildDriverSystemPrompt(PERSONA, STATE)
    expect(first).toBe(second)
    expect(first).toContain('reviewer')
    const calls = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('buildDriverSystemPrompt'),
    )
    expect(calls).toHaveLength(1)
  })
})
