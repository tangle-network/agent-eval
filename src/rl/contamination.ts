/**
 * Contamination probe — held-out perturbation tests.
 *
 * Score each scenario and its perturbation, then test the paired differences.
 * A significant global Wilcoxon result plus a worthwhile median drop flags
 * contamination for review. Perturbations may change difficulty, so the result
 * does not identify contamination as the cause. Per-item differences have no
 * calibrated sampling null and carry no p-values or q-values.
 */

import { ValidationError } from '../errors'
import { wilcoxonSignedRank } from '../statistics'
import { medianInPlace } from '../statistics/internal'
import { mulberry32 } from '../statistics/random'

export type ScenarioPerturbationKind =
  | 'rename_variables'
  | 'shuffle_order'
  | 'paraphrase'
  | 'inject_irrelevant_clause'
  | 'custom'

export interface ScenarioPerturbation<S> {
  kind: ScenarioPerturbationKind
  /** Apply to one scenario, return its perturbed sibling. */
  apply: (scenario: S) => Promise<S> | S
  /** Optional id — for the report. */
  id?: string
}

export interface ContaminationProbeInput<S> {
  /** Stable, unique identity of every original scenario. */
  scenarioId: (s: S) => string
  /** Original scenarios. */
  originals: S[]
  /**
   * Either pre-computed perturbations (one per original, same order) OR a
   * `perturbation` strategy that synthesizes them on the fly.
   */
  perturbed?: S[]
  perturbation?: ScenarioPerturbation<S>
  /**
   * Run the policy/agent against one scenario and return a scalar score
   * in [0, 1]. The probe doesn't care what the policy is — that's the
   * caller's contract.
   */
  scoreFn: (s: S) => Promise<number>
}

export interface ContaminationProbeOptions {
  /** Drop scores below this from the probe; treats partial failures separately. Default 0. */
  scoreFloor?: number
  /** Significance threshold for the single global paired test. Default 0.05. */
  alpha?: number
  /**
   * Minimum median per-scenario drop to flag global contamination. Default
   * 0.05 (5 percentage points). Smaller drops may be noise.
   */
  minMedianDrop?: number
}

export interface ContaminationProbeReport {
  perScenario: Array<{
    scenarioId: string
    originalScore: number
    perturbedScore: number
    delta: number // perturbed - original (negative = drop)
  }>
  /** Global Wilcoxon paired test; null when fewer than four pairs are included. */
  pairedTest: { w: number; p: number } | null
  /** Observed summaries of included pairs; null when no pairs are included. */
  medianDelta: number | null
  meanDelta: number | null
  contaminationSuspected: boolean
  reason: string
  /** Number of pairs included after the configured score floor. */
  n: number
  /** Scenarios excluded by the score floor; their observed scores remain above. */
  excludedScenarioIds: string[]
}

