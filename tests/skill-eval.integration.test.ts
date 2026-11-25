/**
 * The skill eval recipe end to end: real headroom, pairing and paired
 * statistics, with a scripted agent and a scripted judge as the two callbacks.
 *
 * Each scripted answer carries a quality number and nothing about its arm. The
 * judge prefers the higher number, so every scenario below states how good each
 * arm's answers are and the test reads the decision the recipe reaches.
 */

import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/errors'
import {
  runSkillEval,
  type SkillEvalArm,
  type SkillEvalArmInput,
  type SkillEvalJudgeInput,
  type SkillEvalPreference,
  type SkillEvalRun,
  type SkillEvalTrace,
  skillEvalTraceFromRun,
} from '../src/skill-eval'
import { TraceEmitter } from '../src/trace/emitter'
import { InMemoryTraceStore } from '../src/trace/store'

interface Case {
  id: string
  index: number
}

const UNIT = {
  name: 'run-the-checks',
  text: 'Before you answer, run the checks for the change and quote their result.',
}

function casesOf(count: number): Case[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${String(index).padStart(3, '0')}`,
    index,
  }))
}

interface Script {
  /** How good the arm's answer to this case is. The judge prefers the higher number. */
  quality: (arm: SkillEvalArm, index: number) => number
  /** Whether the arm's answer passes the case's check. Default: every second case passes. */
  pass?: (arm: SkillEvalArm, index: number) => boolean | null
  trace?: (arm: SkillEvalArm, index: number) => Partial<SkillEvalTrace>
}

const qualityOf = (answer: string): number => Number(answer.split(' ')[1])

function scripted(script: Script) {
  const runs: Array<{ id: string; arm: SkillEvalArm; text: string | null }> = []
  const judged: Array<SkillEvalJudgeInput<Case>> = []
  return {
    runs,
    judged,
    run: async (testCase: Case, arm: SkillEvalArmInput): Promise<SkillEvalRun> => {
      runs.push({ id: testCase.id, arm: arm.arm, text: arm.text })
      return {
        answer: `quality ${script.quality(arm.arm, testCase.index)} on ${testCase.id}`,
        pass: script.pass ? script.pass(arm.arm, testCase.index) : testCase.index % 2 === 0,
        trace: {
          toolCalls: null,
          toolErrors: null,
          wallMs: null,
          costUsd: null,
          ...script.trace?.(arm.arm, testCase.index),
        },
      }
    },
    judge: async (input: SkillEvalJudgeInput<Case>): Promise<SkillEvalPreference> => {
      judged.push(input)
      const first = qualityOf(input.first)
      const second = qualityOf(input.second)
      return first === second ? 'tie' : first > second ? 'first' : 'second'
    },
  }
}

describe('runSkillEval decisions', () => {
  it('keeps a unit whose answers blind judges reliably prefer', async () => {
    const world = scripted({
      quality: (arm, index) => (arm === 'with' && index < 10 ? 2 : 1),
      trace: (arm, index) => ({ toolCalls: arm === 'with' ? 4 : 6 + (index % 2), costUsd: 0.02 }),
    })

    const report = await runSkillEval({ unit: UNIT, cases: casesOf(12), ...world })

    expect(report.decision).toBe('keep')
    expect(report.arms).toEqual(['without', 'with'])
    expect(report.headroom).toMatchObject({
      passed: 6,
      failed: 6,
      unknown: 0,
      passRate: 0.5,
      verdict: 'separable',
    })
    expect(report.comparisons).toHaveLength(1)
    const [comparison] = report.comparisons
    expect(comparison?.against).toBe('without')
    expect(comparison?.preference).toMatchObject({
      wins: 10,
      losses: 0,
      ties: 2,
      notJudged: 0,
      withReliablyPreferred: true,
      otherReliablyPreferred: false,
    })
    // Ten decided judgments, all for `with`: the Wilson interval is 10 / (10 + z^2) to 1.
    expect(comparison?.preference.winRate?.estimate).toBe(1)
    expect(comparison?.preference.winRate?.lower).toBeCloseTo(10 / (10 + 1.959964 ** 2), 4)
    expect(comparison?.preference.winRate?.upper).toBeCloseTo(1, 10)
    // The paired decision is on net preference over all twelve judged cases.
    expect(comparison?.preference.net).toMatchObject({ n: 12, promote: true, sufficient: true })
    expect(comparison?.preference.net?.delta).toBeCloseTo(10 / 12, 10)
    expect(comparison?.preference.net?.low).toBeGreaterThan(0)
    expect(comparison?.preference.net?.mcnemar).toMatchObject({ b: 10, c: 0 })

    // Process measures are paired per case: with minus without.
    const deltas = Object.fromEntries(
      comparison?.process.metricDeltas.map((delta) => [delta.name, delta]) ?? [],
    )
    expect(comparison?.process.nPairs).toBe(12)
    expect(deltas.toolCalls).toMatchObject({ n: 12, nMissing: 0, meanDelta: -2.5 })
    expect(deltas.costUsd).toMatchObject({ n: 12, nMissing: 0 })
    expect(deltas.costUsd?.meanDelta).toBeCloseTo(0, 12)
    // No run reported wall time or tool errors: no reading, not a zero change.
    expect(deltas.wallMs).toMatchObject({ n: 0, nMissing: 12, meanDelta: null })
    expect(deltas.toolErrors).toMatchObject({ n: 0, nMissing: 12, meanDelta: null })
    // Twelve pairs are too few for the bootstrap to call a process change reliable.
    expect(comparison?.reliablyLower).toEqual([])

    expect(report.reason).toContain('10 to 0, 2 ties')
    expect(report.rule[0]).toContain('A suite that passes 100% is not evidence')
    expect(report.rule.some((clause) => clause.startsWith('Keep when blind judges'))).toBe(true)
    expect(report.failures).toEqual([])
  })

  it('needs the unit to beat a neutral text of its own length, and hands each arm its text', async () => {
    const beatsBoth = scripted({ quality: (arm, index) => (arm === 'with' && index < 10 ? 2 : 1) })
    const kept = await runSkillEval({
      unit: UNIT,
      cases: casesOf(12),
      ...beatsBoth,
      control: true,
    })
    expect(kept.decision).toBe('keep')
    expect(kept.arms).toEqual(['without', 'with', 'control'])
    expect(kept.comparisons.map((comparison) => comparison.against)).toEqual(['without', 'control'])
    expect(kept.reason).toContain('and over the control')

    const texts = (arm: SkillEvalArm) => [
      ...new Set(beatsBoth.runs.filter((run) => run.arm === arm).map((run) => run.text)),
    ]
    expect(texts('without')).toEqual([null])
    expect(texts('with')).toEqual([UNIT.text])
    const [controlText] = texts('control')
    expect(texts('control')).toHaveLength(1)
    expect(controlText).toHaveLength(UNIT.text.length)
    expect(controlText).not.toBe(UNIT.text)

    // Any added text helps as much as the unit does: the gain is not the unit's.
    const lengthOnly = scripted({
      quality: (arm, index) => (arm !== 'without' && index < 10 ? 2 : 1),
    })
    const unsure = await runSkillEval({
      unit: UNIT,
      cases: casesOf(12),
      ...lengthOnly,
      control: true,
    })
    expect(unsure.decision).toBe('inconclusive')
    expect(unsure.comparisons[0]?.preference.withReliablyPreferred).toBe(true)
    expect(unsure.comparisons[1]?.preference).toMatchObject({ wins: 0, losses: 0, ties: 12 })
    expect(unsure.reason).toContain('added text')

    // The neutral text does better than the unit: the unit is worse than nothing in particular.
    const controlWins = scripted({
      quality: (arm, index) => (index >= 10 ? 1 : arm === 'control' ? 3 : arm === 'with' ? 2 : 1),
    })
    const cut = await runSkillEval({
      unit: UNIT,
      cases: casesOf(12),
      ...controlWins,
      control: true,
    })
    expect(cut.decision).toBe('cut')
    expect(cut.reason).toContain('`control` over `with`: 10 to 0')
  })

  it('cuts a unit that makes answers worse', async () => {
    const world = scripted({ quality: (arm, index) => (arm === 'with' && index < 9 ? 0 : 1) })

    const report = await runSkillEval({ unit: UNIT, cases: casesOf(12), ...world })

    expect(report.decision).toBe('cut')
    expect(report.comparisons[0]?.preference).toMatchObject({
      wins: 0,
      losses: 9,
      ties: 3,
      withReliablyPreferred: false,
      otherReliablyPreferred: true,
    })
    expect(report.comparisons[0]?.preference.winRate?.estimate).toBe(0)
    expect(report.reason).toContain('`without` over `with`: 9 to 0, 3 ties')
  })

  it('cuts a unit once enough cases rule out a benefit and nothing got cheaper', async () => {
    const world = scripted({ quality: () => 1, trace: () => ({ toolCalls: 5, costUsd: 0.01 }) })

    const report = await runSkillEval({ unit: UNIT, cases: casesOf(60), ...world })

    expect(report.decision).toBe('cut')
    const preference = report.comparisons[0]?.preference
    expect(preference).toMatchObject({ wins: 0, losses: 0, ties: 60, winRate: null })
    // Sixty ties bound the net preference well inside the smallest benefit that would matter.
    expect(preference?.net?.high).toBeLessThan(report.smallestBenefit)
    expect(preference?.net?.high).toBeGreaterThan(0)
    expect(report.reason).toContain('rules out a gain of 10%')
    expect(report.reason).toContain('no process measure is reliably lower')

    // Sixty ties cannot rule out a gain as small as 2% of cases: that question needs more cases.
    const strict = await runSkillEval({
      unit: UNIT,
      cases: casesOf(60),
      ...scripted({ quality: () => 1 }),
      smallestBenefit: 0.02,
    })
    expect(strict.decision).toBe('inconclusive')
    expect(strict.reason).toContain('More cases would narrow it')
  })

  it('does not cut a unit that answers no better but reliably costs less', async () => {
    const world = scripted({
      quality: () => 1,
      trace: (arm, index) => ({
        toolCalls: arm === 'with' ? 3 + (index % 2) : 6 + (index % 3),
        wallMs: 1000 + index,
      }),
    })

    const report = await runSkillEval({ unit: UNIT, cases: casesOf(60), ...world })

    expect(report.decision).toBe('inconclusive')
    const [comparison] = report.comparisons
    expect(comparison?.reliablyLower).toEqual(['toolCalls'])
    expect(comparison?.reliablyHigher).toEqual([])
    const toolCalls = comparison?.process.metricDeltas.find((delta) => delta.name === 'toolCalls')
    expect(toolCalls?.meanDelta).toBeCloseTo(-3.5, 10)
    expect(toolCalls?.bootstrapCi?.high).toBeLessThan(0)
    expect(report.reason).toContain('toolCalls is reliably lower')
    expect(report.reason).toContain('cost')
  })

  it('stays inconclusive on too few cases or a preference the interval cannot place', async () => {
    const few = await runSkillEval({
      unit: UNIT,
      cases: casesOf(4),
      ...scripted({ quality: (arm) => (arm === 'with' ? 2 : 1) }),
    })
    expect(few.decision).toBe('inconclusive')
    expect(few.comparisons[0]?.preference).toMatchObject({ wins: 4, losses: 0 })
    // The exact paired test cannot reach 95% with fewer than six pairs.
    expect(few.comparisons[0]?.preference.net).toMatchObject({ n: 4, sufficient: false })
    expect(few.reason).toBe('4 judged cases are fewer than the 6 the paired test needs.')

    // Three wins, one loss and eight ties: a lean toward `with` that twelve cases cannot settle.
    const mixed = await runSkillEval({
      unit: UNIT,
      cases: casesOf(12),
      ...scripted({
        quality: (arm, index) => (arm !== 'with' ? 1 : index < 3 ? 2 : index === 3 ? 0 : 1),
      }),
    })
    expect(mixed.decision).toBe('inconclusive')
    expect(mixed.comparisons[0]?.preference).toMatchObject({ wins: 3, losses: 1, ties: 8 })
    expect(mixed.comparisons[0]?.preference.winRate?.estimate).toBe(0.75)
    expect(mixed.reason).toContain('More cases would narrow it')
  })
})

describe('runSkillEval headroom', () => {
  it('stops before the other arms when the baseline already passes the suite', async () => {
    const world = scripted({ quality: (arm) => (arm === 'with' ? 2 : 1), pass: () => true })

    const report = await runSkillEval({ unit: UNIT, cases: casesOf(12), ...world, control: true })

    expect(report.decision).toBe('inconclusive')
    expect(report.headroom).toMatchObject({
      passed: 12,
      failed: 0,
      passRate: 1,
      verdict: 'saturated',
    })
    expect(report.reason).toContain('A suite that passes 100% is not evidence')
    expect(report.arms).toEqual(['without'])
    expect(report.comparisons).toEqual([])
    // Only the baseline was paid for: no `with` or `control` run, no judgment.
    expect(world.runs).toHaveLength(12)
    expect(world.runs.every((run) => run.arm === 'without')).toBe(true)
    expect(world.judged).toHaveLength(0)

    // Eleven of twelve is still nearly all.
    const nearly = scripted({ quality: () => 1, pass: (_arm, index) => index !== 0 })
    const nearlyAll = await runSkillEval({ unit: UNIT, cases: casesOf(12), ...nearly })
    expect(nearlyAll.headroom.verdict).toBe('saturated')
    expect(nearly.runs).toHaveLength(12)
  })

  it('stops when the baseline passes nearly none, unless the caller keeps that suite', async () => {
    const script: Script = {
      quality: (arm, index) => (arm === 'with' && index < 10 ? 2 : 1),
      pass: (arm) => arm === 'with',
    }
    const world = scripted(script)
    const stopped = await runSkillEval({ unit: UNIT, cases: casesOf(12), ...world })
    expect(stopped.decision).toBe('inconclusive')
    expect(stopped.headroom).toMatchObject({
      passed: 0,
      failed: 12,
      passRate: 0,
      verdict: 'floored',
    })
    expect(stopped.reason).toContain('`without` passes 0 of 12')
    expect(world.judged).toHaveLength(0)

    const kept = await runSkillEval({
      unit: UNIT,
      cases: casesOf(12),
      ...scripted(script),
      headroom: { floor: null },
    })
    expect(kept.headroom).toMatchObject({ verdict: 'separable', floor: null })
    expect(kept.decision).toBe('keep')
    // The pass outcomes are paired too: twelve cases went from fail to pass.
    expect(kept.comparisons[0]?.process.correctness).toMatchObject({ b10: 12, b01: 0 })
  })

  it('stops when no baseline run says whether it passed', async () => {
    const world = scripted({ quality: () => 1, pass: () => null })

    const report = await runSkillEval({ unit: UNIT, cases: casesOf(12), ...world })

    expect(report.decision).toBe('inconclusive')
    expect(report.headroom).toMatchObject({ passed: 0, failed: 0, unknown: 12, passRate: null })
    expect(report.headroom.verdict).toBe('unknown')
    expect(report.reason).toContain('headroom cannot be checked')
    expect(world.runs).toHaveLength(12)
  })
})

describe('runSkillEval judging', () => {
  const script: Script = { quality: (arm) => (arm === 'with' ? 2 : 1) }

  /** For each judgment in the order it was drawn, whether `with`'s answer was shown first. */
  async function shownFirst(seed: number): Promise<{ order: boolean[]; counted: number }> {
    const world = scripted(script)
    const report = await runSkillEval({
      unit: UNIT,
      cases: casesOf(40),
      ...world,
      seed,
      concurrency: 1,
    })
    for (const input of world.judged) {
      // The judge is given the case and two answers, and nothing that names an arm.
      expect(Object.keys(input).sort()).toEqual(['case', 'first', 'second'])
    }
    return {
      order: world.judged.map((input) => qualityOf(input.first) === 2),
      counted: report.comparisons[0]?.preference.withShownFirst ?? -1,
    }
  }

  it('shows answers unlabeled, in an order that depends on the seed alone', async () => {
    const first = await shownFirst(3)
    const again = await shownFirst(3)
    const other = await shownFirst(4)

    expect(first.order).toHaveLength(40)
    expect(again.order).toEqual(first.order)
    expect(other.order).not.toEqual(first.order)
    // Both orders occur, and the report counts what the judge was actually shown.
    expect(first.order.filter(Boolean)).toHaveLength(20)
    expect(first.counted).toBe(20)
    expect(other.counted).toBe(other.order.filter(Boolean).length)
  })

  it('does not turn a judge that favors a position into a preference for an arm', async () => {
    const world = scripted(script)

    const report = await runSkillEval({
      unit: UNIT,
      cases: casesOf(40),
      run: world.run,
      judge: async () => 'first',
      seed: 3,
    })

    // `with` is better on every case, but this judge only ever picks the first answer shown.
    expect(report.comparisons[0]?.preference).toMatchObject({
      wins: 20,
      losses: 20,
      ties: 0,
      choseFirst: 40,
      choseSecond: 0,
      withShownFirst: 20,
      withReliablyPreferred: false,
      otherReliablyPreferred: false,
    })
    expect(report.decision).toBe('inconclusive')
  })

  it('counts a failed run or judgment apart, never as a tie', async () => {
    const world = scripted({
      quality: (arm, index) => (arm === 'with' && index < 10 ? 2 : 1),
      trace: (arm, index) => (arm === 'with' && index === 7 ? { toolCalls: -1 } : { toolCalls: 2 }),
    })

    const report = await runSkillEval({
      unit: UNIT,
      cases: casesOf(12),
      run: async (testCase, arm) => {
        if (arm.arm === 'with' && testCase.index === 3) throw new Error('agent crashed')
        return world.run(testCase, arm)
      },
      judge: async (input) => {
        if (input.case.index === 5) throw new Error('judge unavailable')
        if (input.case.index === 6) return 'left' as SkillEvalPreference
        return world.judge(input)
      },
    })

    expect(report.failures).toEqual([
      { caseId: 'case-003', step: { run: 'with' }, error: 'agent crashed' },
      {
        caseId: 'case-007',
        step: { run: 'with' },
        error: 'run returned trace.toolCalls = -1, which is not a non-negative number or null',
      },
      { caseId: 'case-005', step: { judge: 'without' }, error: 'judge unavailable' },
      { caseId: 'case-006', step: { judge: 'without' }, error: 'judge returned "left"' },
    ])
    // Four of the ten cases `with` would have won were not judged: six wins, two ties.
    expect(report.comparisons[0]?.preference).toMatchObject({
      wins: 6,
      losses: 0,
      ties: 2,
      notJudged: 4,
    })
    expect(report.comparisons[0]?.preference.net?.n).toBe(8)
    // The two cases without a `with` run are reported unpaired, not dropped.
    expect(report.comparisons[0]?.process).toMatchObject({ nPairs: 10, nUnpairedBaseline: 2 })
    expect(report.decision).toBe('keep')
  })

  it('refuses unusable options before any run is paid for', async () => {
    const world = scripted({ quality: () => 1 })
    const attempt = (overrides: Record<string, unknown>) =>
      runSkillEval({ unit: UNIT, cases: casesOf(12), ...world, ...overrides })

    await expect(attempt({ control: `${UNIT.text} ${UNIT.text}` })).rejects.toThrow(
      /a control must be within a tenth of the unit's length/,
    )
    await expect(attempt({ cases: [] })).rejects.toThrow(ValidationError)
    await expect(attempt({ cases: [...casesOf(2), ...casesOf(1)] })).rejects.toThrow(
      /case id 'case-000' appears twice/,
    )
    await expect(attempt({ headroom: { ceiling: 0.5, floor: 0.6 } })).rejects.toThrow(
      /headroom\.floor/,
    )
    expect(world.runs).toHaveLength(0)

    // A caller's own control text of the right length is used as given.
    const own = 'x'.repeat(UNIT.text.length + 3)
    await attempt({ control: own })
    const controlRuns = world.runs.filter((run) => run.arm === 'control')
    expect(controlRuns).toHaveLength(12)
    expect(controlRuns.every((run) => run.text === own)).toBe(true)
  })
})

describe('skillEvalTraceFromRun', () => {
  it('reads the process measures of a run recorded in a trace store', async () => {
    const store = new InMemoryTraceStore()
    let now = 1_000
    const emitter = new TraceEmitter(store, { now: () => now, runId: 'run-1' })
    await emitter.startRun({ scenarioId: 'case-000' })
    const read = await emitter.tool({ name: 'read', toolName: 'read', args: { path: 'a.ts' } })
    now += 100
    await read.end()
    const shell = await emitter.tool({ name: 'shell', toolName: 'shell', args: { cmd: 'check' } })
    now += 100
    await shell.fail('exit 1')
    const answer = await emitter.llm({
      name: 'answer',
      model: 'gpt-4o',
      messages: [],
      inputTokens: 1000,
      outputTokens: 100,
    })
    now += 300
    await answer.end()
    await emitter.endRun({ pass: true })

    const trace = await skillEvalTraceFromRun(store, 'run-1')

    expect(trace).toMatchObject({ toolCalls: 2, toolErrors: 1, wallMs: 500 })
    // The ledger's rate for this model: $2.50 per million in, $10 per million out.
    expect(trace.costUsd).toBeCloseTo(0.0025 + 0.001, 10)

    // A response from a model with no rate makes the run's cost unknown, not smaller.
    const unpriced = new TraceEmitter(store, { now: () => now, runId: 'run-2' })
    await unpriced.startRun({ scenarioId: 'case-001' })
    const known = await unpriced.llm({ name: 'a', model: 'gpt-4o', messages: [], costUsd: 0.5 })
    await known.end()
    const unknown = await unpriced.llm({
      name: 'b',
      model: 'fixture-model-without-rate',
      messages: [],
      inputTokens: 10,
      outputTokens: 1,
    })
    await unknown.end()
    expect(await skillEvalTraceFromRun(store, 'run-2')).toEqual({
      toolCalls: 0,
      toolErrors: 0,
      wallMs: null,
      costUsd: null,
    })
    await expect(skillEvalTraceFromRun(store, 'run-3')).rejects.toThrow(/no run 'run-3'/)
  })
})
