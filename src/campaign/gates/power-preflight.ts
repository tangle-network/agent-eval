/**
 * Approximate detectable lift from baseline variance and the intended sample size.
 *
 * Model: the ship rule is `CI.low(paired Δ) > deltaThreshold`. Approximating the
 * bootstrap CI as normal, `CI.low ≈ effect − z·sd_Δ/√n`, so the smallest shippable
 * effect is `MDE = deltaThreshold + z·sd_Δ/√n`. This estimates `sd_Δ` as
 * `√2·sd_baseline`, assuming equal arm variances and zero paired correlation.
 * Actual candidate variance and paired correlation can move the threshold in either direction.
 * This diagnostic does not replace the gate or guarantee a detection probability.
 *
 * Supply one baseline mean per independent observation used by the comparison.
 * With declared source units, repetitions and variants refine those means without increasing n.
 * `selfImprove` attaches this diagnostic after its final measurement.
 */

export interface PowerPreflightOptions {
  /** Baseline composites at the comparison's independent observation unit. */
  baselineComposites: number[]
  /** Independent paired observations planned for the comparison.
   *  Defaults to `baselineComposites.length`. */
  pairedN?: number
  /** The ship gate's effect-size threshold. Default 0.05 (defaultProductionGate). */
  deltaThreshold?: number
  /** CI confidence the gate uses. Default 0.95. */
  confidence?: number
  /** Whether the holdout uses the gate's judge family.
   *  More observations cannot establish freedom from systematic scoring bias.
   *  Default false. */
  sharedScorerChannel?: boolean
}

export interface PowerPreflight {
  /** Paired observations the comparison will have. */
  n: number
  /** Sample standard deviation of baseline observation means. */
  sd: number
  /** Approximate lift needed to put a normal interval above the gate threshold. */
  mde: number
  /** Baseline holdout composite mean. */
  baselineMean: number
  /** Headroom to a perfect 1.0 composite (the largest achievable lift on a [0,1] judge). */
  headroom: number
  /** Whether this approximation exceeds the estimated [0,1] score headroom.
   *  This is a planning warning, not a proof that promotion is impossible. */
  underpowered: boolean
  /** True when composites look [0,1]-scaled; headroom/underpowered are only
   *  meaningful under that convention (0-100 judges get mde/sd/n but no verdict). */
  scaleAssumed: boolean
  deltaThreshold: number
  confidence: number
  /** Notes unmeasured systematic bias when the gate shares its scoring channel. */
  sharedChannelCaveat?: string
  /** One actionable sentence for humans and logs. */
  recommendation: string
}

/** Two-sided z for the common confidence levels; interpolation is overkill here. */
function zFor(confidence: number): number {
  if (confidence >= 0.99) return 2.576
  if (confidence >= 0.95) return 1.96
  if (confidence >= 0.9) return 1.645
  return 1.282
}

/** Estimate detectable lift from baseline independent observations before budgeting a comparison. */
export function powerPreflight(opts: PowerPreflightOptions): PowerPreflight {
  const composites = opts.baselineComposites.filter((v) => Number.isFinite(v))
  if (composites.length < 3) {
    throw new Error(
      `powerPreflight: need >= 3 finite baseline composites to estimate variance, got ${composites.length}`,
    )
  }
  const deltaThreshold = opts.deltaThreshold ?? 0.05
  const confidence = opts.confidence ?? 0.95
  const n = opts.pairedN ?? composites.length
  if (n < 2) throw new Error(`powerPreflight: pairedN must be >= 2, got ${n}`)

  const mean = composites.reduce((a, b) => a + b, 0) / composites.length
  const variance =
    composites.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (composites.length - 1)
  const sd = Math.sqrt(variance)
  const z = zFor(confidence)
  const mde = deltaThreshold + (z * Math.SQRT2 * sd) / Math.sqrt(n)

  const scaleAssumed = composites.every((v) => v >= -0.001 && v <= 1.5)
  const headroom = Math.max(0, 1 - mean)
  const underpowered = scaleAssumed && mde > headroom

  const sharedChannelCaveat = opts.sharedScorerChannel
    ? 'Holdout and gate share one scoring channel: systematic judge bias remains outside this estimate. An independent second scoring channel can help test that bias.'
    : undefined

  const recommendation = underpowered
    ? `UNDERPOWERED under this approximation: detectable lift ${mde.toFixed(3)} exceeds the ${headroom.toFixed(3)} headroom above the baseline (${mean.toFixed(3)}). Raise paired n using independent observations to ~${Math.ceil(((z * Math.SQRT2 * sd) / Math.max(headroom - deltaThreshold, 0.01)) ** 2)} or reduce observation variance. Recheck with measured paired deltas.`
    : `Approximate detectable lift at n=${n}: ${mde.toFixed(3)} (baseline sd ${sd.toFixed(3)}). Compare this estimate with the effect you expect, then recheck using measured paired deltas.`

  return {
    n,
    sd,
    mde,
    baselineMean: mean,
    headroom,
    underpowered,
    scaleAssumed,
    deltaThreshold,
    confidence,
    ...(sharedChannelCaveat ? { sharedChannelCaveat } : {}),
    recommendation: sharedChannelCaveat
      ? `${recommendation} ${sharedChannelCaveat}`
      : recommendation,
  }
}
