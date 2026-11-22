/**
 * How far a profile-matrix verdict can be trusted: the familywise adjustment that turns each
 * profile's paired difference from the baseline into a verdict, and the run-to-run noise of a
 * profile run more than once. `analyzeProfileMatrix` calls both and re-exports these types.
 */

import { type RunRecord, runTaskScore } from '../../run-record'
import { holm } from '../../statistics'
import { zQuantile } from '../../statistics/internal'
import { mean } from '../../statistics/mean'
import type { ProfileMatrixProfileStats } from './profile-matrix-analysis'

/**
 * A profile against the baseline after the family adjustment. `better` and `worse`: the nominal
 * interval excludes zero and the Holm-adjusted p over the page's family is at most 1 - level.
 * `candidate`: the nominal interval excludes zero but the adjusted p does not pass.
 * `unresolved`: the nominal interval includes zero, or there is no paired case.
 */
export type ProfileMatrixVerdict = 'better' | 'worse' | 'candidate' | 'unresolved'

/** The family of profile-against-baseline comparisons the verdicts control the error over. */
export interface ProfileMatrixFamily {
  method: 'holm'
  /** Familywise error rate the verdicts control: 1 - level. */
  alpha: number
  /** Comparisons with a p-value, one per profile other than the baseline. */
  comparisons: number
}

/** A share measured on each pair of runs: its mean over the pairs, and the lowest and highest. */
export interface ProfileMatrixPairwiseShare {
  mean: number
  min: number
  max: number
}

/** How much one profile's runs differ with nothing changed between them. */
export interface ProfileMatrixRunStability {
  profileId: string
  runs: number
  /** Cases every run of this profile scored; every number below is on them. */
  n: number
  /** Each run's mean score, in run order; null when `n` is 0. */
  runQuality: { run: number; quality: number | null }[]
  /** Highest run quality minus the lowest; null when `n` is 0. */
  spread: number | null
  /** Share of cases one run got right and the other did not, over run pairs; null when `n` is 0. */
  correctnessDisagreement: ProfileMatrixPairwiseShare | null
  /** Share of the cases both runs answered where the answers differ; null without such a case. */
  answerDisagreement: ProfileMatrixPairwiseShare | null
  /**
   * Half-width of the range, at the analysis level, within which two runs of this profile land
   * on the panel's common cases with nothing changed: z·√(m / n), where m is the mean squared
   * per-case score difference between two runs (for right/wrong scores, the correctness
   * disagreement) and each case's change is taken as independent. Null without common cases.
   */
  rerunMargin: number | null
}

/** Whether an interval lies wholly above zero, wholly below it, or includes it. */
export function intervalSide(i: {
  low: number | null
  high: number | null
}): 'up' | 'down' | 'flat' {
  if (i.low !== null && i.low > 0) return 'up'
  if (i.high !== null && i.high < 0) return 'down'
  return 'flat'
}

/** The run a record belongs to: the campaign's `outcome.raw.rep`, or run 0 when absent. */
export function runOf(record: RunRecord): number {
  const rep = record.outcome.raw.rep
  return Number.isFinite(rep) ? rep! : 0
}

/**
 * Holm over every profile-against-baseline p-value on the page, so the better and worse verdicts
 * together keep the familywise error at `alpha`. A comparison without a p-value cannot pass, so
 * it stays out of the family instead of raising everyone else's bar.
 */
export function withVerdicts(
  stats: readonly ProfileMatrixProfileStats[],
  baseline: string,
  alpha: number,
): { profiles: ProfileMatrixProfileStats[]; family: ProfileMatrixFamily } {
  const tested = stats.filter((p) => typeof p.vsBaseline?.pValue === 'number')
  const { adjusted } = holm(
    tested.map((p) => p.vsBaseline!.pValue!),
    alpha,
  )
  const adjustedOf = new Map(tested.map((p, index) => [p.profileId, adjusted[index]!]))
  const profiles = stats.map((p) => {
    if (p.profileId === baseline) return p
    const adjustedPValue = adjustedOf.get(p.profileId) ?? null
    const side = p.vsBaseline ? intervalSide(p.vsBaseline) : 'flat'
    const verdict: ProfileMatrixVerdict =
      side === 'flat'
        ? 'unresolved'
        : adjustedPValue !== null && adjustedPValue <= alpha
          ? side === 'up'
            ? 'better'
            : 'worse'
          : 'candidate'
    return { ...p, adjustedPValue, verdict }
  })
  return { profiles, family: { method: 'holm', alpha, comparisons: tested.length } }
}

