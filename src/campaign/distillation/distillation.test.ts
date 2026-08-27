import { describe, expect, it } from 'vitest'
import type { LlmCallResult } from '../../llm-client'
import { buildAgreementJudge, fieldAgreement } from './agreement-judge'
import { type GoldScenario, parseGoldJsonl, splitGold } from './gold-scenarios'
import { runDistillation } from './run-distillation'

// The skill-audit verdict shape the harness is built to distill toward: a
// categorical value_verdict, a boolean leak flag, and an array of actions.
interface Verdict extends Record<string, unknown> {
  value_verdict: 'keep' | 'cut' | 'merge'
  public_leak_risk: boolean
  recommended_actions: string[]
}

const skillVerdictComparator = fieldAgreement<Verdict, Verdict>({
  categorical: ['value_verdict', 'public_leak_risk'],
  array: ['recommended_actions'],
})

describe('fieldAgreement', () => {
  it('scores an exact categorical+array match as 1.0', () => {
    const gold: Verdict = {
      value_verdict: 'keep',
      public_leak_risk: false,
      recommended_actions: ['a', 'b'],
    }
    const { score, dimensions } = skillVerdictComparator(
      { ...gold, recommended_actions: ['b', 'a'] },
      gold,
    )
    expect(score).toBe(1)
    expect(dimensions).toEqual({ value_verdict: 1, public_leak_risk: 1, recommended_actions: 1 })
  })

  it('scores a total mismatch as 0', () => {
    const gold: Verdict = {
      value_verdict: 'keep',
      public_leak_risk: false,
      recommended_actions: ['a', 'b'],
    }
    const produced: Verdict = {
      value_verdict: 'cut',
      public_leak_risk: true,
      recommended_actions: ['x', 'y'],
    }
    const { score, dimensions } = skillVerdictComparator(produced, gold)
    expect(score).toBe(0)
    expect(dimensions).toEqual({ value_verdict: 0, public_leak_risk: 0, recommended_actions: 0 })
  })

  it('scores a partial array overlap as the exact Jaccard', () => {
    // gold {a,b,c}, produced {b,c,d} -> intersection {b,c}=2, union {a,b,c,d}=4 -> 0.5
    const gold: Verdict = {
      value_verdict: 'keep',
      public_leak_risk: false,
      recommended_actions: ['a', 'b', 'c'],
    }
    const produced: Verdict = {
      value_verdict: 'keep',
      public_leak_risk: false,
      recommended_actions: ['b', 'c', 'd'],
    }
    const { score, dimensions } = skillVerdictComparator(produced, gold)
    expect(dimensions.recommended_actions).toBe(0.5)
    // value_verdict=1, public_leak_risk=1, recommended_actions=0.5 -> mean = 2.5/3
    expect(score).toBeCloseTo(2.5 / 3, 12)
  })

  it('REGRESSION: a verdict matching value_verdict but MISSING a public_leak_risk=true scores LOWER than a full match', () => {
    // The headline lesson of the skill audit: the cheap analyst must agree with
    // the teacher on leak-detection, not just the headline keep/cut verdict. A
    // student that gets value_verdict right but misses the leak flag must be
    // penalized -- otherwise GEPA has no gradient to teach leak detection.
    const gold: Verdict = {
      value_verdict: 'keep',
      public_leak_risk: true,
      recommended_actions: ['sanitize'],
    }
    const fullMatch = skillVerdictComparator({ ...gold }, gold)
    const missesLeak = skillVerdictComparator({ ...gold, public_leak_risk: false }, gold)

    expect(fullMatch.score).toBe(1)
    // 2 of 3 fields agree (value_verdict + recommended_actions); the leak flag
    // disagrees -> exactly 2/3.
    expect(missesLeak.score).toBeCloseTo(2 / 3, 12)
    expect(missesLeak.dimensions.public_leak_risk).toBe(0)
    expect(missesLeak.score).toBeLessThan(fullMatch.score)
  })

  it('treats two empty arrays as full agreement (1.0)', () => {
    const gold: Verdict = { value_verdict: 'cut', public_leak_risk: false, recommended_actions: [] }
    const { dimensions } = skillVerdictComparator({ ...gold }, gold)
    expect(dimensions.recommended_actions).toBe(1)
  })

  it('throws when no fields are configured', () => {
    expect(() => fieldAgreement({})).toThrowError(/at least one categorical or array field/)
  })
})

