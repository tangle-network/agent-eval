/**
 * The skill eval recipe: does one unit earn its place?
 *
 * A unit is anything the caller can apply to an agent and take away again: a
 * skill, a paragraph of instructions, a profile difference. The recipe runs the
 * same real cases with the unit and without it, optionally a third time with a
 * neutral text of the same length, and reports one decision.
 *
 * It composes checks this package already owns and adds no statistic:
 *
 * | Step | Owner |
 * |---|---|
 * | Can the suite see a difference at all? | `capabilityHeadroom` over the `without` arm |
 * | Which answer is better? | the caller's judge, shown two answers with no arm label, in an order drawn from the seed |
 * | Is that preference reliable? | `decidePairedPromotion` on the paired preference, `wilson` for the win rate |
 * | Did the work change? | `comparePairedArms` over tool calls, tool errors, wall time and cost |
 *
 * Execution comes in through `run` and `judge` only. A callback that throws is
 * a failed run or a failed judgment, counted apart and never scored as a tie.
 */

import { capabilityHeadroom } from '../capability-headroom'
import { mapConcurrent } from '../concurrency'
import { errorMessage, ValidationError } from '../errors'
import {
  comparePairedArms,
  type PairedArmRow,
  type PairedArmsComparison,
  pairArms,
} from '../paired-arms'
import { decidePairedPromotion, type PairedPromotionDecision } from '../paired-promotion-decision'
import { type ProportionInterval, wilson } from '../statistics'
import { makeRng } from '../statistics/internal'

export type SkillEvalArm = 'with' | 'without' | 'control'
export type SkillEvalDecision = 'keep' | 'cut' | 'inconclusive'

/** The process measures the recipe compares between arms. */
const SKILL_EVAL_METRICS = ['toolCalls', 'toolErrors', 'wallMs', 'costUsd'] as const
export type SkillEvalMetric = (typeof SKILL_EVAL_METRICS)[number]

/** What one run did. A measure the caller could not read is null, never zero. */
export type SkillEvalTrace = Record<SkillEvalMetric, number | null>

export interface SkillEvalUnit {
  /** Names the unit in the report. */
  name: string
  /** The unit's text, when it is text. A unit that is not text is applied by `run` from the arm alone. */
  text?: string
}

/** The arm one run is for, and the text to add under it. */
export interface SkillEvalArmInput {
  arm: SkillEvalArm
  /**
   * The unit's text under `with`, the neutral text under `control`, and null
   * under `without` or when the recipe holds no text for the arm.
   */
  text: string | null
}

export interface SkillEvalRun {
  /** What the agent answered. The judge sees this and nothing else from the run. */
  answer: string
  /** Whether the answer passes the case's own check; null when that is not known. */
  pass: boolean | null
  trace: SkillEvalTrace
}

export interface SkillEvalJudgeInput<TCase> {
  case: TCase
  /** Two answers to the case. Which arm wrote which is not given. */
  first: string
  second: string
}

export type SkillEvalPreference = 'first' | 'second' | 'tie'

export interface SkillEvalOptions<TCase extends { id: string }> {
  unit: SkillEvalUnit
  /** Real cases, each with a stable id. */
  cases: readonly TCase[]
  /** Runs one case under one arm and returns the answer and what the run did. */
  run: (testCase: TCase, arm: SkillEvalArmInput) => Promise<SkillEvalRun>
  /** Says which of two unlabeled answers is better. */
  judge: (input: SkillEvalJudgeInput<TCase>) => Promise<SkillEvalPreference>
  /**
   * Run a `control` arm. `true` adds a neutral text of the unit's length, or no
   * text when the unit has none and `run` applies its own control. A string is
   * the caller's control text, which must be within a tenth of the unit's length.
   */
  control?: boolean | string
  /** Seeds the order answers are shown in and every bootstrap. Default 1. */
  seed?: number
  /**
   * The share of `without` cases with a known outcome that may pass. At or
   * above `ceiling` (default 0.9), or at or below `floor` (default 0.1), the
   * suite cannot separate the arms. `floor: null` keeps a suite the baseline
   * fails throughout, for a unit meant to make those cases passable.
   */
  headroom?: { ceiling?: number; floor?: number | null }
  /** The smallest net preference for `with`, as a share of cases, that would matter. Default 0.1. */
  smallestBenefit?: number
  /** Confidence level of every interval. Default 0.95. */
  confidence?: number
  /** Runs and judgments in flight at once. Default 4. */
  concurrency?: number
}

