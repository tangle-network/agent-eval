import { ValidationError } from '../../errors'
import { mulberry32 } from '../../statistics'
import { readNumericOutcome } from './estimand'
import type { EvidenceRecord } from './evidence'
import { readField } from './predicate'

// ── Intervals ────────────────────────────────────────────────────────

/** How uncertainty is computed. The seed is part of the registration. */
export type IntervalSpec =
  | {
      kind: 'cluster-bootstrap'
      clusterBy: string
      /** Registered numeric or boolean outcome field, including a prepared paired difference. */
      value: string
      resamples: number
      seed: number
      level: number
      method: 'percentile'
    }
  | { kind: 'clopper-pearson'; level: number }

export interface ComputedInterval {
  lower: number
  upper: number
  level: number
}

/** Shared by registration and direct execution so malformed intervals cannot produce evidence. */
export function intervalSpecProblems(spec: IntervalSpec): string[] {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return ['interval must be an object']
  }
  if (spec.kind !== 'cluster-bootstrap' && spec.kind !== 'clopper-pearson') {
    return ['interval kind must be cluster-bootstrap or clopper-pearson']
  }
  const problems: string[] = []
  if (!Number.isFinite(spec.level) || spec.level <= 0 || spec.level >= 1) {
    problems.push('level must be a finite number between zero and one')
  }
  if (spec.kind === 'cluster-bootstrap') {
    for (const field of ['clusterBy', 'value'] as const) {
      const path = spec[field]
      if (
        typeof path !== 'string' ||
        path.split('.').some((segment) => segment.length === 0 || segment.trim() !== segment)
      ) {
        problems.push(`${field} must be a nonempty dot-separated field path`)
      }
    }
    if (
      !Number.isSafeInteger(spec.resamples) ||
      spec.resamples < 1 ||
      spec.resamples > 0xffff_ffff
    ) {
      problems.push('resamples must be a positive integer within the supported array length')
    }
    if (!Number.isSafeInteger(spec.seed)) problems.push('seed must be a safe integer')
    if (spec.method !== 'percentile') problems.push('method must be percentile')
  }
  return problems
}

/**
 * Execute an interval spec.
 *
 * Cluster-bootstrap resamples whole clusters of its registered `value` field and
 * takes percentile bounds of the pooled mean. Clopper-Pearson computes the
 * exact binomial interval and requires `successes`/`trials` evidence instead
 * of rows.
 */
