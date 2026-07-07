/**
 * Power preflight — "can this budget detect the effect you are hunting?"
 *
 * The failure it prevents (measured, twice): a live prompt-improvement campaign ran
 * 333 sandbox cells over 5.6 hours and produced a +0.08 holdout lift the ship gate
 * (paired bootstrap, CI.low > 0.05) could not distinguish from zero — because at
 * that holdout size and worker variance the MINIMUM DETECTABLE lift was larger than
 * any effect a prompt change plausibly produces. The budget was spent learning what
 * a 30-second calculation on the baseline cells already knew. No eval framework we
 * know of surfaces this; every underpowered improvement run everywhere ends in an
 * uninformative "hold".
 *
 * Model: the ship rule is `CI.low(paired Δ) > deltaThreshold`. Approximating the
 * bootstrap CI as normal, `CI.low ≈ effect − z·sd_Δ/√n`, so the smallest shippable
 * true effect is `MDE = deltaThreshold + z·sd_Δ/√n`. The paired-delta SD is unknown
 * before the candidate exists; we bound it by the zero-correlation case
 * `sd_Δ ≤ √2·sd_baseline` — a CONSERVATIVE (upper) MDE, which is the correct
 * direction for a warning. Pairing is per cell (`scenario:rep`), so reps multiply n.
 *
 * Standalone by design: feed it any baseline composites (a `gate:'none'` run, a
 * live-proof table) BEFORE budgeting the real search; `selfImprove` also attaches
 * it to every result and warns when the run was structurally unable to ship.
 */

export interface PowerPreflightOptions {
  /** Per-cell baseline composites on the HOLDOUT scenarios (one per scenario:rep cell). */
  baselineComposites: number[]
  /** Paired observations the budgeted comparison will produce
   *  (holdout scenarios × reps). Defaults to `baselineComposites.length`. */
  pairedN?: number
  /** The ship gate's effect-size threshold. Default 0.05 (defaultProductionGate). */
  deltaThreshold?: number
  /** CI confidence the gate uses. Default 0.95. */
  confidence?: number
  /** True when the holdout is scored by the SAME judge/scorer family as the gate
   *  (selfImprove's default composition — one judge scores everything). Under a
   *  shared channel, raising paired n reduces only the IDIOSYNCRATIC noise share;
   *  systematic judge bias is untouched, so the MDE here is a lower bound and the
   *  only full debiaser is an independent second scoring channel
   *  (recursive-self-improvement S1c, closed form in EXP-023 P0). Default false. */
  sharedScorerChannel?: boolean
}

export interface PowerPreflight {
  /** Paired observations the comparison will have. */
  n: number
  /** Baseline per-cell composite standard deviation (the variance the effect must beat). */
  sd: number
  /** Minimum detectable lift: the smallest TRUE effect the gate could ship at this budget. */
  mde: number
  /** Baseline holdout composite mean. */
  baselineMean: number
  /** Headroom to a perfect 1.0 composite (the largest achievable lift on a [0,1] judge). */
  headroom: number
  /** True when even the largest achievable effect (headroom) is below the MDE —
   *  the run is structurally unable to ship regardless of proposal quality.
   *  Only asserted for [0,1]-scaled judges (see `scaleAssumed`). */
  underpowered: boolean
  /** True when composites look [0,1]-scaled; headroom/underpowered are only
   *  meaningful under that convention (0-100 judges get mde/sd/n but no verdict). */
  scaleAssumed: boolean
  deltaThreshold: number
  confidence: number
  /** Set when the holdout shares the gate's scoring channel: more cells cannot
   *  buy back systematic judge bias — treat the MDE as a lower bound. */
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

/** Estimate the minimum detectable lift a paired-holdout improvement run can
 *  ship at a given budget, from the baseline holdout composites — call it BEFORE
 *  spending a search to learn whether the effect you are hunting is even
 *  observable at this holdout size and worker variance. */
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
    ? 'Holdout and gate share one scoring channel: raising n/reps reduces only idiosyncratic noise — systematic judge bias remains and this MDE is a lower bound. Full debiasing needs an independent second scoring channel (different judge/benchmark family).'
    : undefined

  const recommendation = underpowered
    ? `UNDERPOWERED: minimum detectable lift ${mde.toFixed(3)} exceeds the ${headroom.toFixed(3)} headroom above the baseline (${mean.toFixed(3)}) — no achievable effect can ship at this budget. Raise paired n (scenarios x reps) to ~${Math.ceil(((z * Math.SQRT2 * sd) / Math.max(headroom - deltaThreshold, 0.01)) ** 2)} or reduce worker variance before searching.`
    : `Minimum detectable lift at n=${n}: ${mde.toFixed(3)} (baseline sd ${sd.toFixed(3)}). Effects smaller than this cannot clear the gate; budget the search for effects you believe exceed it.`

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
