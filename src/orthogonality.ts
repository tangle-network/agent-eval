/**
 * Inter-critic / inter-pass orthogonality.
 *
 * Detects redundant ensembles. When you run N critics (or N audit passes,
 * or N specialized agents) on the same input, you want them to disagree —
 * each contributing distinct signal. If they all converge on the same set
 * of findings, you're paying N× cost for ~1× signal.
 *
 * The metric is `1 − mean pairwise cosine similarity` over bags of words
 * extracted from each pass's outputs. 1.0 = fully orthogonal,
 * 0.0 = fully redundant.
 *
 * Universal primitive: pass anything that produces text (findings, tool
 * calls rendered as JSON, verdict strings) and the matcher derives its own
 * vocabulary.
 */

export interface OrthogonalityInput<T> {
  passes: Array<{ findings: T[] }>
  /** Render one element to text. Default: defaultRender (concatenates string fields). */
  text?: (item: T) => string
  /** Minimum token length kept in the bag. Default 4 (drops short fillers). */
  minTokenLength?: number
}

export interface OrthogonalityResult {
  /** 1 − mean pairwise cosine similarity across passes. 1=fully orthogonal, 0=fully redundant. */
  orthogonality: number
  /** Number of passes considered. */
  passCount: number
  /** Pairwise cosine similarities, in upper-triangular order (for debugging). */
  similarities: number[]
}

export function passOrthogonality<T>(input: OrthogonalityInput<T>): OrthogonalityResult {
  const passes = input.passes
  if (passes.length < 2) {
    return { orthogonality: 1, passCount: passes.length, similarities: [] }
  }
  const render = input.text ?? defaultRender
  const minLen = input.minTokenLength ?? 4
  const vectors = passes.map((p) => bagOfWords(p.findings, render, minLen))
  const sims: number[] = []
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sims.push(cosineSimilarity(vectors[i]!, vectors[j]!))
    }
  }
  const mean = sims.length === 0 ? 0 : sims.reduce((a, b) => a + b, 0) / sims.length
  return {
    orthogonality: Math.max(0, Math.min(1, 1 - mean)),
    passCount: passes.length,
    similarities: sims,
  }
}

function defaultRender(item: unknown): string {
  if (typeof item === 'string') return item
  if (item && typeof item === 'object') {
    const parts: string[] = []
    for (const v of Object.values(item as Record<string, unknown>)) {
      if (typeof v === 'string') parts.push(v)
    }
    return parts.join(' ')
  }
  return String(item ?? '')
}

function bagOfWords<T>(items: T[], render: (item: T) => string, minLen: number): Map<string, number> {
  const bag = new Map<string, number>()
  for (const item of items) {
    const text = render(item).toLowerCase()
    for (const tok of text.split(/[^a-z0-9]+/).filter((w) => w.length >= minLen)) {
      bag.set(tok, (bag.get(tok) ?? 0) + 1)
    }
  }
  return bag
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let aMag = 0
  let bMag = 0
  for (const [, v] of a) aMag += v * v
  for (const [, v] of b) bMag += v * v
  for (const [k, v] of a) {
    const bv = b.get(k)
    if (bv) dot += v * bv
  }
  if (aMag === 0 || bMag === 0) return 0
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag))
}
