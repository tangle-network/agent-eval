/**
 * State continuity scoring — measures how well a resumed/handed-off agent
 * preserves prior work.
 *
 * Lifted from tax-agent's run-resume-eval.ts. When session 2 continues
 * session 1's work, the key question is: did it preserve key artifacts,
 * or start over and lose context? Each `ContinuityCheck` inspects one
 * aspect (file preserved, key count grew, status advanced) and yields
 * 0-1 credit; the aggregate is the simple mean.
 *
 * Generic over any "snapshot" shape — pass your own checks.
 */

export interface ContinuitySnapshotPair<T> {
  before: T
  after: T
}

export interface ContinuityCheck<T> {
  /** Stable identifier; shown in the report. */
  id: string
  /** Description of what this check measures. */
  description: string
  /** Returns 0..1 credit for this dimension (1 = fully preserved/improved). */
  score: (pair: ContinuitySnapshotPair<T>) => number
}

export interface ContinuityCheckResult {
  id: string
  description: string
  score: number
  pass: boolean
}

export interface ContinuityReport {
  results: ContinuityCheckResult[]
  /** Mean of per-check scores, in 0..1. */
  overallScore: number
  /** True iff ALL checks scored ≥ passThreshold. */
  pass: boolean
}

export function scoreContinuity<T>(
  pair: ContinuitySnapshotPair<T>,
  checks: ContinuityCheck<T>[],
  options: { passThreshold?: number } = {},
): ContinuityReport {
  if (checks.length === 0) {
    throw new Error('scoreContinuity: at least 1 check required')
  }
  const passThreshold = options.passThreshold ?? 0.8
  const results: ContinuityCheckResult[] = checks.map((c) => {
    const raw = c.score(pair)
    const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0
    return { id: c.id, description: c.description, score: clamped, pass: clamped >= passThreshold }
  })
  const overallScore = results.reduce((a, r) => a + r.score, 0) / results.length
  return { results, overallScore, pass: results.every((r) => r.pass) }
}

/** Common check: a required key in a record exists and equals the prior value. */
export function keyPreserved<T extends Record<string, unknown>>(key: keyof T & string): ContinuityCheck<T> {
  return {
    id: `preserved(${key})`,
    description: `"${key}" unchanged from before to after`,
    score: ({ before, after }) => (before[key] !== undefined && before[key] === after[key] ? 1 : 0),
  }
}

/** Common check: a collection (array) grew or stayed the same size. */
export function collectionPreserved<T, K extends keyof T & string>(
  key: K,
  minRatio = 1,
): ContinuityCheck<T> {
  return {
    id: `collection-preserved(${key})`,
    description: `"${key}" length ≥ ${minRatio} × prior length`,
    score: ({ before, after }) => {
      const b = before[key]
      const a = after[key]
      if (!Array.isArray(b) || !Array.isArray(a)) return 0
      if (b.length === 0) return a.length === 0 ? 1 : 1
      return Math.min(1, a.length / (b.length * minRatio))
    },
  }
}

/** Common check: a status field advanced in an expected order. */
export function statusAdvanced<T extends Record<string, unknown>>(
  key: keyof T & string,
  progression: readonly string[],
): ContinuityCheck<T> {
  return {
    id: `status-advanced(${key})`,
    description: `"${key}" progressed along ${progression.join('→')}`,
    score: ({ before, after }) => {
      const bi = progression.indexOf(String(before[key]))
      const ai = progression.indexOf(String(after[key]))
      if (bi === -1 || ai === -1) return 0
      return ai >= bi ? 1 : 0
    },
  }
}
