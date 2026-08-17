/**
 * The deprecated product-coupled surface (`ProductClient`) must warn LOUDLY —
 * but exactly once per process per surface, so a matrix run that constructs
 * one per cell is not flooded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductClient } from './client'
import { resetDeprecationWarnings, warnDeprecatedOnce } from './deprecation'

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
})
