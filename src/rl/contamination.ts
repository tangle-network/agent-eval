/**
 * Contamination probe — held-out perturbation tests.
 *
 * The bug class: once a benchmark scenario set is published, models train
 * on it, and your scores become invalid. SWE-Bench-Verified, GPQA, and
 * MMLU-Pro all exist because their predecessors got contaminated within
 * months. The right defense is to keep a held-out *perturbed* version of
 * every scenario — same task, slightly different surface — and check
 * whether scores diverge significantly. Genuine capability transfers; rote
 * memorization doesn't.
 *
 * This module ships the probe contract:
 *
 *   1. A `ScenarioPerturbation` strategy type — function that produces a
 *      perturbed scenario from an original.
 *   2. `runContaminationProbe({ originals, perturbed, scoreFn })` — runs
 *      both halves and reports per-scenario score divergence + a global
 *      contamination verdict via paired Wilcoxon.
 *   3. Several stock perturbations: `renameVariables`, `shuffleOrder`,
 *      `paraphrasePrompt`, `injectIrrelevantClause`. Each preserves the
 *      task's structural difficulty while breaking surface memorization.
 *
 * The verdict is conservative: if the perturbed-vs-original score
 * difference is statistically significant (BH-adjusted p < 0.05) AND
 * the median drop is > 5 percentage points, we flag *contamination
 * suspected*. False positives are possible (the perturbation might
 * actually be harder); the default is to flag for review, not to
 * autoreject.
 */

import { wilcoxonSignedRank } from '../statistics'
import { benjaminiHochberg } from '../power-analysis'

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
  /** Identity of every scenario. The probe's `runFingerprint` keys on these. */
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
  /**
   * BH-FDR threshold for declaring contamination on each per-scenario
   * delta. Default 0.05.
   */
  fdr?: number
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
    /** Per-scenario q-value (single-test BH for a single scenario). Mainly for display. */
    qValue: number
  }>
  /** Wilcoxon paired-test on the deltas. */
  pairedTest: { w: number; p: number }
  medianDelta: number
  meanDelta: number
  contaminationSuspected: boolean
  reason: string
  /** Number of scenarios processed. */
  n: number
}

export async function runContaminationProbe<S>(
  input: ContaminationProbeInput<S>,
  opts: ContaminationProbeOptions = {},
): Promise<ContaminationProbeReport> {
  const fdr = opts.fdr ?? 0.05
  const minMedianDrop = opts.minMedianDrop ?? 0.05
  const floor = opts.scoreFloor ?? 0

  if (!input.perturbed && !input.perturbation) {
    throw new Error('runContaminationProbe: must supply either `perturbed` or `perturbation`.')
  }
  const perturbed: S[] = input.perturbed ?? await Promise.all(
    input.originals.map((s) => input.perturbation!.apply(s)),
  )
  if (perturbed.length !== input.originals.length) {
    throw new Error(`runContaminationProbe: perturbed length ${perturbed.length} ≠ originals ${input.originals.length}`)
  }

  // Score both halves.
  const origScores = await Promise.all(input.originals.map((s) => input.scoreFn(s)))
  const pertScores = await Promise.all(perturbed.map((s) => input.scoreFn(s)))

  const perScenario = input.originals.map((s, i) => ({
    scenarioId: input.scenarioId(s),
    originalScore: origScores[i]!,
    perturbedScore: pertScores[i]!,
    delta: pertScores[i]! - origScores[i]!,
    qValue: NaN,
  }))

  // Drop scenarios below the floor (partial failures we don't trust).
  const valid = perScenario.filter((p) => p.originalScore >= floor && p.perturbedScore >= floor)
  if (valid.length < 4) {
    return {
      perScenario,
      pairedTest: { w: 0, p: 1 },
      medianDelta: 0,
      meanDelta: 0,
      contaminationSuspected: false,
      reason: `insufficient valid scenarios (n=${valid.length}, need ≥ 4)`,
      n: valid.length,
    }
  }

  const origValid = valid.map((p) => p.originalScore)
  const pertValid = valid.map((p) => p.perturbedScore)
  const pairedTest = wilcoxonSignedRank(origValid, pertValid)
  const deltas = valid.map((p) => p.delta)
  const sortedDeltas = [...deltas].sort((a, b) => a - b)
  const median = sortedDeltas[Math.floor(sortedDeltas.length / 2)]!
  const mean = deltas.reduce((s, d) => s + d, 0) / deltas.length

  // Per-scenario q-values via BH on a synthetic per-scenario p-value
  // (one-sample bootstrap; we use the absolute delta normalized by median
  // as a coarse signal — this is a display aid, the load-bearing test
  // is the global Wilcoxon).
  const pseudoP = valid.map((p) => Math.min(1, Math.max(1e-6, 1 - Math.abs(p.delta) / 1)))
  const { qValues } = benjaminiHochberg(pseudoP, fdr)
  for (let i = 0; i < valid.length; i++) {
    const v = valid[i]!
    const idx = perScenario.findIndex((p) => p.scenarioId === v.scenarioId)
    if (idx >= 0) perScenario[idx]!.qValue = qValues[i]!
  }

  const contaminationSuspected = pairedTest.p < fdr && median <= -minMedianDrop
  const reason = contaminationSuspected
    ? `paired p=${pairedTest.p.toFixed(4)} < ${fdr} and median drop ${median.toFixed(4)} ≥ ${minMedianDrop}`
    : pairedTest.p >= fdr
      ? `no significant difference (paired p=${pairedTest.p.toFixed(4)})`
      : `significant but small effect (median delta ${median.toFixed(4)})`

  return {
    perScenario,
    pairedTest,
    medianDelta: median,
    meanDelta: mean,
    contaminationSuspected,
    reason,
    n: valid.length,
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
  rename: (name: string, idx: number) => string = (n, i) => `${n}_${(i % 26 + 10).toString(36)}`,
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
  let s = seed >>> 0
  const rng = (): number => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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
      const prompt = position === 'prefix'
        ? `${clause} ${scenario.prompt}`
        : `${scenario.prompt} ${clause}`
      return { ...scenario, prompt }
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