describe('loadGoldScenarios / parseGoldJsonl + splitGold', () => {
  const jsonl = [
    JSON.stringify({ scenarioId: 's0', input: { skill: 'a' }, label: { value_verdict: 'keep' } }),
    JSON.stringify({ id: 's1', input: { skill: 'b' }, label: { value_verdict: 'cut' } }),
    JSON.stringify({
      scenarioId: 's2',
      input: { skill: 'c' },
      label: { value_verdict: 'keep' },
      split: 'test',
    }),
    JSON.stringify({ scenarioId: 's3', input: { skill: 'd' }, label: { value_verdict: 'merge' } }),
  ].join('\n')

  it('parses each line into a GoldScenario (accepts scenarioId OR id)', () => {
    const scenarios = parseGoldJsonl(jsonl)
    expect(scenarios.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3'])
    expect(scenarios.every((s) => s.kind === 'gold')).toBe(true)
    expect(scenarios[0]!.input).toEqual({ skill: 'a' })
    expect(scenarios[0]!.label).toEqual({ value_verdict: 'keep' })
    // explicit split tag is preserved
    expect(scenarios[2]!.tags).toEqual(['split:test'])
  })

  it('splits deterministically (modulo) AND honors an explicit split tag', () => {
    const scenarios = parseGoldJsonl(jsonl)
    const { train, test } = splitGold(scenarios, { testEveryNth: 4 })
    // s2 is explicitly test; s0/s1/s3 are implicit indices 0,1,2 -> index0 (s0) is test.
    expect(test.map((s) => s.id).sort()).toEqual(['s0', 's2'])
    expect(train.map((s) => s.id).sort()).toEqual(['s1', 's3'])
  })

  it('is fully deterministic -- identical input yields identical splits', () => {
    const a = splitGold(parseGoldJsonl(jsonl))
    const b = splitGold(parseGoldJsonl(jsonl))
    expect(a.train.map((s) => s.id)).toEqual(b.train.map((s) => s.id))
    expect(a.test.map((s) => s.id)).toEqual(b.test.map((s) => s.id))
  })

  it('throws on a malformed line (missing id / input / label)', () => {
    expect(() => parseGoldJsonl(JSON.stringify({ input: {}, label: {} }))).toThrowError(
      /missing string/,
    )
    expect(() => parseGoldJsonl(JSON.stringify({ id: 'x', label: {} }))).toThrowError(
      /missing `input`/,
    )
    expect(() => parseGoldJsonl(JSON.stringify({ id: 'x', input: {} }))).toThrowError(
      /missing `label`/,
    )
  })

  it('sanitizes a colon in the id (the real skill:foo gold ids) so the cellId split stays correct', () => {
    // REGRESSION: `skill:blueprint-launch` as a raw id would make the campaign
    // cellId `skill:blueprint-launch:0`, and heldOutGate's `cellId.split(':')[0]`
    // would recover 'skill' for every scenario — collapsing the holdout to one
    // bucket and zeroing the delta. The id must be sanitized to colon-free.
    const [s] = parseGoldJsonl(
      JSON.stringify({ scenarioId: 'skill:blueprint-launch', input: {}, label: {} }),
    )
    expect(s!.id).toBe('skill__blueprint-launch')
    expect(s!.id.includes(':')).toBe(false)
    // the original id is preserved for traceback
    expect(s!.tags).toContain('gold-id:skill:blueprint-launch')
  })

  it('rejects a too-small testEveryNth', () => {
    expect(() => splitGold(parseGoldJsonl(jsonl), { testEveryNth: 1 })).toThrowError(/integer/)
  })
})

describe('buildAgreementJudge', () => {
  it('returns a JudgeConfig whose score() yields the comparator agreement for a produced-vs-gold pair', () => {
    const judge = buildAgreementJudge<Verdict, Verdict, Verdict>({
      compareLabels: skillVerdictComparator,
    })
    const scenario: GoldScenario<Verdict, Verdict> = {
      id: 's0',
      kind: 'gold',
      input: { value_verdict: 'keep', public_leak_risk: false, recommended_actions: [] },
      label: { value_verdict: 'keep', public_leak_risk: true, recommended_actions: ['sanitize'] },
    }
    // produced agrees on value_verdict only; misses leak flag + actions -> 1/3.
    const produced: Verdict = {
      value_verdict: 'keep',
      public_leak_risk: false,
      recommended_actions: [],
    }
    // score() is synchronous here (pure comparator); the contract allows a
    // Promise, so narrow it.
    const result = judge.score({
      artifact: produced,
      scenario,
      signal: new AbortController().signal,
    })
    if (result instanceof Promise) throw new Error('agreement judge must score synchronously')
    expect(result.composite).toBeCloseTo(1 / 3, 12)
    expect(result.dimensions.value_verdict).toBe(1)
    expect(result.dimensions.public_leak_risk).toBe(0)
    expect(result.dimensions.recommended_actions).toBe(0)
    // The scalar headline is mirrored under `agreement`.
    expect(result.dimensions.agreement).toBeCloseTo(1 / 3, 12)
  })

  it('only applies to gold-kind scenarios by default', () => {
    const judge = buildAgreementJudge<Verdict, Verdict, Verdict>({
      compareLabels: skillVerdictComparator,
    })
    const gold: GoldScenario<Verdict, Verdict> = {
      id: 'x',
      kind: 'gold',
      input: { value_verdict: 'keep', public_leak_risk: false, recommended_actions: [] },
      label: { value_verdict: 'keep', public_leak_risk: false, recommended_actions: [] },
    }
    expect(judge.appliesTo?.(gold)).toBe(true)
    // A non-gold scenario (cast — the runtime check keys on kind, not the type).
    expect(
      judge.appliesTo?.({ ...gold, kind: 'other' } as unknown as GoldScenario<Verdict, Verdict>),
    ).toBe(false)
  })

  it('throws if the comparator returns an out-of-range score', () => {
    const judge = buildAgreementJudge<Verdict, Verdict, Verdict>({
      compareLabels: () => ({ score: 1.5, dimensions: {} }),
    })
    const scenario: GoldScenario<Verdict, Verdict> = {
      id: 's0',
      kind: 'gold',
      input: { value_verdict: 'keep', public_leak_risk: false, recommended_actions: [] },
      label: { value_verdict: 'keep', public_leak_risk: false, recommended_actions: [] },
    }
    expect(() =>
      judge.score({ artifact: scenario.input, scenario, signal: new AbortController().signal }),
    ).toThrowError(/out-of-range score/)
  })
})

// -- End-to-end wiring (no real tokens) ------------------------------------
// Proves runDistillation composes runImprovementLoop + gepaProposer + the gate
// end-to-end. The STUDENT runs on a mock ChatClient transport; the GEPA
// reflection runs on a stubbed fetch. DISTILL_LIVE-gated only because it
// exercises the full loop machinery, not because it costs anything.

const GOLD: Array<{
  scenarioId: string
  input: Verdict
  label: Verdict
  split?: 'train' | 'test'
}> = [
  {
    scenarioId: 'skill-keep',
    input: { value_verdict: 'keep', public_leak_risk: false, recommended_actions: [] },
    label: { value_verdict: 'keep', public_leak_risk: false, recommended_actions: ['add-evals'] },
    split: 'train',
  },
  {
    scenarioId: 'skill-leak',
    input: { value_verdict: 'keep', public_leak_risk: false, recommended_actions: [] },
    label: { value_verdict: 'keep', public_leak_risk: true, recommended_actions: ['sanitize'] },
    split: 'train',
  },
  {
    scenarioId: 'skill-cut',
    input: { value_verdict: 'cut', public_leak_risk: false, recommended_actions: [] },
    label: { value_verdict: 'cut', public_leak_risk: false, recommended_actions: ['deprecate'] },
    split: 'test',
  },
]

/** Stub OpenAI chat-completions body the LlmClient parses. */
function completion(content: string): Record<string, unknown> {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    _response_cost: 0.0001,
    model: 'stub',
  }
}