/**
 * Each profile with two or more runs, on the cases every one of its runs scored. A run's score
 * on a case is the mean of its records there, and its answer the last one `answerOf` returned.
 */
export function runStability(input: {
  profileIds: readonly string[]
  recordsByProfile: ReadonlyMap<string, readonly RunRecord[]>
  answerOf: ((record: RunRecord) => string | undefined) | undefined
  level: number
  passScore: number
  /** Common cases of the panel: the n the rerun margin is stated at. */
  commonCases: number
}): ProfileMatrixRunStability[] {
  const z = zQuantile(1 - (1 - input.level) / 2)
  const panelN = input.commonCases
  const right = (score: number) => score >= input.passScore
  const share = (values: number[]): ProfileMatrixPairwiseShare | null =>
    values.length
      ? { mean: mean(values), min: Math.min(...values), max: Math.max(...values) }
      : null
  return input.profileIds.flatMap((profileId) => {
    const scores = new Map<number, Map<string, number[]>>()
    const answers = new Map<number, Map<string, string>>()
    for (const record of input.recordsByProfile.get(profileId)!) {
      const run = runOf(record)
      const own = scores.get(run) ?? new Map<string, number[]>()
      scores.set(run, own)
      const score = runTaskScore(record)
      if (score === undefined) continue
      own.set(record.scenarioId, [...(own.get(record.scenarioId) ?? []), score])
      const answer = input.answerOf?.(record)
      if (answer === undefined) continue
      const given = answers.get(run) ?? new Map<string, string>()
      given.set(record.scenarioId, answer)
      answers.set(run, given)
    }
    if (scores.size < 2) return []
    const runs = [...scores.keys()].sort((a, b) => a - b)
    const scoreIn = (run: number, caseId: string) => mean(scores.get(run)!.get(caseId)!)
    const cases = [...scores.get(runs[0]!)!.keys()]
      .filter((caseId) => runs.every((run) => scores.get(run)!.has(caseId)))
      .sort()
    const n = cases.length
    const pairs = runs.flatMap((a, index) => runs.slice(index + 1).map((b) => [a, b] as const))
    const runQuality = runs.map((run) => ({
      run,
      quality: n ? mean(cases.map((caseId) => scoreIn(run, caseId))) : null,
    }))
    const qualities = runQuality.flatMap((r) => (r.quality === null ? [] : [r.quality]))
    const correctness = n
      ? pairs.map(
          ([a, b]) => cases.filter((c) => right(scoreIn(a, c)) !== right(scoreIn(b, c))).length / n,
        )
      : []
    const answered = pairs.flatMap(([a, b]) => {
      const both = cases.filter((c) => answers.get(a)?.has(c) && answers.get(b)?.has(c))
      const differ = both.filter((c) => answers.get(a)!.get(c) !== answers.get(b)!.get(c))
      return both.length ? [differ.length / both.length] : []
    })
    const squared = n
      ? mean(pairs.map(([a, b]) => mean(cases.map((c) => (scoreIn(a, c) - scoreIn(b, c)) ** 2))))
      : null
    return [
      {
        profileId,
        runs: runs.length,
        n,
        runQuality,
        spread: qualities.length ? Math.max(...qualities) - Math.min(...qualities) : null,
        correctnessDisagreement: share(correctness),
        answerDisagreement: share(answered),
        rerunMargin: squared !== null && panelN > 0 ? z * Math.sqrt(squared / panelN) : null,
      },
    ]
  })
}
