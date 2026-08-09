import { describe, expect, it } from 'vitest'
import {
  assertCrossFamilyServed,
  assertServedModel,
  assertServedModels,
  checkServedModel,
  ModelSubstitutionError,
  normalizeModelId,
  ServedCrossFamilyError,
} from './served-model'

// Requested → served pairs observed on a live router probe. They are the
// reason this module exists: every one of them returned HTTP 200, so a
// reachability check passes while the answering model is not the requested one.
const OBSERVED = {
  substitutedCrossFamily: [
    ['gpt-4.1-mini', 'gemini-2.5-flash-lite'],
    ['openai/gpt-4.1-mini', 'gemini-2.5-flash-lite'],
    ['openai/gpt-5-mini', 'gemini-2.5-flash'],
    ['openai/gpt-5.5', 'gemini-2.5-flash'],
    ['openai/gpt-4o-mini', 'gemini-2.5-flash-lite'],
    ['gpt-4o-mini', 'gemini-2.5-flash-lite'],
  ],
  faithful: [
    ['zai/glm-5.2', 'glm-5.2'],
    ['deepseek/deepseek-v4-pro', 'deepseek-v4-pro'],
    ['anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6'],
    ['google/gemini-3.6-flash', 'gemini-3.6-flash'],
  ],
  substitutedWithinFamily: [['deepseek/deepseek-v3.2', 'deepseek-v4-flash']],
} as const

describe('normalizeModelId', () => {
  it('strips provider prefix, snapshot, and tier suffix', () => {
    expect(normalizeModelId('openai/gpt-4.1-mini')).toBe('gpt-4-1-mini')
    expect(normalizeModelId('anthropic/claude-opus-4-8:batch')).toBe('claude-opus-4-8')
    expect(normalizeModelId('  GPT-4.1-Mini@2025-04-14 ')).toBe('gpt-4-1-mini')
  })

  it('keeps version digits — they distinguish real models', () => {
    expect(normalizeModelId('deepseek/deepseek-v3.2')).not.toBe(
      normalizeModelId('deepseek/deepseek-v4-flash'),
    )
  })

  it('drops a trailing build date so a pinned snapshot matches its alias', () => {
    expect(normalizeModelId('gpt-4o-mini-2024-07-18')).toBe(normalizeModelId('gpt-4o-mini'))
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe(normalizeModelId('claude-haiku-4-5'))
  })
})

// Independently measured on the same router (supervisor-lab
// bench/profile-arena-host.ts, 2026-07-27). Different ids, same defect — which
// is why the rule is structural rather than a table of known-bad pairs.
describe('previously measured substitutions', () => {
  it('accepts snapshot resolution and rejects the cross-vendor swaps', () => {
    expect(checkServedModel('openai/gpt-4o-mini', 'gpt-4o-mini-2024-07-18').verdict).toBe('alias')
    expect(
      checkServedModel('anthropic/claude-haiku-4-5-20251001', 'gemini-2.5-flash-lite').verdict,
    ).toBe('substituted-cross-family')
    expect(checkServedModel('deepseek/deepseek-chat', 'gpt-5-mini-2025-08-07').verdict).toBe(
      'substituted-cross-family',
    )
  })

  // A prefix test would call this the same model; it is a silent downgrade to a
  // smaller model wearing the right vendor name.
  it('rejects a same-vendor downgrade that shares a prefix', () => {
    const check = checkServedModel('gpt-5', 'gpt-5-mini-2025-08-07')
    expect(check.verdict).toBe('substituted-within-family')
    expect(check.substituted).toBe(true)
  })
})

describe('checkServedModel', () => {
  it('classifies the observed cross-family substitutions', () => {
    for (const [requested, served] of OBSERVED.substitutedCrossFamily) {
      const check = checkServedModel(requested, served)
      expect(check.verdict, `${requested} → ${served}`).toBe('substituted-cross-family')
      expect(check.substituted).toBe(true)
      expect(check.requestedFamily).toBe('openai')
      expect(check.servedFamily).toBe('google')
    }
  })

  it('accepts the observed faithful pairs as exact or alias', () => {
    for (const [requested, served] of OBSERVED.faithful) {
      const check = checkServedModel(requested, served)
      expect(['exact', 'alias'], `${requested} → ${served}`).toContain(check.verdict)
      expect(check.substituted).toBe(false)
    }
  })

  it('separates a same-family swap from a cross-family one', () => {
    const [requested, served] = OBSERVED.substitutedWithinFamily[0]
    const check = checkServedModel(requested, served)
    expect(check.verdict).toBe('substituted-within-family')
    expect(check.requestedFamily).toBe('deepseek')
    expect(check.servedFamily).toBe('deepseek')
  })

  it('treats a missing echoed id as unproven, not as a pass', () => {
    const check = checkServedModel('gpt-4.1-mini', null)
    expect(check.verdict).toBe('unreported')
    expect(check.substituted).toBe(true)
    expect(check.servedFamily).toBeNull()
  })

  it('treats a blank echoed id the same as a missing one', () => {
    expect(checkServedModel('gpt-4.1-mini', '   ').verdict).toBe('unreported')
  })
})

