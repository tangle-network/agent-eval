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
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
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
      const a = chars[idx]
      const b = chars[idx + 1]
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
