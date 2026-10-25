/**
 * Judge-panel calibration: score a hand-graded gold set with every judge model
 * on a panel, under one weighted rubric, and measure each (judge × dimension)
 * against the human grades with `calibrateJudge`.
 *
 * The caller owns the domain: the rubric text and weights, the system prompt,
 * the gold items and the judge list. This module owns the mechanics every
 * product repeats — the rubric prompt, the JSON call with retries, the
 * sequential (item × judge) sweep, null-grade handling, and the per-cell
 * calibration — plus `gateJudgeCalibration`, the pass/warn/fail rule over the
 * resulting cells.
 *
 * Calls run one at a time. Subscription bridges serialise per subprocess, and
 * concurrent requests from a full panel get killed under load.
 *
 * A gold cell with a null or missing human grade is still scored (the judge's
 * score lands in `rawScores`, useful for inter-judge agreement) but never
 * enters that dimension's calibration.
 */

import {
  type CalibrationResult,
  type CandidateScore,
  calibrateJudge,
  type GoldenItem,
} from '../judge-calibration'
import { withJudgeRetry } from '../judge-retry'
import { callLlmJson, type LlmClientOptions } from '../llm-client'

/** One rubric dimension: the guide the judge scores against and its weight in the composite. */
export interface RubricDimensionGuide {
  weight: number
  guide: string
}

export interface JudgeCalibrationGoldItem<D extends string> {
  id: string
  /** Text after `Scenario:` in the judge prompt. Defaults to `id`. */
  scenarioLabel?: string
  /** The input the candidate answered. */
  scenario: string
  /** The output the judges score. */
  candidateOutput: string
  /** Human grade per dimension in [0,1]. `null` (whole item or one dimension)
   *  means not graded: the item is still judged but excluded from calibration. */
  humanGrade: Partial<Record<D, number | null>> | null
}

export interface JudgePanelPrompt {
  /** The judge's system prompt. */
  system: string
  /** Line above the rubric. Default: score each dimension in [0,1]. */
  rubricHeading?: string
  /** Line above the candidate output. Default `Candidate output to score:`. */
  candidateHeading?: string
  /** Candidate output is cut to this many characters. Default 12000. */
  maxCandidateChars?: number
  /** Lines after the JSON-shape instruction. */
  closingLines?: readonly string[]
}

export interface CalibrateJudgePanelInput<D extends string> {
  rubric: Readonly<Record<D, RubricDimensionGuide>>
  /** Dimensions to score, in prompt order. Defaults to the rubric's keys. */
  dimensions?: readonly D[]
  items: readonly JudgeCalibrationGoldItem<D>[]
  judges: readonly string[]
  /** Endpoint and credential for every judge call. */
  llm: LlmClientOptions
  prompt: JudgePanelPrompt
  /** Default 1200. */
  maxTokens?: number
  /** Per-attempt timeout. Default 300000. */
  timeoutMs?: number
  /** Attempts per (item × judge); every error is retried. Default 3. */
  maxAttempts?: number
  /** Progress lines (one per item and judge, then the metrics table). */
  log?: (line: string) => void
}

/** A judge's calibration on one dimension. `golden` and `scores` hold the same
 *  items: the human-graded ones this judge scored. */
export interface JudgeDimensionCalibration {
  calibration: CalibrationResult
  golden: GoldenItem[]
  scores: CandidateScore[]
}

/** What one judge returned for one item: a score per dimension and its rationale. */
export type JudgePanelOutput<D extends string> = Partial<Record<D, number>> & { rationale?: string }

export interface JudgePanelCalibration<D extends string> {
  judges: string[]
  dimensions: D[]
  perJudge: Record<string, Record<D, JudgeDimensionCalibration>>
  /** Every score each judge returned, graded items or not, clamped to [0,1]. */
  rawScores: Record<string, Record<D, CandidateScore[]>>
  /** Parsed judge output per item; `null` when every attempt failed. */
  outputs: Record<string, Record<string, JudgePanelOutput<D> | null>>
  /** Item ids with no human grade, per dimension. */
  ungradedItems: Record<D, string[]>
  /** (judge × item) cells where every attempt failed. */
  failures: Array<{ judge: string; itemId: string; errors: string[] }>
  elapsedMs: number
}