export interface SkillEvalHeadroom {
  /** `without` outcomes over the cases. */
  passed: number
  failed: number
  unknown: number
  /** passed / (passed + failed); null when no outcome is known. */
  passRate: number | null
  ceiling: number
  floor: number | null
  /** `separable` is the only verdict under which the other arms run. */
  verdict: 'separable' | 'saturated' | 'floored' | 'unknown'
}

export interface SkillEvalPreferenceResult {
  /** Judged cases where `with`'s answer was preferred, the other arm's was, or neither. */
  wins: number
  losses: number
  ties: number
  /** Cases with a failed run on either side or a failed judgment: not compared, not a tie. */
  notJudged: number
  /** wins / (wins + losses) with its Wilson interval; null when no judgment chose a side. */
  winRate: ProportionInterval | null
  /**
   * The paired decision on net preference, (wins - losses) / judged cases:
   * `promote` is true when `with` is reliably preferred. null when nothing was judged.
   */
  net: PairedPromotionDecision | null
  withReliablyPreferred: boolean
  otherReliablyPreferred: boolean
  /** How often the judge chose the first or the second answer shown: a reading of position preference. */
  choseFirst: number
  choseSecond: number
  /** Judged cases where `with`'s answer was shown first. */
  withShownFirst: number
}

export interface SkillEvalComparison {
  against: Exclude<SkillEvalArm, 'with'>
  preference: SkillEvalPreferenceResult
  /** `with` minus the other arm on the same cases: pass outcomes and each process measure. */
  process: PairedArmsComparison
  /** Process measures reliably lower, and reliably higher, under `with`. */
  reliablyLower: SkillEvalMetric[]
  reliablyHigher: SkillEvalMetric[]
}

export interface SkillEvalFailure {
  caseId: string
  /** The run that failed, or the judgment against that arm. */
  step: { run: SkillEvalArm } | { judge: Exclude<SkillEvalArm, 'with'> }
  error: string
}

export interface SkillEvalReport {
  unit: string
  cases: number
  seed: number
  confidence: number
  smallestBenefit: number
  /** Arms that ran. Only `without` when the headroom check stopped the eval. */
  arms: SkillEvalArm[]
  headroom: SkillEvalHeadroom
  /** `with` against `without`, then against `control` when it ran. Empty when stopped at headroom. */
  comparisons: SkillEvalComparison[]
  decision: SkillEvalDecision
  /** Which clause of `rule` decided, with its numbers. */
  reason: string
  /** The decision rule, as applied with this eval's settings. */
  rule: string[]
  failures: SkillEvalFailure[]
}

const NEUTRAL_SENTENCE =
  'This paragraph carries no instruction for the task. Read it and continue as you would without it. '

/**
 * A text of exactly `length` characters that asks for nothing: the control for
 * a unit of that length, so a gain from added reading is told apart from a gain
 * from what the unit says.
 */
function neutralControlText(length: number): string {
  return NEUTRAL_SENTENCE.repeat(Math.ceil(length / NEUTRAL_SENTENCE.length)).slice(0, length)
}

interface Settings {
  seed: number
  confidence: number
  smallestBenefit: number
  concurrency: number
  ceiling: number
  floor: number | null
  /** undefined: no control arm. null: the arm runs and `run` applies its own control. */
  controlText: string | null | undefined
}

function invalidOptions(message: string): never {
  throw new ValidationError(`runSkillEval: ${message}`)
}

