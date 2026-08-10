import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ConfigError, ValidationError } from './errors'
import { assertCrossFamilyServed, normalizeModelId } from './integrity/served-model'
import { assertCrossFamily } from './judge-families'
import { isModelPriced } from './metrics'
import { type ModelSeats, resolveSeat, SeatUnsetError, seatPresets } from './model-seats'

const seats: ModelSeats = {
  worker: 'kimi-k2.6',
  judges: ['kimi-k2.6', 'deepseek-v4-pro'],
}

describe('resolveSeat', () => {
  it('returns a set single-model seat', () => {
    expect(resolveSeat(seats, 'worker')).toBe('kimi-k2.6')
  })

  it('returns a copy of the judges list — mutating it never edits the chart', () => {
    const judges = resolveSeat(seats, 'judges')
    expect(judges).toEqual(['kimi-k2.6', 'deepseek-v4-pro'])
    judges.push('extra')
    expect(seats.judges).toEqual(['kimi-k2.6', 'deepseek-v4-pro'])
  })

  it('throws SeatUnsetError (code config, names the seat) when unset with no fallback', () => {
    expect(() => resolveSeat(seats, 'analyst')).toThrow(SeatUnsetError)
    try {
      resolveSeat(seats, 'analyst')
      expect.unreachable('resolveSeat must throw')
    } catch (err) {
      expect(err).toBeInstanceOf(SeatUnsetError)
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as SeatUnsetError).seat).toBe('analyst')
      expect((err as SeatUnsetError).code).toBe('config')
      expect((err as SeatUnsetError).message).toContain("'analyst'")
    }
  })

  it('returns the explicit fallback when the seat is unset', () => {
    expect(resolveSeat(seats, 'reflection', 'gpt-4.1-mini')).toBe('gpt-4.1-mini')
  })

  it('wraps a fallback for the judges seat into a one-model panel', () => {
    expect(resolveSeat({}, 'judges', 'deepseek-v4-pro')).toEqual(['deepseek-v4-pro'])
  })

  it('treats a blank string and an empty judges array as unset', () => {
    expect(() => resolveSeat({ worker: '  ' }, 'worker')).toThrow(SeatUnsetError)
    expect(() => resolveSeat({ judges: [] }, 'judges')).toThrow(SeatUnsetError)
    expect(resolveSeat({ worker: '' }, 'worker', 'kimi-k2.6')).toBe('kimi-k2.6')
  })

  it('fails loud on malformed seats — blank judge entry, wrong runtime types', () => {
    expect(() => resolveSeat({ judges: ['kimi-k2.6', ' '] }, 'judges')).toThrow(ValidationError)
    expect(() => resolveSeat({ judges: 'kimi-k2.6' as unknown as string[] }, 'judges')).toThrow(
      ValidationError,
    )
    expect(() => resolveSeat({ worker: ['kimi-k2.6'] as unknown as string }, 'worker')).toThrow(
      ValidationError,
    )
  })

  it('rejects a blank fallback — it cannot stand in for a model id', () => {
    expect(() => resolveSeat({}, 'worker', '')).toThrow(ValidationError)
  })
})

describe('seatPresets', () => {
  it('economy fills every seat with the fleet-policy ids', () => {
    const economy = seatPresets.economy
    expect(economy.worker).toBe('zai/glm-5.2')
    expect(economy.judges).toEqual(['deepseek-v4-pro', 'zai/glm-5.2', 'google/gemini-2.5-flash'])
    expect(economy.analyst).toBe('zai/glm-5.2')
    expect(economy.reflection).toBe('zai/glm-5.2')
    expect(economy.verifier).toBe('deepseek-v4-pro')
  })

  // The preset's family claim has to survive the check that reads served ids,
  // not just the one that reads requested ids: an id whose name implies one
  // provider and whose answer comes from another would satisfy the latter and
  // silently collapse the panel.
  it('economy judges stay cross-family when each id is served by its own name', () => {
    const models = resolveSeat(seatPresets.economy, 'judges')
    const families = assertCrossFamilyServed(
      models.map((model) => ({ requested: model, served: model })),
      { minFamilies: 3 },
    )
    expect(families).toEqual(['deepseek', 'google', 'zhipu'])
  })

  it('economy judges pass assertCrossFamily as-is', () => {
    const families = assertCrossFamily(resolveSeat(seatPresets.economy, 'judges'))
    expect(families.length).toBeGreaterThanOrEqual(3)
  })

  it('every economy id is priced — the preset never produces a costUnknown axis', () => {
    const economy = seatPresets.economy
    const ids = [
      economy.worker,
      economy.analyst,
      economy.reflection,
      economy.verifier,
      ...(economy.judges ?? []),
    ]
    for (const id of ids) {
      expect(id).toBeDefined()
      expect(isModelPriced(id as string)).toBe(true)
    }
  })

  /**
   * Ids this router was measured answering from a different model, or not
   * answering at all. A preset that names one produces numbers about a model
   * nobody asked for, or a run that dies on the first call.
   */
  const NOT_USABLE = [
    'gpt-4.1-mini',
    'openai/gpt-4.1-mini',
    'gpt-4o-mini',
    'openai/gpt-4o-mini',
    'openai/gpt-5-mini',
    'openai/gpt-5.5',
    'gpt-4o',
    'openai/gpt-4o',
    'openai/gpt-5.4',
    'kimi-k2.6',
    'moonshotai/kimi-k2.6',
  ]

  it('names no id measured dead or silently substituted on the router', () => {
    const unusable = new Set(NOT_USABLE.map(normalizeModelId))
    const economy = seatPresets.economy
    const ids = [
      economy.worker,
      economy.analyst,
      economy.reflection,
      economy.verifier,
      ...(economy.judges ?? []),
    ]
    for (const id of ids) {
      expect(unusable.has(normalizeModelId(id as string))).toBe(false)
    }
  })

  // The presets are the first thing a caller copies, so the caveat has to
  // travel with them rather than living only in the guard's own module.
  it('documents that a requested id is not a family guarantee', () => {
    const source = readFileSync(new URL('./model-seats.ts', import.meta.url), 'utf8')
    const doc = source
      .slice(0, source.indexOf('export const seatPresets'))
      .replace(/^\s*\*/gm, ' ')
      .replace(/\s+/g, ' ')
    expect(doc).toContain('a requested id is NOT a guarantee of family')
    expect(doc).toContain('assertModelsServed')
    expect(doc).toContain('assertCrossFamilyServed')
  })

  it('frontier is deliberately empty — every seat fails loud until the caller supplies entitled ids', () => {
    const seatNames = ['worker', 'judges', 'analyst', 'reflection', 'verifier'] as const
    for (const seat of seatNames) {
      expect(() => resolveSeat(seatPresets.frontier, seat)).toThrow(SeatUnsetError)
    }
    const filled = { ...seatPresets.frontier, worker: 'my-frontier-id' }
    expect(resolveSeat(filled, 'worker')).toBe('my-frontier-id')
  })
})
