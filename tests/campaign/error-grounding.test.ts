import { describe, expect, it } from 'vitest'
import { campaignBreakdown } from '../../src/campaign/score-utils'
import type { CampaignCellResult, CampaignResult, Scenario } from '../../src/campaign/types'
import { buildReflectionPrompt } from '../../src/reflective-mutation'

// The conjunct-2 fix: a reflective proposer was proposing blind generic rewrites
// because it only saw per-scenario SCORES, never the judge's "why it failed".
// These guard the now-threaded path: judge.notes → campaignBreakdown.scenarios
// → the reflection prompt's failure evidence. Generalizable by contract; the
// held-out gate is the anti-overfit backstop.

function cell(scenarioId: string, composite: number, notes: string): CampaignCellResult<unknown> {
  return {
    cellId: `${scenarioId}:0`,
    scenarioId,
    rep: 0,
    artifact: { text: 'x' },
    judgeScores: { j: { composite, dimensions: { d: composite }, notes } },
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
    durationMs: 0,
    seed: 0,
    cached: false,
  }
}

describe('error-grounding — judge notes reach the reflective proposer', () => {
  it('campaignBreakdown surfaces the per-scenario judge notes (the "why")', () => {
    const campaign = {
      cells: [
        cell('weak-case', 0.5, 'missed lines: 16 (tax recompute), 25d (withholding sum)'),
        cell('strong-case', 1.0, 'all lines correct'),
      ],
    } as unknown as CampaignResult<unknown, Scenario>
    const bd = campaignBreakdown(campaign)
    const weak = bd.scenarios.find((s) => s.scenarioId === 'weak-case')
    expect(weak?.composite).toBeCloseTo(0.5)
    expect(weak?.notes).toMatch(/16 \(tax recompute\)/i)
    // notes are carried, not dropped
    expect(bd.scenarios.every((s) => typeof s.notes === 'string')).toBe(true)
  })

  it('dedups repeated notes across reps of the same scenario', () => {
    const campaign = {
      cells: [
        cell('c', 0.4, 'missed line 16'),
        { ...cell('c', 0.6, 'missed line 16'), cellId: 'c:1', rep: 1 },
      ],
    } as unknown as CampaignResult<unknown, Scenario>
    const bd = campaignBreakdown(campaign)
    const c = bd.scenarios.find((s) => s.scenarioId === 'c')
    expect(c?.notes).toBe('missed line 16') // deduped, not 'missed line 16 | missed line 16'
  })

  it('buildReflectionPrompt quotes the failure note so the model targets it', () => {
    const prompt = buildReflectionPrompt({
      target: 'tax guidance',
      parentPayload: 'BASE',
      topTrials: [{ id: 'strong', score: 1.0 }],
      bottomTrials: [
        { id: 'weak', score: 0.5, failureNote: 'missed lines: 16 (tax recompute), 25d' },
      ],
      childCount: 1,
    })
    expect(prompt).toMatch(/Why it scored low.*tax recompute/is)
    // the failure pattern is in the prompt the optimizer sees — not just a score
    expect(prompt).toContain('25d')
  })
})