function settingsOf<TCase extends { id: string }>(options: SkillEvalOptions<TCase>): Settings {
  if (options.cases.length === 0) invalidOptions('no cases supplied')
  const ids = new Set<string>()
  for (const testCase of options.cases) {
    if (typeof testCase.id !== 'string' || testCase.id === '') {
      invalidOptions('every case needs an id')
    }
    if (ids.has(testCase.id)) invalidOptions(`case id '${testCase.id}' appears twice`)
    ids.add(testCase.id)
  }
  const seed = options.seed ?? 1
  if (!Number.isSafeInteger(seed)) invalidOptions(`seed must be an integer, got ${seed}`)
  const confidence = options.confidence ?? 0.95
  if (!(confidence > 0 && confidence < 1)) {
    invalidOptions(`confidence must be in (0, 1), got ${confidence}`)
  }
  const smallestBenefit = options.smallestBenefit ?? 0.1
  if (!(smallestBenefit > 0 && smallestBenefit <= 1)) {
    invalidOptions(`smallestBenefit must be in (0, 1], got ${smallestBenefit}`)
  }
  const concurrency = options.concurrency ?? 4
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    invalidOptions(`concurrency must be a positive integer, got ${concurrency}`)
  }
  const ceiling = options.headroom?.ceiling ?? 0.9
  const floor = options.headroom?.floor === undefined ? 0.1 : options.headroom.floor
  if (!(ceiling > 0 && ceiling <= 1)) {
    invalidOptions(`headroom.ceiling must be in (0, 1], got ${ceiling}`)
  }
  if (floor !== null && !(floor >= 0 && floor < ceiling)) {
    invalidOptions(`headroom.floor must be in [0, ceiling), got ${floor}`)
  }

  const unitText = options.unit.text
  let controlText: string | null | undefined
  if (options.control === true) {
    controlText = unitText === undefined ? null : neutralControlText(unitText.length)
  } else if (typeof options.control === 'string') {
    controlText = options.control
    if (
      unitText !== undefined &&
      Math.abs(controlText.length - unitText.length) > unitText.length / 10
    ) {
      invalidOptions(
        `the control text is ${controlText.length} characters and the unit is ${unitText.length}: a control must be within a tenth of the unit's length`,
      )
    }
  }
  return { seed, confidence, smallestBenefit, concurrency, ceiling, floor, controlText }
}

type RunOutcome = { succeeded: true; value: SkillEvalRun } | { succeeded: false; error: string }

/** A run result as the recipe will use it, or the reason it cannot. */
function checkedRun(value: SkillEvalRun): RunOutcome {
  const invalid = (message: string): RunOutcome => ({
    succeeded: false,
    error: `run returned ${message}`,
  })
  if (typeof value?.answer !== 'string') return invalid('no answer text')
  if (value.pass !== null && typeof value.pass !== 'boolean') {
    return invalid('a pass that is not true, false or null')
  }
  const trace: Partial<SkillEvalTrace> = {}
  for (const metric of SKILL_EVAL_METRICS) {
    const reading = value.trace?.[metric] ?? null
    if (reading !== null && !(Number.isFinite(reading) && reading >= 0)) {
      return invalid(`trace.${metric} = ${reading}, which is not a non-negative number or null`)
    }
    trace[metric] = reading
  }
  return {
    succeeded: true,
    value: { answer: value.answer, pass: value.pass, trace: trace as SkillEvalTrace },
  }
}

function headroomOf(
  outcomes: readonly RunOutcome[],
  ids: readonly string[],
  settings: Settings,
): SkillEvalHeadroom {
  const { summary } = capabilityHeadroom(
    outcomes.map((outcome, index) => ({
      taskId: ids[index] as string,
      baselineOutcome:
        !outcome.succeeded || outcome.value.pass === null
          ? 'unknown'
          : outcome.value.pass
            ? 'pass'
            : 'fail',
    })),
  )
  // One run per case, so a case the baseline passes is saturated and one it fails is a gap.
  const passed = summary.tasksSaturated
  const failed = summary.tasksWithGap
  const passRate = passed + failed === 0 ? null : passed / (passed + failed)
  const verdict =
    passRate === null
      ? 'unknown'
      : passRate >= settings.ceiling
        ? 'saturated'
        : settings.floor !== null && passRate <= settings.floor
          ? 'floored'
          : 'separable'
  return {
    passed,
    failed,
    unknown: summary.tasksUnknown,
    passRate,
    ceiling: settings.ceiling,
    floor: settings.floor,
    verdict,
  }
}

interface Judgment {
  withFirst: boolean
  /** null when the pair was not judged. */
  choice: SkillEvalPreference | null
}