describe('assertServedModel', () => {
  it('throws on the substitution the router actually performs', () => {
    expect(() => assertServedModel('gpt-4.1-mini', 'gemini-2.5-flash-lite')).toThrow(
      ModelSubstitutionError,
    )
  })

  it('names both ids and both families in the message', () => {
    try {
      assertServedModel('openai/gpt-5-mini', 'gemini-2.5-flash', { context: 'judge#1' })
      expect.unreachable('expected a substitution error')
    } catch (err) {
      const error = err as ModelSubstitutionError
      expect(error).toBeInstanceOf(ModelSubstitutionError)
      expect(error.code).toBe('model_substitution')
      expect(error.message).toContain('judge#1')
      expect(error.message).toContain('openai/gpt-5-mini')
      expect(error.message).toContain('gemini-2.5-flash')
      expect(error.checks[0]?.verdict).toBe('substituted-cross-family')
    }
  })

  it('passes an alias and returns the check', () => {
    const check = assertServedModel('zai/glm-5.2', 'glm-5.2')
    expect(check.verdict).toBe('alias')
    expect(check.served).toBe('glm-5.2')
  })

  it('rejects an unreported id by default and accepts it only when opted in', () => {
    expect(() => assertServedModel('glm-5.2', null)).toThrow(ModelSubstitutionError)
    expect(assertServedModel('glm-5.2', null, { allowUnreported: true }).verdict).toBe('unreported')
  })

  it('rejects a within-family swap by default and accepts it only when opted in', () => {
    expect(() => assertServedModel('deepseek/deepseek-v3.2', 'deepseek-v4-flash')).toThrow(
      ModelSubstitutionError,
    )
    expect(
      assertServedModel('deepseek/deepseek-v3.2', 'deepseek-v4-flash', { allowWithinFamily: true })
        .verdict,
    ).toBe('substituted-within-family')
  })

  it('does not let allowWithinFamily admit a cross-family substitution', () => {
    expect(() =>
      assertServedModel('gpt-4.1-mini', 'gemini-2.5-flash-lite', { allowWithinFamily: true }),
    ).toThrow(ModelSubstitutionError)
  })
})

describe('assertServedModels', () => {
  it('names every substitution, not just the first', () => {
    const pairs = OBSERVED.substitutedCrossFamily.map(([requested, served]) => ({
      requested,
      served,
    }))
    try {
      assertServedModels(pairs)
      expect.unreachable('expected a substitution error')
    } catch (err) {
      const error = err as ModelSubstitutionError
      expect(error.message).toContain(`${pairs.length}/${pairs.length}`)
      for (const { requested } of pairs) expect(error.message).toContain(requested)
    }
  })

  it('passes when every pair is faithful', () => {
    const checks = assertServedModels(
      OBSERVED.faithful.map(([requested, served]) => ({ requested, served })),
    )
    expect(checks).toHaveLength(OBSERVED.faithful.length)
    expect(checks.every((c) => !c.substituted)).toBe(true)
  })
})

describe('assertCrossFamilyServed', () => {
  it('fails a panel whose requested ids look diverse but collapsed to one provider', () => {
    // The exact failure the requested-id check cannot see: three ids, three
    // apparent families, one answering provider.
    const pairs = [
      { requested: 'gpt-4.1-mini', served: 'gemini-2.5-flash-lite' },
      { requested: 'openai/gpt-5-mini', served: 'gemini-2.5-flash' },
      { requested: 'google/gemini-3.6-flash', served: 'gemini-3.6-flash' },
    ]
    expect(() => assertCrossFamilyServed(pairs, { allowWithinFamily: true })).toThrow(
      ModelSubstitutionError,
    )
  })

  it('reports the served families when substitution is tolerated but diversity is not', () => {
    const pairs = [
      { requested: 'gemini-2.5-flash-lite', served: 'gemini-2.5-flash-lite' },
      { requested: 'google/gemini-3.6-flash', served: 'gemini-3.6-flash' },
    ]
    try {
      assertCrossFamilyServed(pairs)
      expect.unreachable('expected a served-family error')
    } catch (err) {
      const error = err as ServedCrossFamilyError
      expect(error).toBeInstanceOf(ServedCrossFamilyError)
      expect(error.families).toEqual(['google'])
      expect(error.message).toContain('gemini-3.6-flash')
    }
  })

  it('passes a panel that is genuinely cross-family as served', () => {
    const families = assertCrossFamilyServed([
      { requested: 'deepseek-v4-pro', served: 'deepseek-v4-pro' },
      { requested: 'zai/glm-5.2', served: 'glm-5.2' },
      { requested: 'google/gemini-2.5-flash', served: 'gemini-2.5-flash' },
    ])
    expect(families).toEqual(['deepseek', 'google', 'zhipu'])
  })
})
