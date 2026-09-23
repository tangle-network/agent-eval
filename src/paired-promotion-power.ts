/**
 * @module
 * Joint power of a configured {@link decidePairedPromotion} call, computed by
 * running that call on data drawn from a registered alternative.
 *
 * Why a simulation and not a formula: `decidePairedPromotion` is not one test.
 * It routes by sample size (exact sign test below `BOOTSTRAP_GATE_MIN_N`,
 * paired bootstrap at or above it) and by shape (Tango's score interval on a
 * two-point outcome), and on top of the deciding interval it applies a
 * sufficiency floor, a zero-width refusal and McNemar's exact veto. A
 * preregistration usually seals two such calls, a continuous primary and a
 * pass/fail veto drawn from the same episodes, and promotes only when both
 * promote. The sample size at which THAT procedure reaches a target power is
 * not the power of any one channel: the sign-test power at n can be 0.8 while
 * the promotion probability is well below it because the veto binds
 * (agent-eval#785). Closed forms exist for single channels only, and each one
 * shipped here under-sized the call it stood in for (`mcnemarRequiredN` is
 * Lachin's normal approximation, 0.65 exact power where it promised 0.8 at 14
 * pairs; `requiredPairedSampleSize` sizes a paired t the procedure never runs).
 * So the only faithful power is the procedure's own promotion rate under the
 * alternative, and that is what this module computes: draw n pairs from the
 * registered law, run every configured call on them exactly as the caller
 * will, repeat, count.
 *
 * The alternative is DECLARATIVE and serializable, never a sampler function,
 * so a preregistration can seal it as bytes: a mixture of cells, each with a
 * probability, an optional pass/fail outcome per arm for the binary calls,
 * and a law for the candidate-minus-baseline delta on the continuous scale.
 * Drawing the cell first and the delta given the cell is what makes the two
 * channels one joint law rather than two marginals.
 *
 * Everything is seeded (`mulberry32`), so a sizing is reproducible from its
 * inputs, and every estimate carries its Monte Carlo standard error and a
 * Wilson interval: a power read at 0.80 from 1,000 simulations is 0.80 ± 0.013.
 */

import {
  decidePairedPromotion,
  type PairedDecisionMethod,
  type PairedPromotionDecision,
  type PairedPromotionDecisionOptions,
} from './paired-promotion-decision'
import { wilson } from './statistics/paired-binary'
import { mulberry32 } from './statistics/random'

/** A serializable law for one scalar draw. */
export type PairedValueLaw =
  | { kind: 'point'; value: number }
  | { kind: 'atoms'; atoms: ReadonlyArray<{ value: number; probability: number }> }
  | { kind: 'normal'; mean: number; sd: number }

export interface PairedPromotionAlternativeCell {
  /** Probability of this cell. The cells' probabilities sum to 1. */
  probability: number
  /** Pass/fail outcome of each arm in this cell. Required by every call whose
   *  `outcome` is `'pass'`; ignored otherwise. */
  pass?: { control: boolean; treatment: boolean }
  /** Law of the candidate-minus-baseline delta on the continuous scale, given
   *  this cell. A tie is `{ kind: 'point', value: 0 }`. */
  delta: PairedValueLaw
}

export interface PairedPromotionAlternative {
  /** The registered joint law: the cell is drawn first, then the delta given
   *  the cell, so pass/fail and delta are dependent exactly as registered. */
  cells: ReadonlyArray<PairedPromotionAlternativeCell>
  /**
   * Law of the control arm's value on the continuous scale; the candidate is
   * control plus delta. Default `{ kind: 'point', value: 0 }`. The mean and
   * median bootstraps read only the deltas, so the baseline changes nothing
   * there; it matters only when a `'delta'` call infers its shape from the
   * observed values (see `continuous` on {@link PairedPromotionDecisionOptions}).
   */
  baseline?: PairedValueLaw
}

export interface PairedPromotionPowerCall {
  /** What the call reads from each simulated pair: `'delta'` gives it
   *  `(control, control + delta)` on the continuous scale, `'pass'` gives it
   *  each arm's pass/fail as `0` or `options.binaryScale ?? 1`. */
  outcome: 'delta' | 'pass'
  /** The call's options, exactly as the caller will run it. `minPairs`
   *  defaults to the simulated n, the value a gate seals; a caller-supplied
   *  value is kept, and one above n refuses every simulation. */
  options: PairedPromotionDecisionOptions
}