function preferenceOf(
  judgments: readonly Judgment[],
  settings: Settings,
): SkillEvalPreferenceResult {
  const withPreferred: number[] = []
  const otherPreferred: number[] = []
  let ties = 0
  let notJudged = 0
  let choseFirst = 0
  let choseSecond = 0
  let withShownFirst = 0
  for (const { withFirst, choice } of judgments) {
    if (choice === null) {
      notJudged += 1
      continue
    }
    if (withFirst) withShownFirst += 1
    if (choice === 'tie') {
      ties += 1
      withPreferred.push(0)
      otherPreferred.push(0)
      continue
    }
    if (choice === 'first') choseFirst += 1
    else choseSecond += 1
    const withWon = (choice === 'first') === withFirst
    withPreferred.push(withWon ? 1 : 0)
    otherPreferred.push(withWon ? 0 : 1)
  }
  const wins = withPreferred.reduce((sum, value) => sum + value, 0)
  const losses = otherPreferred.reduce((sum, value) => sum + value, 0)
  const decide = (before: number[], after: number[]): PairedPromotionDecision =>
    decidePairedPromotion(before, after, { binaryScale: 1, confidence: settings.confidence })
  const judged = withPreferred.length > 0
  const net = judged ? decide(otherPreferred, withPreferred) : null
  return {
    wins,
    losses,
    ties,
    notJudged,
    winRate: wins + losses === 0 ? null : wilson(wins, wins + losses, settings.confidence),
    net,
    withReliablyPreferred: net?.promote ?? false,
    otherReliablyPreferred: judged && decide(withPreferred, otherPreferred).promote,
    choseFirst,
    choseSecond,
    withShownFirst,
  }
}

function armRows(arm: SkillEvalArm, outcomes: readonly RunOutcome[], ids: readonly string[]) {
  const rows: PairedArmRow[] = []
  outcomes.forEach((outcome, index) => {
    if (!outcome.succeeded) return
    rows.push({
      pairKey: ids[index] as string,
      arm,
      pass: outcome.value.pass,
      metrics: outcome.value.trace,
    })
  })
  return rows
}

function processOf(
  against: Exclude<SkillEvalArm, 'with'>,
  rows: readonly PairedArmRow[],
  settings: Settings,
): Pick<SkillEvalComparison, 'process' | 'reliablyLower' | 'reliablyHigher'> {
  const arms = { baselineArm: against, treatmentArm: 'with' }
  const process = comparePairedArms(rows, {
    ...arms,
    metricNames: [...SKILL_EVAL_METRICS],
    bootstrap: { statistic: 'mean', seed: settings.seed, confidence: settings.confidence },
  })
  const { pairs } = pairArms(rows, arms)
  const reliablyLower: SkillEvalMetric[] = []
  const reliablyHigher: SkillEvalMetric[] = []
  for (const metric of SKILL_EVAL_METRICS) {
    const other: number[] = []
    const mine: number[] = []
    for (const pair of pairs) {
      const before = pair.baseline.metrics?.[metric]
      const after = pair.treatment.metrics?.[metric]
      if (before == null || after == null) continue
      other.push(before)
      mine.push(after)
    }
    if (mine.length === 0) continue
    // A measure is lower under `with` when the other arm's reading reliably exceeds it.
    const reliably = (before: number[], after: number[]): boolean =>
      decidePairedPromotion(before, after, {
        continuous: true,
        confidence: settings.confidence,
        seed: settings.seed,
      }).promote
    if (reliably(mine, other)) reliablyLower.push(metric)
    else if (reliably(other, mine)) reliablyHigher.push(metric)
  }
  return { process, reliablyLower, reliablyHigher }
}

const percent = (share: number): string => `${Math.round(share * 1000) / 10}%`

function ruleOf(settings: Settings, control: boolean): string[] {
  const level = percent(settings.confidence)
  const floor = settings.floor === null ? '' : `, or at most ${percent(settings.floor)},`
  return [
    `A suite that passes 100% is not evidence. When \`without\` passes at least ${percent(settings.ceiling)}${floor} of the cases ` +
      `with a known outcome, or no outcome is known, the suite cannot separate the arms: inconclusive, and no other arm runs.`,
    `Cut when blind judges reliably prefer \`without\`${control ? ' or the control' : ''} over \`with\`.`,
    `Keep when blind judges reliably prefer \`with\` over \`without\`${control ? ', and over the control' : ''}.`,
    `Cut when the comparison with \`without\` rules out a net preference for \`with\` of ${percent(settings.smallestBenefit)} of ` +
      `cases and no process measure is reliably lower under \`with\`.`,
    'Otherwise inconclusive.',
    `Reliably preferred: the ${level} paired interval on (wins - losses) / judged cases excludes zero, the exact test agrees, and ` +
      `enough cases were judged for that test.`,
  ]
}

