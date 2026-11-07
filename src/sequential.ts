import { drawValue, type PairedValueLaw } from './paired-promotion-power'
import { wilson } from './statistics/paired-binary'
import { mulberry32 } from './statistics/random'

export type SequentialDecision = 'promote_now' | 'continue' | 'reject_now' | 'equivalent'

export interface PairedEvalueOptions {
  bound?: number
  alpha?: number
  rope?: { low: number; high: number }
  initialBetShrinkage?: number
}

export interface PairedEvalueStep {
  t: number
  delta: number
  evalue: number
  pValue: number
  csLow: number
  csHigh: number
  decision: SequentialDecision
}

export interface PairedEvalueSequence {
  steps: PairedEvalueStep[]
  finalDecision: SequentialDecision
  decisionFiredAt: number | null
  clipped: boolean
}

export function pairedEvalueSequence(
  deltas: number[],
  opts: PairedEvalueOptions = {},
): PairedEvalueSequence {
  const c = opts.bound ?? 1
  const alpha = opts.alpha ?? 0.05
  const initialShrink = opts.initialBetShrinkage ?? 0.5
  const rope = opts.rope ?? null
  assertSequentialScalarConfiguration(c, alpha, initialShrink, 'pairedEvalueSequence')
  if (rope && !(Number.isFinite(rope.low) && Number.isFinite(rope.high) && rope.low <= rope.high)) {
    throw new Error('pairedEvalueSequence: rope must satisfy low ≤ high')
  }
  const { decisionThreshold } = sequentialThresholds(alpha)

  const steps: PairedEvalueStep[] = []
  let clipped = false
  let evalue = 1
  let decisionFiredAt: number | null = null

  let sum = 0
  let sumSq = 0
  let count = 0

  for (let i = 0; i < deltas.length; i++) {
    let d = deltas[i]!
    if (!Number.isFinite(d)) {
      throw new Error(`pairedEvalueSequence: delta[${i}] must be finite`)
    }
    if (d < -c || d > c) {
      d = Math.max(-c, Math.min(c, d))
      clipped = true
    }

    const muHat = count === 0 ? 0 : sum / count
    const varHat = count === 0 ? c * c : Math.max(1e-12, sumSq / count - muHat * muHat)
    const t = i + 1
    const shrink = initialShrink * Math.min(1, count / 32)
    let lambda = (muHat / (varHat + c * c)) * shrink
    const lambdaMax = 0.99 / c
    if (lambda > lambdaMax) lambda = lambdaMax
    if (lambda < -lambdaMax) lambda = -lambdaMax

    evalue = evalue * (1 + lambda * d)
    if (!Number.isFinite(evalue) || evalue < 0) evalue = 0

    sum += d
    sumSq += d * d
    count += 1

    const pValue = Math.min(1, 1 / Math.max(evalue, 1e-300))

    const cs = empiricalBernsteinCs(sum, sumSq, count, c, alpha)

    let decision: SequentialDecision = 'continue'
    if (rope && cs.low >= rope.low && cs.high <= rope.high) decision = 'equivalent'
    else if (evalue >= decisionThreshold && muHat > 0) decision = 'promote_now'
    else if (evalue >= decisionThreshold && muHat < 0) decision = 'reject_now'
    else if (rope && cs.high < rope.low) decision = 'reject_now'

    if (decision !== 'continue' && decisionFiredAt === null) decisionFiredAt = t

    steps.push({ t, delta: d, evalue, pValue, csLow: cs.low, csHigh: cs.high, decision })
  }

  const finalDecision = steps.length === 0 ? 'continue' : steps[steps.length - 1]!.decision
  return { steps, finalDecision, decisionFiredAt, clipped }
}

export interface SequentialCrossingHorizonOptions
  extends Pick<PairedEvalueOptions, 'alpha' | 'bound' | 'initialBetShrinkage'> {
  maxPairs?: number
}

export interface SequentialCrossingHorizon {
  readonly evidencePairs: number | null
  readonly decisionPairs: number | null
  readonly evidenceThreshold: number
  readonly decisionThreshold: number
  readonly maxPairs: number
}

const MAX_SEQUENTIAL_CROSSING_PAIRS = 1_000_000

