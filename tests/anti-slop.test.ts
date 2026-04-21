import { describe, it, expect } from 'vitest'
import { analyzeAntiSlop, createAntiSlopJudge } from '../src/anti-slop'

function cfg(overrides: Record<string, unknown> = {}) {
  return {
    bannedPhrases: [],
    bannedOpenings: [],
    hedgingPatterns: [],
    apologyPatterns: [],
    repetitionThreshold: 0.15,
    minLength: 20,
    maxLength: 8000,
    penaltyWeights: { banned_phrase: 1, banned_opening: 1, hedging: 0.5, apology: 0.5, repetition: 0.75, length: 0.5 },
    ...overrides,
  }
}

describe('analyzeAntiSlop', () => {
  it('clean output scores 10 — regression: false positives punish good agents', () => {
    const r = analyzeAntiSlop(['The capital of France is Paris.'], cfg())
    expect(r.score).toBe(10)
    expect(r.issues).toHaveLength(0)
  })

  it('banned phrase detected + penalized', () => {
    const r = analyzeAntiSlop(
      ['Let me delve into this topic in detail enough here.'],
      cfg({ bannedPhrases: ['delve'] }),
    )
    expect(r.counts.banned_phrase).toBe(1)
    expect(r.score).toBeLessThan(10)
    expect(r.issues[0].example).toMatch(/delve/)
  })

  it('counts every occurrence of a banned phrase — regression: single-match shortcut masks high-frequency violations', () => {
    const r = analyzeAntiSlop(
      ['delve delve delve delve into things here.'],
      cfg({ bannedPhrases: ['delve'] }),
    )
    expect(r.counts.banned_phrase).toBe(4)
  })

  it('banned opening pattern triggers once per output', () => {
    const r = analyzeAntiSlop(
      ['Great question! Let me help you understand this better today.'],
      cfg({ bannedOpenings: [/^great question/i] }),
    )
    expect(r.counts.banned_opening).toBe(1)
  })

  it('hedging patterns are detected — regression: silent hedges teach agents that wishy-washy is OK', () => {
    const r = analyzeAntiSlop(
      ['I could be wrong, but I think maybe this is true. Perhaps you could also try another thing.'],
      cfg({ hedgingPatterns: [/i could be wrong/i, /i think maybe/i, /perhaps you could/i] }),
    )
    expect(r.counts.hedging).toBeGreaterThanOrEqual(3)
  })

  it('apology padding detected', () => {
    const r = analyzeAntiSlop(
      ['I apologize for the confusion here — let me try again with this now.'],
      cfg({ apologyPatterns: [/i apologize for/i] }),
    )
    expect(r.counts.apology).toBe(1)
  })

  it('repetition above threshold is flagged — regression: stale agents loop and the score should reflect it', () => {
    const repetitive = [
      'The capital is Paris. The capital is Paris. The capital is Paris. The capital is Paris. The capital is Paris. The capital is Paris.',
    ]
    const r = analyzeAntiSlop(repetitive, cfg({ repetitionThreshold: 0.3 }))
    expect(r.counts.repetition).toBe(1)
  })

  it('too-short output flagged', () => {
    const r = analyzeAntiSlop(['yes'], cfg({ minLength: 20 }))
    expect(r.counts.length).toBe(1)
  })

  it('too-long output flagged', () => {
    const r = analyzeAntiSlop(['x'.repeat(10_000)], cfg({ maxLength: 1000 }))
    expect(r.counts.length).toBe(1)
  })

  it('score clamps to 0 on many violations — regression: negative scores break weighted means', () => {
    const r = analyzeAntiSlop(
      ['delve delve delve delve delve delve delve delve delve delve delve delve delve delve delve'],
      cfg({ bannedPhrases: ['delve'] }),
    )
    expect(r.score).toBe(0)
  })
})

describe('createAntiSlopJudge', () => {
  it('produces a JudgeScore with dimension=anti_slop from turn agentResponses', async () => {
    const judge = createAntiSlopJudge({
      domain: 'legal',
      bannedPhrases: ['delve'],
    })
    // JudgeFn signature: (tc, input) => Promise<JudgeScore[]>; we pass a stub tc
    const scores = await judge({} as never, {
      scenario: { id: 's1' } as never,
      turns: [
        { turnIndex: 0, userMessage: 'go', agentResponse: 'Clean reply — plenty of content here.', durationMs: 0, blocksExtracted: [], containsCode: false, containsToolCall: false },
      ],
      artifacts: { vaultFiles: [], blocksExtracted: [], codeBlocks: [], toolCalls: [] },
    })
    expect(scores).toHaveLength(1)
    expect(scores[0].dimension).toBe('anti_slop')
    expect(scores[0].score).toBe(10)
  })
})