function decide(
  comparisons: readonly SkillEvalComparison[],
  settings: Settings,
): Pick<SkillEvalReport, 'decision' | 'reason'> {
  const worse = comparisons.find((comparison) => comparison.preference.otherReliablyPreferred)
  if (worse !== undefined) {
    const { wins, losses, ties } = worse.preference
    return {
      decision: 'cut',
      reason: `Blind judges reliably prefer \`${worse.against}\` over \`with\`: ${losses} to ${wins}, ${ties} ties.`,
    }
  }
  const [baseline, control] = comparisons as [SkillEvalComparison, SkillEvalComparison?]
  const { preference } = baseline
  const tally = `${preference.wins} to ${preference.losses}, ${preference.ties} ties`
  if (preference.withReliablyPreferred) {
    if (control === undefined || control.preference.withReliablyPreferred) {
      return {
        decision: 'keep',
        reason:
          `Blind judges reliably prefer \`with\` over \`without\` ` +
          `(${tally})${
            control === undefined
              ? ''
              : ` and over the control (${control.preference.wins} to ${control.preference.losses}, ${control.preference.ties} ties)`
          }.`,
      }
    }
    return {
      decision: 'inconclusive',
      reason:
        `Blind judges prefer \`with\` over \`without\` (${tally}) but not reliably over the control (${control.preference.wins} to ` +
        `${control.preference.losses}, ${control.preference.ties} ties): the gain may come from added text, not from what the unit ` +
        `says.`,
    }
  }
  const { net } = preference
  if (net === null) {
    return { decision: 'inconclusive', reason: 'No pair of answers was judged.' }
  }
  if (!net.sufficient) {
    return {
      decision: 'inconclusive',
      reason: `${net.n} judged cases are fewer than the ${net.minimumPairs} the paired test needs.`,
    }
  }
  const interval = `${percent(net.low)} to ${percent(net.high)}`
  if (net.high < settings.smallestBenefit) {
    if (baseline.reliablyLower.length === 0) {
      return {
        decision: 'cut',
        reason:
          `The net preference for \`with\` is ${interval} (${tally}), which rules out a gain of ${percent(settings.smallestBenefit)}, ` +
          `and no process measure is reliably lower.`,
      }
    }
    return {
      decision: 'inconclusive',
      reason:
        `Answers are not preferred (net ${interval}; ${tally}), but ${baseline.reliablyLower.join(', ')} ` +
        `${baseline.reliablyLower.length === 1 ? 'is' : 'are'} reliably lower under \`with\`: the unit may earn its place on cost, ` +
        `which this rule does not decide.`,
    }
  }
  return {
    decision: 'inconclusive',
    reason:
      `The net preference for \`with\` is ${interval} (${tally}): it includes both no preference and a gain of ` +
      `${percent(settings.smallestBenefit)}. More cases would narrow it.`,
  }
}

/**
 * Run the skill eval and return one decision with its evidence.
 *
 * `without` runs first on every case. When it already passes nearly all or
 * nearly none of them, the eval stops there: the remaining arms would cost runs
 * and could not change the answer. Otherwise `with` runs, then `control` when
 * asked for, and each pair of answers goes to the judge once, unlabeled, in an
 * order drawn from the seed before any judgment starts.
 *
 * Throws `ValidationError` on unusable options, before any callback runs.
 */