export function sequentialCrossingHorizon(
  opts: SequentialCrossingHorizonOptions = {},
): SequentialCrossingHorizon {
  const bound = opts.bound ?? 1
  const alpha = opts.alpha ?? 0.05
  const initialBetShrinkage = opts.initialBetShrinkage ?? 0.5
  const maxPairs = opts.maxPairs ?? 10_000
  assertSequentialScalarConfiguration(
    bound,
    alpha,
    initialBetShrinkage,
    'sequentialCrossingHorizon',
  )
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 1) {
    throw new Error('sequentialCrossingHorizon: maxPairs must be a positive safe integer')
  }
  if (maxPairs > MAX_SEQUENTIAL_CROSSING_PAIRS) {
    throw new Error(
      `sequentialCrossingHorizon: maxPairs must be <= ${MAX_SEQUENTIAL_CROSSING_PAIRS}`,
    )
  }
  const sequence = pairedEvalueSequence(Array<number>(maxPairs).fill(bound), {
    bound,
    alpha,
    initialBetShrinkage,
  })
  const { evidenceThreshold, decisionThreshold } = sequentialThresholds(alpha)
  const evidencePairs = sequence.steps.find((step) => step.evalue >= evidenceThreshold)?.t ?? null
  return Object.freeze({
    evidencePairs,
    decisionPairs: sequence.decisionFiredAt,
    evidenceThreshold,
    decisionThreshold,
    maxPairs,
  })
}

export interface InterimReleaseConfidenceInput {
  deltaSeries: Array<{ candidateId: string; deltas: number[] }>
  alpha?: number
  bound?: number
  rope?: { low: number; high: number }
}

export interface InterimReleaseConfidence {
  candidates: Array<{
    candidateId: string
    decision: SequentialDecision
    decisionFiredAt: number | null
    finalEvalue: number
    finalPValue: number
    pairs: number
    csLow: number
    csHigh: number
  }>
  recommendation: { decision: SequentialDecision; candidateId: string | null }
}

export function evaluateInterimReleaseConfidence(
  input: InterimReleaseConfidenceInput,
): InterimReleaseConfidence {
  const candidates = input.deltaSeries.map((s) => {
    const seq = pairedEvalueSequence(s.deltas, {
      alpha: input.alpha,
      bound: input.bound,
      rope: input.rope,
    })
    const last = seq.steps[seq.steps.length - 1]
    return {
      candidateId: s.candidateId,
      decision: seq.finalDecision,
      decisionFiredAt: seq.decisionFiredAt,
      finalEvalue: last?.evalue ?? 1,
      finalPValue: last?.pValue ?? 1,
      pairs: seq.steps.length,
      csLow: last?.csLow ?? Number.NEGATIVE_INFINITY,
      csHigh: last?.csHigh ?? Number.POSITIVE_INFINITY,
    }
  })

  const promote = candidates.find((c) => c.decision === 'promote_now')
  if (promote)
    return {
      candidates,
      recommendation: { decision: 'promote_now', candidateId: promote.candidateId },
    }
  const live = candidates.find((c) => c.decision === 'continue')
  if (live) return { candidates, recommendation: { decision: 'continue', candidateId: null } }
  const equiv = candidates.find((c) => c.decision === 'equivalent')
  if (equiv)
    return {
      candidates,
      recommendation: { decision: 'equivalent', candidateId: equiv.candidateId },
    }
  return { candidates, recommendation: { decision: 'reject_now', candidateId: null } }
}

const MAX_SEQUENTIAL_POWER_PAIRS = 10_000
const MAX_SEQUENTIAL_POWER_TRIALS = 10_000

export interface SequentialPairedPowerOptions {
  alpha?: number
  bound: number
  power?: number
  alternative: PairedValueLaw
  maxPairs?: number
  trials?: number
  seed?: number
}

export interface SequentialPairedPower {
  capForPower: number | null
  decisionRateByCap: Array<{ cap: number; rate: number; lower95: number }>
  realized: { mean: number; sd: number }
}

