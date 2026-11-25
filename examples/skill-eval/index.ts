/**
 * Skill eval: does one unit earn its place?
 *
 * `runSkillEval` runs the same cases with a unit and without it, then a third
 * time with a neutral text of the same length. A judge sees each pair of
 * answers with no arm label, in an order drawn from the seed. The report gives
 * one decision (keep, cut or inconclusive) and the rule that produced it.
 *
 * The agent and the judge here are simulated so the example runs offline and
 * prints the same report every time. In real use, `run` starts your agent on
 * the case with the arm's text applied and returns its answer and what the run
 * did; `judge` asks a model which of two answers is better.
 *
 * Run with:
 *   pnpm tsx examples/skill-eval/index.ts
 */

import { strict as assert } from 'node:assert'
import {
  runSkillEval,
  type SkillEvalArmInput,
  type SkillEvalJudgeInput,
  type SkillEvalMetric,
  type SkillEvalPreference,
  type SkillEvalReport,
  type SkillEvalRun,
} from '../../src/index'

/** How the simulated agent does on a case: alone, only with the unit, or not at all. */
type Reach = 'alone' | 'with-unit' | 'never'

interface Case {
  id: string
  question: string
  correct: string
  reach: Reach
}

const UNIT = {
  name: 'run-the-checks',
  text: 'Before you answer, run the checks for the change and quote their result. If a check fails, say which one and stop.',
}

function buildCases(reaches: readonly Reach[]): Case[] {
  return reaches.map((reach, index) => ({
    id: `case-${String(index + 1).padStart(2, '0')}`,
    question: `Is change ${index + 1} safe to merge?`,
    correct: `Change ${index + 1}: the checks pass, merge it.`,
    reach,
  }))
}

/** A stand-in for an agent run. The unit helps on the cases marked `with-unit` and saves a few tool calls. */
async function run(testCase: Case, arm: SkillEvalArmInput): Promise<SkillEvalRun> {
  const index = Number(testCase.id.slice(-2))
  const helped = arm.arm === 'with'
  const pass = testCase.reach === 'alone' || (testCase.reach === 'with-unit' && helped)
  const toolCalls = helped ? 4 + (index % 2) : 6 + (index % 3)
  return {
    answer: pass ? testCase.correct : `Change ${index}: looks fine.`,
    pass,
    trace: {
      toolCalls,
      toolErrors: helped ? 0 : index % 2,
      wallMs: toolCalls * 1500 + (arm.text?.length ?? 0),
      costUsd: toolCalls * 0.004 + (arm.text?.length ?? 0) * 0.00001,
    },
  }
}

/** A stand-in for a model judge: it prefers the answer that states the checked result. */
async function judge({
  case: testCase,
  first,
  second,
}: SkillEvalJudgeInput<Case>): Promise<SkillEvalPreference> {
  const firstRight = first === testCase.correct
  const secondRight = second === testCase.correct
  if (firstRight === secondRight) return 'tie'
  return firstRight ? 'first' : 'second'
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

function print(title: string, report: SkillEvalReport): void {
  const { headroom } = report
  console.log(`\n== ${title} ==`)
  console.log(`unit: ${report.unit}; ${report.cases} cases; arms run: ${report.arms.join(', ')}`)
  console.log(
    `headroom: \`without\` passes ${headroom.passed} of ${headroom.passed + headroom.failed} (${headroom.verdict})`,
  )
  for (const comparison of report.comparisons) {
    const { preference } = comparison
    const rate =
      preference.winRate === null
        ? 'no decided judgment'
        : `${percent(preference.winRate.estimate)} [${percent(preference.winRate.lower)}, ${percent(preference.winRate.upper)}]`
    console.log(
      `with vs ${comparison.against}: ${preference.wins} wins, ${preference.losses} losses, ${preference.ties} ties; win rate ${rate}`,
    )
    for (const delta of comparison.process.metricDeltas) {
      const mean = delta.meanDelta === null ? 'no reading' : delta.meanDelta.toFixed(3)
      const metric = delta.name as SkillEvalMetric
      const reliable = comparison.reliablyLower.includes(metric)
        ? ' (reliably lower)'
        : comparison.reliablyHigher.includes(metric)
          ? ' (reliably higher)'
          : ''
      console.log(`  ${delta.name}: mean change ${mean} over ${delta.n} cases${reliable}`)
    }
  }
  console.log(`decision: ${report.decision}`)
  console.log(`reason: ${report.reason}`)
}

async function main(): Promise<void> {
  // A suite with room to move: the baseline passes 10 of 24, the unit reaches 9 more.
  const mixed = buildCases([
    ...Array<Reach>(10).fill('alone'),
    ...Array<Reach>(9).fill('with-unit'),
    ...Array<Reach>(5).fill('never'),
  ])
  const kept = await runSkillEval({ unit: UNIT, cases: mixed, run, judge, control: true, seed: 7 })
  print('a suite that can separate the arms', kept)
  console.log('rule:')
  for (const clause of kept.rule) console.log(`  - ${clause}`)
  assert.equal(kept.decision, 'keep')

  // The same unit on cases the baseline already passes: the eval stops after one arm.
  const easy = buildCases(Array<Reach>(12).fill('alone'))
  const stopped = await runSkillEval({
    unit: UNIT,
    cases: easy,
    run,
    judge,
    control: true,
    seed: 7,
  })
  print('a suite the baseline already passes', stopped)
  assert.equal(stopped.decision, 'inconclusive')
  assert.deepEqual(stopped.arms, ['without'])
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