export async function runSkillEval<TCase extends { id: string }>(
  options: SkillEvalOptions<TCase>,
): Promise<SkillEvalReport> {
  const settings = settingsOf(options)
  const { cases } = options
  const ids = cases.map((testCase) => testCase.id)
  const failures: SkillEvalFailure[] = []

  const runArm = async (arm: SkillEvalArm, text: string | null): Promise<RunOutcome[]> => {
    const outcomes = await mapConcurrent(
      cases,
      settings.concurrency,
      async (testCase): Promise<RunOutcome> => {
        try {
          return checkedRun(await options.run(testCase, { arm, text }))
        } catch (error) {
          return { succeeded: false, error: errorMessage(error) }
        }
      },
    )
    outcomes.forEach((outcome, index) => {
      if (!outcome.succeeded) {
        failures.push({ caseId: ids[index] as string, step: { run: arm }, error: outcome.error })
      }
    })
    return outcomes
  }

  const control = settings.controlText !== undefined
  const report = (
    arms: SkillEvalArm[],
    headroom: SkillEvalHeadroom,
    comparisons: SkillEvalComparison[],
    verdict: Pick<SkillEvalReport, 'decision' | 'reason'>,
  ): SkillEvalReport => ({
    unit: options.unit.name,
    cases: cases.length,
    seed: settings.seed,
    confidence: settings.confidence,
    smallestBenefit: settings.smallestBenefit,
    arms,
    headroom,
    comparisons,
    ...verdict,
    rule: ruleOf(settings, control),
    failures,
  })

  const without = await runArm('without', null)
  const headroom = headroomOf(without, ids, settings)
  if (headroom.verdict !== 'separable') {
    const known = headroom.passed + headroom.failed
    const reason =
      headroom.verdict === 'unknown'
        ? `No \`without\` run reported pass or fail, so headroom cannot be checked.`
        : `\`without\` passes ${headroom.passed} of ${known} cases with a known outcome: the suite cannot separate the arms. ` +
          `${
            headroom.verdict === 'saturated'
              ? 'A suite that passes 100% is not evidence; add cases the baseline fails.'
              : 'Add cases the baseline can pass, or set headroom.floor to null for a unit meant to make these passable.'
          }`
    return report(['without'], headroom, [], { decision: 'inconclusive', reason })
  }

  const treated = await runArm('with', options.unit.text ?? null)
  const others: Array<{ against: Exclude<SkillEvalArm, 'with'>; outcomes: RunOutcome[] }> = [
    { against: 'without', outcomes: without },
  ]
  if (settings.controlText !== undefined) {
    others.push({ against: 'control', outcomes: await runArm('control', settings.controlText) })
  }

  // Every order is drawn before any judgment starts, so it depends on the seed alone.
  const draw = makeRng(settings.seed)
  const pairs = others.flatMap(({ against, outcomes }) =>
    cases.map((testCase, index) => ({
      against,
      testCase,
      mine: treated[index] as RunOutcome,
      theirs: outcomes[index] as RunOutcome,
      withFirst: draw() < 0.5,
    })),
  )
  const judged = await mapConcurrent(
    pairs,
    settings.concurrency,
    async (pair): Promise<{ choice: SkillEvalPreference | null; error?: string }> => {
      if (!pair.mine.succeeded || !pair.theirs.succeeded) return { choice: null }
      const [first, second] = pair.withFirst
        ? [pair.mine.value.answer, pair.theirs.value.answer]
        : [pair.theirs.value.answer, pair.mine.value.answer]
      try {
        const choice = await options.judge({ case: pair.testCase, first, second })
        if (choice !== 'first' && choice !== 'second' && choice !== 'tie') {
          return { choice: null, error: `judge returned ${JSON.stringify(choice)}` }
        }
        return { choice }
      } catch (error) {
        return { choice: null, error: errorMessage(error) }
      }
    },
  )
  judged.forEach((judgment, index) => {
    const pair = pairs[index] as (typeof pairs)[number]
    if (judgment.error !== undefined) {
      failures.push({
        caseId: pair.testCase.id,
        step: { judge: pair.against },
        error: judgment.error,
      })
    }
  })

  const withRows = armRows('with', treated, ids)
  const comparisons = others.map(({ against, outcomes }, position): SkillEvalComparison => {
    const from = position * cases.length
    const judgments = pairs.slice(from, from + cases.length).map((pair, index) => ({
      withFirst: pair.withFirst,
      choice: (judged[from + index] as (typeof judged)[number]).choice,
    }))
    return {
      against,
      preference: preferenceOf(judgments, settings),
      ...processOf(against, [...armRows(against, outcomes, ids), ...withRows], settings),
    }
  })

  return report(
    ['without', 'with', ...(control ? (['control'] as const) : [])],
    headroom,
    comparisons,
    decide(comparisons, settings),
  )
}