export function sequentialPairedPower(opts: SequentialPairedPowerOptions): SequentialPairedPower {
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const maxPairs = opts.maxPairs ?? 256
  const trials = opts.trials ?? 200
  const seed = opts.seed ?? 1
  assertSequentialScalarConfiguration(opts.bound, alpha, 0.5, 'sequentialPairedPower')
  if (!Number.isFinite(power) || power <= 0 || power >= 1) {
    throw new Error(`sequentialPairedPower: power must be in (0,1), got ${power}`)
  }
  if (!Number.isSafeInteger(maxPairs) || maxPairs < 1 || maxPairs > MAX_SEQUENTIAL_POWER_PAIRS) {
    throw new Error(
      `sequentialPairedPower: maxPairs must be a safe integer in [1, ${MAX_SEQUENTIAL_POWER_PAIRS}]`,
    )
  }
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > MAX_SEQUENTIAL_POWER_TRIALS) {
    throw new Error(
      `sequentialPairedPower: trials must be a safe integer in [1, ${MAX_SEQUENTIAL_POWER_TRIALS}]`,
    )
  }
  if (!Number.isFinite(seed)) {
    throw new Error(`sequentialPairedPower: seed must be finite, got ${seed}`)
  }
  if (opts.alternative.kind === 'atoms' && opts.alternative.atoms.length === 0) {
    throw new Error('sequentialPairedPower: atoms must be non-empty')
  }
  const rng = mulberry32(seed)
  const bound = opts.bound
  let sum = 0
  let sumSq = 0
  const firedAt = new Array<number>(trials)
  for (let trial = 0; trial < trials; trial++) {
    const deltas = new Array<number>(maxPairs)
    for (let i = 0; i < maxPairs; i++) {
      const raw = drawValue(opts.alternative, rng)
      if (!Number.isFinite(raw)) {
        throw new Error('sequentialPairedPower: alternative produced a non-finite draw')
      }
      const clipped = Math.max(-bound, Math.min(bound, raw))
      deltas[i] = clipped
      sum += clipped
      sumSq += clipped * clipped
    }
    const sequence = pairedEvalueSequence(deltas, { alpha, bound })
    firedAt[trial] = sequence.decisionFiredAt ?? maxPairs + 1
  }
  const n = trials * maxPairs
  const mean = sum / n
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean))
  const decisionRateByCap: SequentialPairedPower['decisionRateByCap'] = []
  let capForPower: number | null = null
  for (let cap = 1; cap <= maxPairs; cap++) {
    let hits = 0
    for (let trial = 0; trial < trials; trial++) if (firedAt[trial]! <= cap) hits += 1
    const interval = wilson(hits, trials)
    decisionRateByCap.push({ cap, rate: interval.estimate, lower95: interval.lower })
    if (capForPower === null && interval.lower >= power) capForPower = cap
  }
  return { capForPower, decisionRateByCap, realized: { mean, sd } }
}

function assertSequentialScalarConfiguration(
  bound: number,
  alpha: number,
  initialBetShrinkage: number,
  context: string,
): void {
  if (!Number.isFinite(bound) || bound <= 0) {
    throw new Error(`${context}: bound must be a finite number > 0`)
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new Error(`${context}: alpha must be a finite number in (0,1)`)
  }
  if (
    !Number.isFinite(initialBetShrinkage) ||
    initialBetShrinkage <= 0 ||
    initialBetShrinkage > 1
  ) {
    throw new Error(`${context}: initialBetShrinkage must be a finite number in (0,1]`)
  }
}

function sequentialThresholds(alpha: number): {
  evidenceThreshold: number
  decisionThreshold: number
} {
  return { evidenceThreshold: 1 / alpha, decisionThreshold: 2 / alpha }
}

function empiricalBernsteinCs(
  sum: number,
  sumSq: number,
  n: number,
  bound: number,
  alpha: number,
): { low: number; high: number } {
  if (n === 0) return { low: -bound, high: bound }
  const mean = sum / n
  const variance = Math.max(0, sumSq / n - mean * mean)
  const psi = Math.log(2 / alpha) + 1.7 * Math.log(Math.log(Math.max(Math.E, n)) + 1)
  const radius = Math.sqrt((2 * variance * psi) / n) + (3 * bound * psi) / n
  return { low: mean - radius, high: mean + radius }
}