export async function runContaminationProbe<S>(
  input: ContaminationProbeInput<S>,
  opts: ContaminationProbeOptions = {},
): Promise<ContaminationProbeReport> {
  const alpha = opts.alpha ?? 0.05
  const minMedianDrop = opts.minMedianDrop ?? 0.05
  const floor = opts.scoreFloor ?? 0
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new ValidationError('runContaminationProbe: alpha must be in (0,1)')
  }
  for (const [name, value] of [
    ['scoreFloor', floor],
    ['minMedianDrop', minMedianDrop],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new ValidationError(`runContaminationProbe: ${name} must be in [0,1]`)
    }
  }
  const ids = input.originals.map(input.scenarioId)
  if (ids.some((id) => !id?.trim()) || new Set(ids).size !== ids.length) {
    throw new ValidationError(
      'runContaminationProbe: original scenario IDs must be nonempty and unique',
    )
  }

  if (!input.perturbed && !input.perturbation) {
    throw new ValidationError(
      'runContaminationProbe: must supply either `perturbed` or `perturbation`.',
    )
  }
  const perturbed: S[] =
    input.perturbed ?? (await Promise.all(input.originals.map((s) => input.perturbation!.apply(s))))
  if (perturbed.length !== input.originals.length) {
    throw new ValidationError(
      `runContaminationProbe: perturbed length ${perturbed.length} ≠ originals ${input.originals.length}`,
    )
  }

  // Score both halves.
  const origScores = await Promise.all(input.originals.map((s) => input.scoreFn(s)))
  const pertScores = await Promise.all(perturbed.map((s) => input.scoreFn(s)))

  for (const score of [...origScores, ...pertScores]) {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new ValidationError(
        `runContaminationProbe: scores must be finite and in [0,1], got ${score}`,
      )
    }
  }
  const perScenario = ids.map((scenarioId, i) => ({
    scenarioId,
    originalScore: origScores[i]!,
    perturbedScore: pertScores[i]!,
    delta: pertScores[i]! - origScores[i]!,
  }))

  // Drop scenarios below the floor (partial failures we don't trust).
  const valid = perScenario.filter((p) => p.originalScore >= floor && p.perturbedScore >= floor)
  const excludedScenarioIds = perScenario
    .filter((p) => p.originalScore < floor || p.perturbedScore < floor)
    .map((p) => p.scenarioId)
  const deltas = valid.map((p) => p.delta)
  const medianDelta = deltas.length === 0 ? null : medianInPlace(deltas)
  const meanDelta =
    deltas.length === 0 ? null : deltas.reduce((sum, d) => sum + d, 0) / deltas.length
  if (valid.length < 4) {
    return {
      perScenario,
      pairedTest: null,
      medianDelta,
      meanDelta,
      contaminationSuspected: false,
      reason: `insufficient valid scenarios (n=${valid.length}, need ≥ 4)`,
      n: valid.length,
      excludedScenarioIds,
    }
  }

  const origValid = valid.map((p) => p.originalScore)
  const pertValid = valid.map((p) => p.perturbedScore)
  const pairedTest = wilcoxonSignedRank(origValid, pertValid)
  const contaminationSuspected = pairedTest.p < alpha && medianDelta! <= -minMedianDrop
  const reason = contaminationSuspected
    ? `paired p=${pairedTest.p.toFixed(4)} < ${alpha} and median drop ${(-medianDelta!).toFixed(4)} ≥ ${minMedianDrop}`
    : pairedTest.p >= alpha
      ? `no significant difference (paired p=${pairedTest.p.toFixed(4)})`
      : `significant but no qualifying drop (median delta ${medianDelta!.toFixed(4)})`

  return {
    perScenario,
    pairedTest,
    medianDelta,
    meanDelta,
    contaminationSuspected,
    reason,
    n: valid.length,
    excludedScenarioIds,
  }
}

// ── Stock perturbations ──────────────────────────────────────────────────

/**
 * Identifier-rename perturbation for code/text scenarios. Replaces every
 * occurrence of the listed identifiers with synthesized aliases. Use when
 * the scenario's structural difficulty is independent of variable names
 * (e.g. SWE-Bench-style coding tasks).
 */
export function renameVariables<S extends { prompt: string }>(
  identifiers: string[],
  rename: (name: string, idx: number) => string = (n, i) => `${n}_${((i % 26) + 10).toString(36)}`,
): ScenarioPerturbation<S> {
  return {
    kind: 'rename_variables',
    apply(scenario) {
      let prompt = scenario.prompt
      identifiers.forEach((id, i) => {
        const replacement = rename(id, i)
        const re = new RegExp(`\\b${escapeRegex(id)}\\b`, 'g')
        prompt = prompt.replace(re, replacement)
      })
      return { ...scenario, prompt }
    },
  }
}

/**
 * Order-shuffle perturbation. Reshuffles a list-shaped section of the
 * prompt (for QA scenarios that present options A/B/C/D — answer depends
 * on the option labels, not order). Caller provides the section extractor.
 */
export function shuffleOrder<S extends { prompt: string }>(
  shuffleSection: (prompt: string, rng: () => number) => string,
  seed: number,
): ScenarioPerturbation<S> {
  const rng = mulberry32(seed)
  return {
    kind: 'shuffle_order',
    apply(scenario) {
      const newPrompt = shuffleSection(scenario.prompt, rng)
      return { ...scenario, prompt: newPrompt }
    },
  }
}

/**
 * Inject-irrelevant-clause perturbation. Adds a benign sentence that
 * shouldn't change the answer. Tests for "did the model just memorize
 * the input string."
 */
export function injectIrrelevantClause<S extends { prompt: string }>(
  clause: string,
  position: 'prefix' | 'suffix' = 'prefix',
): ScenarioPerturbation<S> {
  return {
    kind: 'inject_irrelevant_clause',
    apply(scenario) {
      const prompt =
        position === 'prefix' ? `${clause} ${scenario.prompt}` : `${scenario.prompt} ${clause}`
      return { ...scenario, prompt }
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