describe.skipIf(!process.env.DISTILL_LIVE)('runDistillation wiring (mock transports)', () => {
  it('composes the loop end-to-end and returns a winner surface + holdout agreement', async () => {
    const scenarios = parseGoldJsonl<Verdict, Verdict>(
      GOLD.map((g) => JSON.stringify(g)).join('\n'),
    )
    const { train, test } = splitGold(scenarios)
    expect(train.map((s) => s.id)).toEqual(['skill-keep', 'skill-leak'])
    expect(test.map((s) => s.id)).toEqual(['skill-cut'])

    // STUDENT: a deterministic mock that copies the input verdict but never
    // raises public_leak_risk -- the UN-distilled student that agrees on the
    // headline verdict yet misses the leak the teacher caught. The agreement
    // judge therefore produces real, < 1.0 scores, so the holdout numbers are
    // meaningful (not a degenerate all-1 or all-0).
    const studentChat = async (req: {
      messages: Array<{ role: string; content: unknown }>
    }): Promise<LlmCallResult> => {
      const userTurn = req.messages.find((m) => m.role === 'user')
      const text = typeof userTurn?.content === 'string' ? userTurn.content : ''
      const verdict: Verdict['value_verdict'] = text.includes('"cut"')
        ? 'cut'
        : text.includes('"merge"')
          ? 'merge'
          : 'keep'
      const guess: Verdict = {
        value_verdict: verdict,
        public_leak_risk: false,
        recommended_actions: [],
      }
      return {
        content: JSON.stringify(guess),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        costUsd: 0.0001,
        model: 'mock-student',
        durationMs: 1,
        raw: {},
      }
    }

    // GEPA reflection: stub fetch returns one valid proposal whose payload is a
    // distinct (non-parent) surface so the proposer accepts it.
    let reflectionCalls = 0
    const stubFetch = (async () => {
      reflectionCalls++
      const payload = `You are a skill-audit analyst. Emit a JSON verdict. (rev ${reflectionCalls})`
      const body = completion(
        JSON.stringify({
          proposals: [{ label: 'tighten', rationale: 'sharpen leak rule', payload }],
        }),
      )
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const judge = buildAgreementJudge<Verdict, Verdict, Verdict>({
      compareLabels: skillVerdictComparator,
      dimensionKeys: ['value_verdict', 'public_leak_risk', 'recommended_actions'],
    })

    const result = await runDistillation<Verdict, Verdict, Verdict>({
      baselinePrompt: 'You are a skill-audit analyst. Emit a JSON verdict.',
      train,
      holdout: test,
      llm: { transport: 'mock', defaultModel: 'mock-student', handler: studentChat },
      reflectionLlm: { apiKey: 'stub', baseUrl: 'http://stub/v1', fetch: stubFetch },
      studentModel: 'mock-student',
      optimizerModel: 'stub-optimizer',
      judge,
      populationSize: 2,
      maxGenerations: 1,
      reps: 1,
      runDir: `.evolve/distillation-test/${Date.now()}`,
    })

    // The loop ran: a winning prompt string came back, and the holdout was
    // re-scored for baseline + winner.
    expect(typeof result.winnerPrompt).toBe('string')
    expect(result.winnerPrompt.length).toBeGreaterThan(0)
    expect(result.holdoutAgreement.baseline).toBeGreaterThanOrEqual(0)
    expect(result.holdoutAgreement.baseline).toBeLessThanOrEqual(1)
    expect(result.holdoutAgreement.winner).toBeGreaterThanOrEqual(0)
    expect(result.holdoutAgreement.winner).toBeLessThanOrEqual(1)
    expect(result.holdoutAgreement.delta).toBeCloseTo(
      result.holdoutAgreement.winner - result.holdoutAgreement.baseline,
      12,
    )
    // The holdout student copies value_verdict ('cut') correctly but emits no
    // recommended_actions and no leak flag; gold is {cut, false, [deprecate]}.
    // value_verdict=1, public_leak_risk=1 (both false), recommended_actions=0
    // -> 2/3. This pins the agreement math through the full campaign.
    expect(result.holdoutAgreement.baseline).toBeCloseTo(2 / 3, 12)
    // The gate ran on the holdout and returned a decision.
    expect(['ship', 'hold', 'need_more_work', 'model_ceiling', 'arch_ceiling']).toContain(
      result.gateResult.decision,
    )
    // GEPA reflection was actually invoked (the proposer is wired, not bypassed).
    expect(reflectionCalls).toBeGreaterThan(0)
    // One holdout scenario x 1 rep, scored on each of baseline + winner.
    expect(result.baselineOnHoldout.cells).toHaveLength(1)
    expect(result.winnerOnHoldout.cells).toHaveLength(1)
  })
})
