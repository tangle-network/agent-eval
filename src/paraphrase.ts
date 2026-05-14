/**
 * Paraphrase robustness — mutates a scenario prompt in structure-
 * preserving ways, re-scores, and reports score variance.
 *
 * Mutators are pure functions `(prompt: string) => string`. Ship a
 * default set; consumers add domain-specific ones.
 *
 * Robustness score: 1 - stdDev(scores) / (mean if positive else 1).
 * A perfect agent returns the same answer regardless of typo / case /
 * reordering — any variance signals a brittle prompt.
 */

export type Mutator = (prompt: string, seed: number) => string

export interface RobustnessResult {
  originalScore: number
  variantScores: Array<{ mutator: string; score: number; mutated: string }>
  meanScore: number
  stdDev: number
  robustness: number
}

export async function paraphraseRobustness(
  prompt: string,
  mutators: Array<{ id: string; fn: Mutator }>,
  scoreFn: (prompt: string) => Promise<number>,
  options: { seed?: number } = {},
): Promise<RobustnessResult> {
  const seed = options.seed ?? 1
  const originalScore = await scoreFn(prompt)
  const variantScores: RobustnessResult['variantScores'] = []
  const all: number[] = [originalScore]
  for (const { id, fn } of mutators) {
    const mutated = fn(prompt, seed)
    const score = await scoreFn(mutated)
    variantScores.push({ mutator: id, score, mutated })
    all.push(score)
  }
  const mean = all.reduce((a, b) => a + b, 0) / all.length
  const variance = all.reduce((a, v) => a + (v - mean) ** 2, 0) / all.length
  const stdDev = Math.sqrt(variance)
  const ref = Math.abs(mean) > 1e-9 ? Math.abs(mean) : 1
  const robustness = Math.max(0, 1 - stdDev / ref)
  return { originalScore, variantScores, meanScore: mean, stdDev, robustness }
}

// ── Built-in mutators ────────────────────────────────────────────────

/** Lowercase the whole prompt. Robust models ignore case. */
export const lowercaseMutator: Mutator = (p) => p.toLowerCase()

/** Reorder sentences. Robust models don't depend on sentence order. */
export const sentenceReorderMutator: Mutator = (p, seed) => {
  const sentences = p.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length <= 1) return p
  const shuffled = [...sentences]
  let s = seed >>> 0
  for (let i = shuffled.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0
    const j = s % (i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }
  return shuffled.join(' ')
}

/** Swap adjacent letter pairs (1 per 40 chars, min 1). Robust models tolerate typos. */
export const typoMutator: Mutator = (p, seed) => {
  if (p.length < 5) return p
  const chars = p.split('')
  let s = seed >>> 0
  const count = Math.max(1, Math.floor(chars.length / 40))
  for (let n = 0; n < count; n++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      s = (s * 1103515245 + 12345) >>> 0
      const idx = s % (chars.length - 1)
      const a = chars[idx]!
      const b = chars[idx + 1]!
      if (a !== b && /[A-Za-z]/.test(a) && /[A-Za-z]/.test(b)) {
        chars[idx] = b
        chars[idx + 1] = a
        break
      }
    }
  }
  return chars.join('')
}

/** Add a benign politeness prefix. Robust models ignore flattery. */
export const politenessPrefixMutator: Mutator = (p) => `Please, if you would be so kind: ${p}`

/** Compact whitespace, strip newlines. Robust models don't depend on formatting. */
export const whitespaceCollapseMutator: Mutator = (p) => p.replace(/\s+/g, ' ').trim()

export const DEFAULT_MUTATORS: Array<{ id: string; fn: Mutator }> = [
  { id: 'lowercase', fn: lowercaseMutator },
  { id: 'sentence-reorder', fn: sentenceReorderMutator },
  { id: 'typo', fn: typoMutator },
  { id: 'politeness-prefix', fn: politenessPrefixMutator },
  { id: 'whitespace-collapse', fn: whitespaceCollapseMutator },
]

// ── Multi-turn scenario convenience wrapper ──────────────────────────