const DEFAULT_RUBRIC_HEADING =
  'Rubric (score each dimension in [0,1]; 1 = perfectly satisfies the guide, 0 = fails):'

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function humanScore<D extends string>(item: JudgeCalibrationGoldItem<D>, d: D): number | null {
  const v = item.humanGrade?.[d]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function shortModel(model: string): string {
  return (model.split('/').pop() ?? model).padEnd(28)
}

function judgeUserPrompt<D extends string>(
  input: CalibrateJudgePanelInput<D>,
  dimensions: readonly D[],
  item: JudgeCalibrationGoldItem<D>,
): string {
  const rubricLines = dimensions
    .map((d) => `- ${d} (weight ${input.rubric[d].weight}): ${input.rubric[d].guide}`)
    .join('\n')
  const jsonShape = `{${dimensions.map((d) => `"${d}":number`).join(',')},"rationale":string}`
  return [
    `Scenario: ${item.scenarioLabel ?? item.id}`,
    `Input: ${item.scenario}`,
    '',
    input.prompt.rubricHeading ?? DEFAULT_RUBRIC_HEADING,
    rubricLines,
    '',
    input.prompt.candidateHeading ?? 'Candidate output to score:',
    '---',
    item.candidateOutput.slice(0, input.prompt.maxCandidateChars ?? 12_000),
    '---',
    '',
    `Respond ONLY with a JSON object exactly of shape: ${jsonShape}.`,
    ...(input.prompt.closingLines ?? []),
  ].join('\n')
}

/** Run every judge on every gold item and calibrate each (judge × dimension). */
export async function calibrateJudgePanel<D extends string>(
  input: CalibrateJudgePanelInput<D>,
): Promise<JudgePanelCalibration<D>> {
  const dimensions = [...(input.dimensions ?? (Object.keys(input.rubric) as D[]))]
  const judges = [...input.judges]
  const log = input.log ?? (() => {})
  const perDim = <T>(make: () => T) =>
    Object.fromEntries(dimensions.map((d) => [d, make()])) as Record<D, T>

  const rawScores: JudgePanelCalibration<D>['rawScores'] = {}
  const outputs: JudgePanelCalibration<D>['outputs'] = {}
  const goldenByJudge: Record<string, Record<D, GoldenItem[]>> = {}
  const scoresByJudge: Record<string, Record<D, CandidateScore[]>> = {}
  for (const judge of judges) {
    rawScores[judge] = perDim(() => [] as CandidateScore[])
    outputs[judge] = {}
    goldenByJudge[judge] = perDim(() => [] as GoldenItem[])
    scoresByJudge[judge] = perDim(() => [] as CandidateScore[])
  }
  const ungradedItems = perDim(() => [] as string[])
  for (const item of input.items) {
    for (const d of dimensions) if (humanScore(item, d) === null) ungradedItems[d].push(item.id)
  }
  const failures: JudgePanelCalibration<D>['failures'] = []

  const startedAt = Date.now()
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i] as JudgeCalibrationGoldItem<D>
    log(`  [${(i + 1).toString().padStart(2)}/${input.items.length}] ${item.id}`)
    const userPrompt = judgeUserPrompt(input, dimensions, item)
    for (const judge of judges) {
      const outcome = await withJudgeRetry(
        async (_model, signal) =>
          (
            await callLlmJson<JudgePanelOutput<D>>(
              {
                model: judge,
                messages: [
                  { role: 'system', content: input.prompt.system },
                  { role: 'user', content: userPrompt },
                ],
                jsonMode: true,
                temperature: 0,
                maxTokens: input.maxTokens ?? 1200,
                timeoutMs: input.timeoutMs ?? 300_000,
              },
              { ...input.llm, signal },
            )
          ).value,
        {
          maxAttempts: input.maxAttempts ?? 3,
          timeoutMs: input.timeoutMs ?? 300_000,
          isRetryable: () => true,
          backoffMs: (attempt) => 2_000 * (attempt + 1),
        },
      )
      const out = outcome.succeeded ? outcome.value : null
      outputs[judge]![item.id] = out
      if (!out) {
        const errors = outcome.attemptErrors.map((e) => e.error)
        failures.push({ judge, itemId: item.id, errors })
        log(`        ${shortModel(judge)} - FAILED (${errors.at(-1) ?? 'no attempt'})`)
        continue
      }
      let judged = 0
      let expected = 0
      let covered = 0
      for (const d of dimensions) {
        const score = clampUnit(Number((out as Record<string, unknown>)[d]))
        rawScores[judge]![d].push({ itemId: item.id, score })
        const human = humanScore(item, d)
        if (human === null) continue
        goldenByJudge[judge]![d].push({ itemId: item.id, humanScore: human })
        scoresByJudge[judge]![d].push({ itemId: item.id, score })
        const weight = input.rubric[d].weight
        judged += score * weight
        expected += human * weight
        covered += weight
      }
      const pct = (n: number) => `${(n * 100).toFixed(0)}%`
      log(
        covered > 0
          ? `        ${shortModel(judge)} judged=${pct(judged / covered)} expected=${pct(expected / covered)} delta=${pct((judged - expected) / covered)} cover=${pct(covered)}`
          : `        ${shortModel(judge)} judged (ungraded item)`,
      )
    }
  }
  const elapsedMs = Date.now() - startedAt

  const perJudge: JudgePanelCalibration<D>['perJudge'] = {}
  for (const judge of judges) {
    log(`  ${judge}`)
    perJudge[judge] = {} as Record<D, JudgeDimensionCalibration>
    for (const d of dimensions) {
      const golden = goldenByJudge[judge]![d]
      const scores = scoresByJudge[judge]![d]
      const calibration = calibrateJudge(golden, scores)
      perJudge[judge]![d] = { calibration, golden, scores }
      log(
        `    ${d.padEnd(34)} n=${calibration.n.toString().padStart(2)} kappa=${calibration.kappa.toFixed(2)} r=${calibration.pearson.toFixed(2)} MAE=${calibration.mae.toFixed(3)}`,
      )
    }
  }

  return { judges, dimensions, perJudge, rawScores, outputs, ungradedItems, failures, elapsedMs }
}