export function computeInterval(
  spec: IntervalSpec,
  evidence:
    | { kind: 'rows'; rows: readonly EvidenceRecord[] }
    | { kind: 'binomial'; successes: number; trials: number },
): ComputedInterval {
  const problems = intervalSpecProblems(spec)
  if (problems.length > 0) throw new ValidationError(`computeInterval: ${problems.join('; ')}`)
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new ValidationError('computeInterval: evidence must be an object')
  }
  if (spec.kind === 'cluster-bootstrap') {
    if (evidence.kind !== 'rows') {
      throw new ValidationError('computeInterval: cluster-bootstrap requires row evidence')
    }
    if ('value' in evidence) {
      throw new ValidationError(
        'computeInterval: register value in the interval spec, not row evidence',
      )
    }
    if (!Array.isArray(evidence.rows))
      throw new ValidationError('computeInterval: rows must be an array')
    const clusters = new Map<string, number[]>()
    for (const [index, row] of evidence.rows.entries()) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new ValidationError(`computeInterval: row ${index} must be an object`)
      }
      const cluster = readField(row, spec.clusterBy)
      if (
        !(typeof cluster === 'string' && cluster.length > 0 && cluster.trim() === cluster) &&
        !(typeof cluster === 'number' && Number.isFinite(cluster))
      ) {
        throw new ValidationError(
          `computeInterval: cluster field '${spec.clusterBy}' must be a nonempty string or finite number on row ${index}`,
        )
      }
      const clusterKey = `${typeof cluster}:${cluster}`
      const value = readNumericOutcome(
        readField(row, spec.value),
        'computeInterval cluster-bootstrap',
        spec.value,
        `cluster '${cluster}'`,
      )
      const bucket = clusters.get(clusterKey)
      if (bucket) bucket.push(value)
      else clusters.set(clusterKey, [value])
    }
    const clusterValues = [...clusters.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, values]) => values)
    if (clusterValues.length < 2) {
      throw new ValidationError(
        `computeInterval: cluster-bootstrap needs >= 2 clusters, got ${clusterValues.length}`,
      )
    }
    const rng = mulberry32(spec.seed)
    const means = new Array<number>(spec.resamples)
    for (let draw = 0; draw < spec.resamples; draw++) {
      let sum = 0
      let count = 0
      for (let pick = 0; pick < clusterValues.length; pick++) {
        const cluster = clusterValues[Math.floor(rng() * clusterValues.length)]!
        for (const value of cluster) sum += value
        count += cluster.length
      }
      means[draw] = sum / count
      if (!Number.isFinite(means[draw])) {
        throw new ValidationError(
          'computeInterval: cluster mean overflowed the finite numeric range',
        )
      }
    }
    means.sort((a, b) => a - b)
    const alpha = 1 - spec.level
    const lowerIndex = Math.floor((alpha / 2) * spec.resamples)
    const upperIndex = Math.min(spec.resamples - 1, Math.ceil((1 - alpha / 2) * spec.resamples) - 1)
    return {
      lower: means[lowerIndex]!,
      upper: means[Math.max(lowerIndex, upperIndex)]!,
      level: spec.level,
    }
  }

  if (evidence.kind !== 'binomial') {
    throw new ValidationError('computeInterval: clopper-pearson requires binomial evidence')
  }
  const { successes, trials } = evidence
  if (
    !Number.isSafeInteger(successes) ||
    !Number.isSafeInteger(trials) ||
    trials <= 0 ||
    successes < 0
  ) {
    throw new ValidationError(
      `computeInterval: clopper-pearson needs 0 <= successes <= trials, got ${successes}/${trials}`,
    )
  }
  if (successes > trials) {
    throw new ValidationError(
      `computeInterval: clopper-pearson successes ${successes} exceed trials ${trials}`,
    )
  }
  const alpha = 1 - spec.level
  const lower = successes === 0 ? 0 : binomialQuantile(successes, trials, alpha / 2, 'lower')
  const upper = successes === trials ? 1 : binomialQuantile(successes, trials, alpha / 2, 'upper')
  return { lower, upper, level: spec.level }
}

/**
 * Clopper-Pearson bound by bisection on the binomial tail. The lower bound is
 * the p with P(X >= successes | p) = alpha; the upper is the p with
 * P(X <= successes | p) = alpha. Deterministic, no special functions.
 */
function binomialQuantile(
  successes: number,
  trials: number,
  alpha: number,
  side: 'lower' | 'upper',
): number {
  const tail = (p: number): number => {
    // log-space binomial pmf accumulation for numeric stability
    let sum = 0
    for (let k = 0; k <= trials; k++) {
      const inTail = side === 'lower' ? k >= successes : k <= successes
      if (!inTail) continue
      sum += Math.exp(logBinomialPmf(k, trials, p))
    }
    return sum
  }
  let lo = 0
  let hi = 1
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2
    if (tail(mid) < alpha) {
      if (side === 'lower') lo = mid
      else hi = mid
    } else {
      if (side === 'lower') hi = mid
      else lo = mid
    }
  }
  return (lo + hi) / 2
}

function logBinomialPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 0 : Number.NEGATIVE_INFINITY
  if (p >= 1) return k === n ? 0 : Number.NEGATIVE_INFINITY
  return logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p)
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k)
}

const LOG_FACTORIAL_CACHE: number[] = [0]

function logFactorial(n: number): number {
  for (let i = LOG_FACTORIAL_CACHE.length; i <= n; i++) {
    LOG_FACTORIAL_CACHE[i] = LOG_FACTORIAL_CACHE[i - 1]! + Math.log(i)
  }
  return LOG_FACTORIAL_CACHE[n]!
}
