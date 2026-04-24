import { describe, it, expect } from 'vitest'
import { CostTracker } from '../src/cost-tracker'

describe('CostTracker.recordVerdict', () => {
  it('records + markOutcome in one call from verdict.usage + verdict.verdict', () => {
    const t = new CostTracker()
    const entry = t.recordVerdict(
      {
        usage: { inputTokens: 1000, outputTokens: 500, model: 'gpt-4o-mini' },
        verdict: 'pass',
      },
      'scn-1',
      { phase: 'meta-judge' },
    )
    expect(entry).not.toBeNull()
    expect(entry!.scenarioId).toBe('scn-1')
    expect(entry!.inputTokens).toBe(1000)
    expect(entry!.tags?.phase).toBe('meta-judge')

    const s = t.summary()
    expect(s.scenarioCount).toBe(1)
    expect(s.completedCount).toBe(1) // verdict === 'pass' → markOutcome(true)
  })

  it('returns null + no-ops when verdict has no usage (e.g. compile-gate short-circuit)', () => {
    const t = new CostTracker()
    const entry = t.recordVerdict({ verdict: 'fail' }, 'scn-no-usage')
    expect(entry).toBeNull()
    expect(t.summary().scenarioCount).toBe(0)
  })

  it('verdict !== "pass" → markOutcome(false)', () => {
    const t = new CostTracker()
    t.recordVerdict(
      { usage: { inputTokens: 100, outputTokens: 50, model: 'gpt-4o-mini' }, verdict: 'borderline' },
      'scn-border',
    )
    expect(t.summary().completedCount).toBe(0)
  })

  it('propagates cachedTokens + reasoningTokens to the underlying record', () => {
    const t = new CostTracker()
    t.recordVerdict(
      {
        usage: {
          inputTokens: 500,
          outputTokens: 200,
          cachedTokens: 100,
          reasoningTokens: 50,
          model: 'claude-sonnet-4-20250514',
        },
        verdict: 'pass',
      },
      'scn-cache',
    )
    const bucket = t.get('scn-cache')
    expect(bucket!.totalCachedTokens).toBe(100)
  })
})
