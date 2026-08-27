import { describe, expect, it } from 'vitest'
import { campaignBreakdown, campaignMeanComposite } from '../../src/campaign/score-utils'
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

  it('keeps invalid judge values out of descriptive aggregates', () => {
    const mixed = cell('mixed', 0.6, 'finite result')
    mixed.judgeScores.invalid = {
      composite: Number.NaN,
      dimensions: { broken: Number.NaN },
      notes: 'invalid result',
    }
    const campaign = { cells: [mixed] } as unknown as CampaignResult<unknown, Scenario>

    expect(campaignMeanComposite(campaign)).toBe(0.6)
    expect(campaignBreakdown(campaign)).toEqual({
      dimensions: { d: 0.6 },
      scenarios: [{ scenarioId: 'mixed', composite: 0.6, notes: 'finite result' }],
    })
  })

  it('excludes failed judge scores from means instead of folding them into zeros', () => {
    // JudgeScore contract (types.ts): `failed: true` composites carry no
    // signal — a judge-call error must not drag a candidate toward zero.
    const mixed = cell('mixed', 0.9, 'real verdict')
    mixed.judgeScores.broken = {
      composite: 0,
      dimensions: { d: 0 },
      notes: 'judge call error',
      failed: true,
    }
    const campaign = { cells: [mixed] } as unknown as CampaignResult<unknown, Scenario>

    // Unfiltered folding would yield (0.9 + 0) / 2 = 0.45.
    expect(campaignMeanComposite(campaign)).toBeCloseTo(0.9)
    const bd = campaignBreakdown(campaign)
    expect(bd.scenarios).toEqual([{ scenarioId: 'mixed', composite: 0.9, notes: 'real verdict' }])
    expect(bd.dimensions).toEqual({ d: 0.9 })
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

describe('emitted evidence — worst-rep raw output reaches the breakdown', () => {
  function stringCell(
    scenarioId: string,
    rep: number,
    composite: number,
    artifact: unknown,
  ): CampaignCellResult<unknown> {
    return {
      cellId: `${scenarioId}:${rep}`,
      scenarioId,
      rep,
      artifact,
      judgeScores: { j: { composite, dimensions: { d: composite }, notes: '' } },
      costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
      durationMs: 0,
      seed: 0,
      cached: false,
    }
  }

  it('keeps the LOWEST-composite rep artifact and clips it to the 2000-char bound', () => {
    const megabyteish = `WORST:${'a'.repeat(3000)}`
    const campaign = {
      cells: [stringCell('s', 0, 0.9, 'BEST: clean run'), stringCell('s', 1, 0.2, megabyteish)],
    } as unknown as CampaignResult<unknown, Scenario>
    const bd = campaignBreakdown(campaign)
    const s = bd.scenarios.find((row) => row.scenarioId === 's')
    // Worst rep wins — reflection grounds on the failure, not the success.
    expect(s?.emitted?.startsWith('WORST:')).toBe(true)
    expect(s?.emitted).not.toContain('BEST')
    // Bounded so a full transcript cannot blow the reflection-prompt budget.
    expect(s?.emitted).toHaveLength(2000)
    expect(s?.emitted).toBe(megabyteish.slice(0, 2000))
  })

  it('ignores non-string and empty artifacts, and cells whose only judges failed', () => {
    const failedJudgeCell = stringCell('s', 1, 0, 'FAILED-JUDGE RUN')
    failedJudgeCell.judgeScores = {
      j: { composite: 0, dimensions: { d: 0 }, notes: 'judge died', failed: true },
    }
    const campaign = {
      cells: [
        stringCell('s', 0, 0.8, 'REAL RUN'),
        // composite 0 would win worst-rep selection if failed judges counted
        failedJudgeCell,
        stringCell('t', 0, 0.5, { structured: true }),
        stringCell('u', 0, 0.5, '   '),
      ],
    } as unknown as CampaignResult<unknown, Scenario>
    const bd = campaignBreakdown(campaign)
    expect(bd.scenarios.find((row) => row.scenarioId === 's')?.emitted).toBe('REAL RUN')
    expect(bd.scenarios.find((row) => row.scenarioId === 't')?.emitted).toBeUndefined()
    expect(bd.scenarios.find((row) => row.scenarioId === 'u')?.emitted).toBeUndefined()
  })
})