export interface PairedPromotionPowerOptions {
  /** Total paired episodes, ties included. */
  n: number
  alternative: PairedPromotionAlternative
  /** Every call must return `promote: true` for a simulation to count as a
   *  promotion. At least one call. */
  calls: ReadonlyArray<PairedPromotionPowerCall>
  /** Simulated data sets. Default 1000. */
  simulations?: number
  /** PRNG seed for the simulated draws (not the bootstrap's seed, which each
   *  call carries in its own options). Default 1. */
  seed?: number
}

export interface PairedPromotionCallRates {
  outcome: 'delta' | 'pass'
  /** Fraction of simulations in which this call alone promoted. */
  promote: number
  /** Fractions of simulations in which each refusal channel fired. */
  insufficient: number
  indeterminate: number
  exactTestVetoes: number
  /** Fraction in which the call was sufficient, determinate, not vetoed, and
   *  still did not clear its threshold. */
  hold: number
  /** Fraction of simulations decided by each method; the regime the call
   *  actually ran in at this n. */
  methods: Partial<Record<PairedDecisionMethod, number>>
}

export interface PairedPromotionPowerResult {
  n: number
  simulations: number
  seed: number
  /** Fraction of simulations in which every call promoted: the joint power. */
  power: number
  /** Monte Carlo standard error of `power`. */
  standardError: number
  /** Wilson 95% interval on `power`. */
  low: number
  high: number
  /** Fraction in which at least one call refused (insufficient, indeterminate
   *  or vetoed); the rest of the non-promotions are holds. */
  refuse: number
  hold: number
  /** Per-call rates, in the order the calls were supplied. */
  calls: PairedPromotionCallRates[]
}

export interface RequiredPairsForPairedPromotionOptions {
  /** Target joint power. Default 0.8. */
  target?: number
  alternative: PairedPromotionAlternative
  calls: ReadonlyArray<PairedPromotionPowerCall>
  /** Smallest n to consider. Default 1. */
  minPairs?: number
  /** Largest n to consider; the scan stops there with `n: null` if the target
   *  is never reached. Default 200. */
  maxPairs?: number
  simulations?: number
  seed?: number
}

export interface RequiredPairsForPairedPromotionResult {
  target: number
  /** Smallest n whose estimated joint power reaches the target, or null when
   *  no n up to `maxPairs` does. */
  n: number | null
  /** Smallest n whose Wilson lower bound reaches the target: the conservative
   *  choice, which a preregistration should prefer. Null when not reached. */
  nAtLowerBound: number | null
  /** Every n scanned, in order, with its full power estimate. The scan stops
   *  at `nAtLowerBound` when that is reached, else at `maxPairs`. */
  curve: PairedPromotionPowerResult[]
}

/**
 * Joint power of the configured calls at `n` under the registered alternative:
 * the fraction of simulated data sets on which every call promotes.
 */
export function pairedPromotionPower(
  options: PairedPromotionPowerOptions,
): PairedPromotionPowerResult {
  const n = options.n
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`pairedPromotionPower: n must be a positive integer, got ${n}`)
  }
  const simulations = options.simulations ?? 1000
  if (!Number.isInteger(simulations) || simulations < 1) {
    throw new Error(
      `pairedPromotionPower: simulations must be a positive integer, got ${simulations}`,
    )
  }
  const seed = options.seed ?? 1
  if (!Number.isFinite(seed)) {
    throw new Error(`pairedPromotionPower: seed must be finite, got ${seed}`)
  }
  const calls = validateCalls(options.calls)
  const alternative = validateAlternative(options.alternative, calls)
  const rng = mulberry32(seed)

  let promotions = 0
  let refusals = 0
  const perCall = calls.map(() => ({
    promote: 0,
    insufficient: 0,
    indeterminate: 0,
    exactTestVetoes: 0,
    hold: 0,
    methods: new Map<PairedDecisionMethod, number>(),
  }))

  for (let s = 0; s < simulations; s++) {
    const pairs = drawPairs(alternative, n, rng)
    let all = true
    let anyRefusal = false
    for (let c = 0; c < calls.length; c++) {
      const call = calls[c]!
      const decision = runCall(call, pairs, n)
      const tally = perCall[c]!
      tally.methods.set(decision.method, (tally.methods.get(decision.method) ?? 0) + 1)
      if (decision.promote) tally.promote++
      else {
        if (!decision.sufficient) tally.insufficient++
        if (decision.indeterminate) tally.indeterminate++
        if (decision.exactTestVetoes) tally.exactTestVetoes++
        if (decision.sufficient && !decision.indeterminate && !decision.exactTestVetoes) {
          tally.hold++
        }
      }
      if (!decision.promote) all = false
      if (!decision.sufficient || decision.indeterminate || decision.exactTestVetoes) {
        anyRefusal = true
      }
    }
    if (all) promotions++
    else if (anyRefusal) refusals++
  }

  const power = promotions / simulations
  const interval = wilson(promotions, simulations, 0.95)
  return {
    n,
    simulations,
    seed,
    power,
    standardError: Math.sqrt((power * (1 - power)) / simulations),
    low: interval.lower,
    high: interval.upper,
    refuse: refusals / simulations,
    hold: (simulations - promotions - refusals) / simulations,
    calls: perCall.map((tally, c) => ({
      outcome: calls[c]!.outcome,
      promote: tally.promote / simulations,
      insufficient: tally.insufficient / simulations,
      indeterminate: tally.indeterminate / simulations,
      exactTestVetoes: tally.exactTestVetoes / simulations,
      hold: tally.hold / simulations,
      methods: Object.fromEntries(
        [...tally.methods.entries()].map(([method, count]) => [method, count / simulations]),
      ) as Partial<Record<PairedDecisionMethod, number>>,
    })),
  }
}