/** Thresholds for `gateJudgeCalibration`. */
export interface JudgeCalibrationGateConfig {
  /** Pearson below this (and at or above `pearsonWarn`) warns. */
  pearsonFloor: number
  /** Pearson below this fails. */
  pearsonWarn: number
  /** MAE above this fails. */
  maeCeiling: number
  /** Cells with fewer graded items are reported as insufficient and never fail. */
  minSamples: number
}

export type JudgeCalibrationCellVerdict = 'pass' | 'warn' | 'fail' | 'insufficient'

export interface JudgeCalibrationGateCell {
  judge: string
  dim: string
  n: number
  pearson: number
  mae: number
  verdict: JudgeCalibrationCellVerdict
  reasons: string[]
}

export interface JudgeCalibrationGate {
  pass: boolean
  config: JudgeCalibrationGateConfig
  failCount: number
  warnCount: number
  insufficientCount: number
  cells: JudgeCalibrationGateCell[]
}

/** Pass/warn/fail every (judge × dimension) cell; the gate passes with zero fail cells. */
export function gateJudgeCalibration(
  perJudge: Record<string, Record<string, { calibration: CalibrationResult }>>,
  config: JudgeCalibrationGateConfig,
): JudgeCalibrationGate {
  const cells: JudgeCalibrationGateCell[] = []
  for (const [judge, dims] of Object.entries(perJudge)) {
    for (const [dim, { calibration: cal }] of Object.entries(dims)) {
      const reasons: string[] = []
      let verdict: JudgeCalibrationCellVerdict = 'pass'
      if (cal.n < config.minSamples) {
        verdict = 'insufficient'
        reasons.push(`n=${cal.n} < minSamples=${config.minSamples}`)
      } else {
        if (Number.isFinite(cal.pearson) && cal.pearson < config.pearsonFloor) {
          if (cal.pearson < config.pearsonWarn) {
            verdict = 'fail'
            reasons.push(
              `pearson=${cal.pearson.toFixed(2)} < floor=${config.pearsonFloor.toFixed(2)} (below warn=${config.pearsonWarn.toFixed(2)})`,
            )
          } else {
            verdict = 'warn'
            reasons.push(
              `pearson=${cal.pearson.toFixed(2)} in warn band [${config.pearsonWarn.toFixed(2)}, ${config.pearsonFloor.toFixed(2)})`,
            )
          }
        }
        if (Number.isFinite(cal.mae) && cal.mae > config.maeCeiling) {
          verdict = 'fail'
          reasons.push(`mae=${cal.mae.toFixed(3)} > ceiling=${config.maeCeiling.toFixed(3)}`)
        }
      }
      cells.push({ judge, dim, n: cal.n, pearson: cal.pearson, mae: cal.mae, verdict, reasons })
    }
  }
  const count = (v: JudgeCalibrationCellVerdict) => cells.filter((c) => c.verdict === v).length
  const failCount = count('fail')
  return {
    pass: failCount === 0,
    config,
    failCount,
    warnCount: count('warn'),
    insufficientCount: count('insufficient'),
    cells,
  }
}
