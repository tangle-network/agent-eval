import { describe, expect, it } from 'vitest'
import { neutralizeText } from '../neutralize'
import type { GateContext, JudgeScore, Scenario } from '../types'
import { neutralizationGate } from './neutralization-gate'

const scenarios: Scenario[] = [
  { id: 's1' } as Scenario,
  { id: 's2' } as Scenario,
  { id: 's3' } as Scenario,
]

/** Build a per-cell score map: one cell per scenario (rep 0), one judge. */
function scoreMap(byScenario: Record<string, number>): Map<string, Record<string, JudgeScore>> {
  const m = new Map<string, Record<string, JudgeScore>>()
  for (const [sid, composite] of Object.entries(byScenario)) {
    m.set(`${sid}:0`, { j: { composite, dimensions: {}, notes: '' } as JudgeScore })
  }
  return m
}

function ctx(
  candidate: Record<string, number>,
  baseline: Record<string, number>,
  neutralized: Record<string, number>,
): GateContext<unknown, Scenario> {
  return {
    candidateArtifacts: new Map(),
    judgeScores: scoreMap(candidate),
    baselineJudgeScores: scoreMap(baseline),
    neutralizedJudgeScores: scoreMap(neutralized),
    scenarios,
    cost: { candidate: 0, baseline: 0 },
    signal: new AbortController().signal,
  }
}

describe('neutralizationGate', () => {
  it('SHIPS when the lift collapses under neutralization (content is causal)', async () => {
    const gate = neutralizationGate({ scenarios })
    // candidate lifts +4 over baseline; blanked content recovers ~0 → causal.
    const res = await gate.decide(
      ctx(
        { s1: 8, s2: 8, s3: 8 }, // candidate
        { s1: 4, s2: 4, s3: 4 }, // baseline
        { s1: 4, s2: 4, s3: 4 }, // neutralized == baseline
      ),
    )
    expect(res.decision).toBe('ship')
    const detail = res.contributingGates[0]?.detail as { decorativeFraction: number }
    expect(detail.decorativeFraction).toBeCloseTo(0, 5)
  })

  it('HOLDS when the lift survives neutralization (decorative — footprint, not content)', async () => {
    const gate = neutralizationGate({ scenarios })
    // candidate +4; blanked content still recovers +3 (75% ≥ 50%) → decorative.
    const res = await gate.decide(
      ctx({ s1: 8, s2: 8, s3: 8 }, { s1: 4, s2: 4, s3: 4 }, { s1: 7, s2: 7, s3: 7 }),
    )
    expect(res.decision).toBe('hold')
    expect(res.reasons[0]).toMatch(/DECORATIVE/)
    const detail = res.contributingGates[0]?.detail as { decorativeFraction: number }
    expect(detail.decorativeFraction).toBeCloseTo(0.75, 5)
  })

  it('HOLDS exactly at the threshold (equality is decorative)', async () => {
    const gate = neutralizationGate({ scenarios, maxDecorativeFraction: 0.5 })
    const res = await gate.decide(
      ctx({ s1: 8, s2: 8, s3: 8 }, { s1: 4, s2: 4, s3: 4 }, { s1: 6, s2: 6, s3: 6 }),
    )
    // neutralized +2 / candidate +4 = 0.5 → not < 0.5 → hold.
    expect(res.decision).toBe('hold')
  })

  it('HOLDS (fail-closed) when the candidate has no positive lift', async () => {
    const gate = neutralizationGate({ scenarios })
    const res = await gate.decide(
      ctx({ s1: 4, s2: 4, s3: 4 }, { s1: 4, s2: 4, s3: 4 }, { s1: 4, s2: 4, s3: 4 }),
    )
    expect(res.decision).toBe('hold')
    expect(res.reasons[0]).toMatch(/no positive lift/)
  })

  it('throws when the neutralized arm is missing (composed without loop wiring)', async () => {
    const gate = neutralizationGate({ scenarios })
    const bare = ctx({ s1: 8 }, { s1: 4 }, { s1: 4 })
    bare.neutralizedJudgeScores = undefined
    await expect(gate.decide(bare)).rejects.toThrow(/neutralizedJudgeScores is required/)
  })
})

describe('neutralizeText', () => {
  it('preserves whitespace/layout and blanks non-whitespace', () => {
    const src = 'line one\n  indented two\n'
    const out = neutralizeText(src)
    expect(out).toBe('#### ###\n  ######## ###\n')
    // same length + same whitespace positions, zero readable content
    expect(out.length).toBe(src.length)
    expect([...out].filter((c) => /\s/.test(c)).join('')).toBe(
      [...src].filter((c) => /\s/.test(c)).join(''),
    )
    expect(out).not.toMatch(/[a-z]/i)
  })

  it('is byte-length-exact for ASCII', () => {
    const src = 'the frontier author knows section 1202(b)(2)'
    expect(Buffer.byteLength(neutralizeText(src))).toBe(Buffer.byteLength(src))
  })

  it('preserves character count (not byte count) for multibyte content', () => {
    // Documented limitation: a 2-byte char blanks to a 1-byte filler, so byte
    // length shrinks while CHARACTER count + layout are preserved. The tokenizer
    // footprint tracks char/token structure, which is what the placebo needs.
    const src = 'knows §1202'
    expect(neutralizeText(src).length).toBe(src.length)
    expect(neutralizeText(src)).toBe('##### #####')
  })
})