/**
 * Smallest n at which {@link pairedPromotionPower} reaches the target, scanning
 * every n from `minPairs` upward. Both the point-estimate answer and the
 * Wilson-lower-bound answer are returned; the scan runs until the latter is
 * reached (so the curve past `n` is retained) or `maxPairs` is exhausted.
 */
export function requiredPairsForPairedPromotion(
  options: RequiredPairsForPairedPromotionOptions,
): RequiredPairsForPairedPromotionResult {
  const target = options.target ?? 0.8
  if (!Number.isFinite(target) || target <= 0 || target >= 1) {
    throw new Error(`requiredPairsForPairedPromotion: target must be in (0,1), got ${target}`)
  }
  const minPairs = options.minPairs ?? 1
  const maxPairs = options.maxPairs ?? 200
  if (!Number.isInteger(minPairs) || minPairs < 1) {
    throw new Error(
      `requiredPairsForPairedPromotion: minPairs must be a positive integer, got ${minPairs}`,
    )
  }
  if (!Number.isInteger(maxPairs) || maxPairs < minPairs) {
    throw new Error(
      `requiredPairsForPairedPromotion: maxPairs must be an integer >= minPairs, got ${maxPairs}`,
    )
  }
  const curve: PairedPromotionPowerResult[] = []
  let n: number | null = null
  let nAtLowerBound: number | null = null
  for (let candidate = minPairs; candidate <= maxPairs; candidate++) {
    const result = pairedPromotionPower({
      n: candidate,
      alternative: options.alternative,
      calls: options.calls,
      simulations: options.simulations,
      seed: options.seed,
    })
    curve.push(result)
    if (n === null && result.power >= target) n = candidate
    if (result.low >= target) {
      nAtLowerBound = candidate
      break
    }
  }
  return { target, n, nAtLowerBound, curve }
}

interface DrawnPairs {
  control: number[]
  candidate: number[]
  controlPass: boolean[]
  candidatePass: boolean[]
}

function drawPairs(
  alternative: PairedPromotionAlternative,
  n: number,
  rng: () => number,
): DrawnPairs {
  const baseline = alternative.baseline ?? { kind: 'point', value: 0 }
  const control: number[] = new Array(n)
  const candidate: number[] = new Array(n)
  const controlPass: boolean[] = new Array(n)
  const candidatePass: boolean[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const cell = drawCell(alternative.cells, rng)
    const base = drawValue(baseline, rng)
    control[i] = base
    candidate[i] = base + drawValue(cell.delta, rng)
    controlPass[i] = cell.pass?.control ?? false
    candidatePass[i] = cell.pass?.treatment ?? false
  }
  return { control, candidate, controlPass, candidatePass }
}

function drawCell(
  cells: ReadonlyArray<PairedPromotionAlternativeCell>,
  rng: () => number,
): PairedPromotionAlternativeCell {
  const u = rng()
  let cumulative = 0
  for (const cell of cells) {
    cumulative += cell.probability
    if (u < cumulative) return cell
  }
  // Rounding at the top of the cumulative sum lands here with probability ~0.
  return cells[cells.length - 1]!
}

function drawValue(law: PairedValueLaw, rng: () => number): number {
  switch (law.kind) {
    case 'point':
      return law.value
    case 'atoms': {
      const u = rng()
      let cumulative = 0
      for (const atom of law.atoms) {
        cumulative += atom.probability
        if (u < cumulative) return atom.value
      }
      return law.atoms[law.atoms.length - 1]!.value
    }
    case 'normal': {
      // Box-Muller; one normal per call keeps the stream simple and seeded.
      const u1 = 1 - rng()
      const u2 = rng()
      return law.mean + law.sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    }
  }
}