export interface ParaphraseRobustnessScenarioInput {
  scenarios: Array<{ id: string; userTurns: string[] }>
  /**
   * Mutators applied to every user turn in every scenario. Each
   * scenario is paraphrased once per mutator (so `reps` × `scenarios`
   * × `mutators` total paraphrased runs).
   */
  mutators: Array<{ name: string; mutator: (text: string) => string }>
  /**
   * Run a (possibly mutated) scenario and return its score in [0,1].
   * Called once for the original turns of each scenario, and once per
   * (scenario × mutator × rep) for the paraphrased variants.
   */
  runScenario: (args: { id: string; userTurns: string[] }) => Promise<{ score: number }>
  /** Times to repeat each (scenario × mutator) pair. Default 1. */
  reps?: number
}

export interface ParaphraseRobustnessScenarioResult {
  /**
   * Aggregate robustness: `mean(paraphrased) / mean(original)`,
   * clipped to `[0, 1]`. `1` = paraphrasing didn't degrade the agent;
   * `0` = paraphrasing destroyed it (or original was 0).
   */
  score: number
  perScenario: Array<{
    id: string
    originalScore: number
    paraphrasedMean: number
    /** Per-mutator delta (paraphrased − original); negative = mutator hurt. */
    deltas: Record<string, number>
  }>
  mutators: string[]
}

/**
 * Multi-turn convenience wrapper around {@link paraphraseRobustness}.
 *
 * Consumers with a list of multi-turn scenarios were hand-wrapping the
 * single-prompt runner per scenario; this iterates for them. Mutators
 * are applied to every user turn (mutator runs once per turn with a
 * stable seed derived from the rep index).
 *
 * Contract:
 *   - Calls `runScenario` once with the original `userTurns` to
 *     establish the baseline `originalScore`.
 *   - For each `(scenario, mutator, rep)` combination, builds a
 *     mutated copy of `userTurns` (every turn passed through
 *     `mutator.mutator`) and calls `runScenario` again.
 *   - Aggregates per-scenario means, then computes the overall
 *     `mean(paraphrasedMean) / mean(originalScore)`, clipped to
 *     `[0, 1]`. If every original score is 0 the aggregate is 0.
 */
export async function paraphraseRobustnessScenarios(
  args: ParaphraseRobustnessScenarioInput,
): Promise<ParaphraseRobustnessScenarioResult> {
  const reps = Math.max(1, args.reps ?? 1)
  const mutatorNames = args.mutators.map((m) => m.name)

  const perScenario: ParaphraseRobustnessScenarioResult['perScenario'] = []

  for (const scenario of args.scenarios) {
    const baseline = await args.runScenario({
      id: scenario.id,
      userTurns: scenario.userTurns,
    })
    const originalScore = baseline.score

    const deltas: Record<string, number> = {}
    const paraphrasedAll: number[] = []

    for (const m of args.mutators) {
      const scores: number[] = []
      for (let r = 0; r < reps; r++) {
        const mutatedTurns = scenario.userTurns.map((t) => m.mutator(t))
        const out = await args.runScenario({
          id: scenario.id,
          userTurns: mutatedTurns,
        })
        scores.push(out.score)
      }
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length
      deltas[m.name] = mean - originalScore
      paraphrasedAll.push(...scores)
    }

    const paraphrasedMean =
      paraphrasedAll.length === 0
        ? originalScore
        : paraphrasedAll.reduce((a, b) => a + b, 0) / paraphrasedAll.length

    perScenario.push({ id: scenario.id, originalScore, paraphrasedMean, deltas })
  }

  const meanOriginal =
    perScenario.length === 0
      ? 0
      : perScenario.reduce((a, p) => a + p.originalScore, 0) / perScenario.length
  const meanParaphrased =
    perScenario.length === 0
      ? 0
      : perScenario.reduce((a, p) => a + p.paraphrasedMean, 0) / perScenario.length

  const ratio = meanOriginal <= 0 ? 0 : meanParaphrased / meanOriginal
  const score = Math.max(0, Math.min(1, ratio))

  return { score, perScenario, mutators: mutatorNames }
}