function runCall(
  call: PairedPromotionPowerCall,
  pairs: DrawnPairs,
  n: number,
): PairedPromotionDecision {
  const options: PairedPromotionDecisionOptions = { minPairs: n, ...call.options }
  if (call.outcome === 'pass') {
    const scale = call.options.binaryScale ?? 1
    return decidePairedPromotion(
      pairs.controlPass.map((p) => (p ? scale : 0)),
      pairs.candidatePass.map((p) => (p ? scale : 0)),
      { ...options, binaryScale: scale },
    )
  }
  return decidePairedPromotion(pairs.control, pairs.candidate, options)
}

function validateCalls(
  calls: ReadonlyArray<PairedPromotionPowerCall>,
): ReadonlyArray<PairedPromotionPowerCall> {
  if (!Array.isArray(calls) || calls.length === 0) {
    throw new Error('pairedPromotionPower: at least one call is required')
  }
  calls.forEach((call, i) => {
    if (call.outcome !== 'delta' && call.outcome !== 'pass') {
      throw new Error(`pairedPromotionPower: calls[${i}].outcome must be 'delta' or 'pass'`)
    }
    if (call.options === null || typeof call.options !== 'object') {
      throw new Error(`pairedPromotionPower: calls[${i}].options must be an object`)
    }
    if (
      call.options.minPairs !== undefined &&
      (!Number.isInteger(call.options.minPairs) || call.options.minPairs < 1)
    ) {
      throw new Error(
        `pairedPromotionPower: calls[${i}].options.minPairs must be a positive integer`,
      )
    }
  })
  return calls
}

function validateAlternative(
  alternative: PairedPromotionAlternative,
  calls: ReadonlyArray<PairedPromotionPowerCall>,
): PairedPromotionAlternative {
  if (!alternative || !Array.isArray(alternative.cells) || alternative.cells.length === 0) {
    throw new Error('pairedPromotionPower: alternative.cells must be a non-empty array')
  }
  const needsPass = calls.some((call) => call.outcome === 'pass')
  let total = 0
  alternative.cells.forEach((cell, i) => {
    if (!Number.isFinite(cell.probability) || cell.probability < 0) {
      throw new Error(`pairedPromotionPower: cells[${i}].probability must be a finite number >= 0`)
    }
    total += cell.probability
    if (needsPass) {
      if (
        !cell.pass ||
        typeof cell.pass.control !== 'boolean' ||
        typeof cell.pass.treatment !== 'boolean'
      ) {
        throw new Error(
          `pairedPromotionPower: cells[${i}].pass must give control and treatment booleans when a 'pass' call is configured`,
        )
      }
    }
    validateLaw(cell.delta, `cells[${i}].delta`)
  })
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`pairedPromotionPower: cell probabilities must sum to 1, got ${total}`)
  }
  if (alternative.baseline !== undefined) validateLaw(alternative.baseline, 'baseline')
  return alternative
}

function validateLaw(law: PairedValueLaw, where: string): void {
  if (!law || typeof law !== 'object') {
    throw new Error(`pairedPromotionPower: ${where} must be a law object`)
  }
  switch (law.kind) {
    case 'point':
      if (!Number.isFinite(law.value)) {
        throw new Error(`pairedPromotionPower: ${where}.value must be finite`)
      }
      return
    case 'atoms': {
      if (!Array.isArray(law.atoms) || law.atoms.length === 0) {
        throw new Error(`pairedPromotionPower: ${where}.atoms must be a non-empty array`)
      }
      let total = 0
      law.atoms.forEach((atom, i) => {
        if (!Number.isFinite(atom.value)) {
          throw new Error(`pairedPromotionPower: ${where}.atoms[${i}].value must be finite`)
        }
        if (!Number.isFinite(atom.probability) || atom.probability < 0) {
          throw new Error(
            `pairedPromotionPower: ${where}.atoms[${i}].probability must be a finite number >= 0`,
          )
        }
        total += atom.probability
      })
      if (Math.abs(total - 1) > 1e-9) {
        throw new Error(
          `pairedPromotionPower: ${where}.atoms probabilities must sum to 1, got ${total}`,
        )
      }
      return
    }
    case 'normal':
      if (!Number.isFinite(law.mean) || !Number.isFinite(law.sd) || law.sd < 0) {
        throw new Error(`pairedPromotionPower: ${where} needs a finite mean and a finite sd >= 0`)
      }
      return
    default:
      throw new Error(`pairedPromotionPower: ${where}.kind must be 'point', 'atoms' or 'normal'`)
  }
}
