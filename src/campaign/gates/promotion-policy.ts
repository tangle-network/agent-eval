/**
 * Build paired evidence for each objective and apply a promotion policy.
 * The default policy requires at least one gain and every regression floor to
 * clear. A floor can fail because a larger loss remains plausible; that does
 * not demonstrate an observed regression. Missing evidence stays unresolved.
 * Confidence intervals apply to each axis, without a multiplicity adjustment.
 *
 * Cost and latency remain aggregate constraints because GateContext does not
 * supply paired observations for them. Compose a budget gate when needed.
 */

import {
  decidePairedPromotion,
  type PairedDecisionMethod,
  type PairedDecisionStatistic,
  type PairedMcNemarEvidence,
} from '../../paired-promotion-decision'
import type { Direction } from '../../pareto'
import {
  DECISION_PAIRED_DELTA_STATISTIC,
  type PairedBootstrapResult,
  pairedBootstrap,
} from '../../statistics'
import type { Gate, GateContext, GateDecision, GateResult, JudgeScore, Scenario } from '../types'
import { detectScale, pairHoldout } from './statistical-heldout'

/** Where an objective's per-cell scalar comes from. `composite` reads the
 *  judge's composite; `dimension` reads a named per-dimension score. */
export type ObjectiveSource = { kind: 'composite' } | { kind: 'dimension'; dimension: string }

export interface PromotionObjective {
  /** Stable label used in reports + `contributingGates`. */
  name: string
  source: ObjectiveSource
  /** 'maximize' (quality dims) or 'minimize' (error/risk/length dims). Orients
   *  the paired delta so a positive bootstrap always means "candidate better". */
  direction: Direction
  /** Declared binary support {0, binaryScale}, including zero-only observations.
   *  Must be finite and positive; paired cell scores must be 0 or this scale.
   *  Uses the risk-difference mean and rejects the 'median' statistic. */
  binaryScale?: number
  /** The good-direction paired-delta CI lower bound must EXCEED this to count
   *  as a significant gain on this axis. Interpreted in the judge's native
   *  scale. Default 0 (⇒ "confidently better"). */
  gainThreshold?: number
  /** A floor breach (regression) is declared when the good-direction CI lower
   *  bound is below −floorTolerance, or when the exact small-sample test proves
   *  a drop past it. Defaults to 0.05 times the declared binary scale, or
   *  auto-scales off observed magnitudes (0.05 on [0,1], 5 on 0-100). */
  floorTolerance?: number
}

/** Per-axis verdict from the shared paired decision rule.
 *  'regressed' includes uncertainty that prevents clearing the regression floor. */
export type AxisVerdict = 'improved' | 'regressed' | 'flat' | 'few_runs' | 'indeterminate'

export interface AxisEvidence {
  name: string
  source: ObjectiveSource
  direction: Direction
  /** Paired bootstrap on the GOOD-DIRECTION delta (oriented by `direction`):
   *  a positive value means the candidate is better on this axis.
   *
   *  DIAGNOSTIC on a pass/fail axis: there the verdict is decided on Tango's
   *  score interval instead, because a percentile bootstrap over a three-atom
   *  delta lattice is not a valid interval at the nonzero margin `floorTolerance`
   *  and `gainThreshold` create. `ci` carries the interval that decided. */
  bootstrap: PairedBootstrapResult
  /** Which paired statistic `bootstrap.low`/`.high` bracket. `'mean'` unless the
   *  caller asked for the median — on a pass/fail axis the median and its whole
   *  CI are pinned at 0 by tie domination and can see neither a gain nor a
   *  regression. `bootstrap.median` still carries the median point estimate. */
  bootstrapStatistic: 'median' | 'mean'
  /** The interval the axis verdict was actually decided on, good-direction and
   *  in the axis's native units. */
  ci: { low: number; high: number }
  /** Which estimator produced `ci`. */
  decisionStatistic: PairedDecisionStatistic
  /** McNemar's exact evidence on a pass/fail axis; null otherwise. */
  mcnemar: PairedMcNemarEvidence | null
  /** `ci` has zero width or non-finite bounds. It cannot establish a gain or
   *  clear a regression floor, regardless of the point estimate. */
  indeterminate: boolean
  /** Paired observations contributing to this axis. */
  n: number
  minimumRequired: number
  decisionMethod: PairedDecisionMethod
  gainThreshold: number
  floorTolerance: number
  verdict: AxisVerdict
}

export interface EvidenceVector {
  /** One entry per objective — NOTHING averaged across axes. */
  axes: AxisEvidence[]
  /** Smallest paired n across axes that produced observations — the binding
   *  evidence-sufficiency constraint. 0 when no axis produced observations. */
  minN: number
  /** Aggregate per-side cost from the gate context (a constraint input, not a
   *  CI axis — see the module header). */
  cost: { candidate: number; baseline: number }
}

/** A promotion strategy: a pure function from the evidence vector to a verdict.
 *  Many policies can run over the same `EvidenceVector` and disagree — that's
 *  the point (competing strategies, shared evidence). */
export type PromotionPolicy = (ev: EvidenceVector) => GateResult

export interface BuildEvidenceVectorOptions {
  /** Minimum paired observations before an axis can claim significance; below
   *  it the axis is `few_runs`. The exact small-sample test may require more
   *  observations at the selected confidence. */
  minProductiveRuns?: number
  /** Confidence level for every axis bootstrap. Default 0.95. */
  confidence?: number
  /** Bootstrap resamples. Default 2000. */
  resamples?: number
  /** Fixed bootstrap seed for a deterministic, reproducible verdict. Default 1337. */
  seed?: number
  /** Paired statistic every axis CI is computed on. Default `'mean'` — see
   *  {@link DECISION_PAIRED_DELTA_STATISTIC} for why the median is not. */
  statistic?: 'mean' | 'median'
}

/**
 * The Evidence Bus. For each objective, pair candidate vs baseline by full
 * cellId and bootstrap a CI on the good-direction paired delta. Reuses the
 * exact `pairHoldout` + `pairedBootstrap` machinery the held-out gate uses, so
 * a single source of truth governs pairing granularity + scale handling.
 */
export function buildEvidenceVector<TArtifact, TScenario extends Scenario>(
  ctx: GateContext<TArtifact, TScenario>,
  objectives: PromotionObjective[],
  opts: BuildEvidenceVectorOptions = {},
): EvidenceVector {
  if (objectives.length === 0) {
    throw new Error('buildEvidenceVector: at least 1 objective required')
  }
  const confidence = opts.confidence ?? 0.95
  const resamples = opts.resamples ?? 2000
  const seed = opts.seed ?? 1337
  const baseline = ctx.baselineJudgeScores ?? ctx.judgeScores
  const scenarioIds = new Set(ctx.scenarios.map((s) => s.id))

  const axes: AxisEvidence[] = []
  for (const obj of objectives) {
    let select: (s: JudgeScore) => number | undefined
    if (obj.source.kind === 'composite') {
      select = (s) => s.composite
    } else {
      const dim = obj.source.dimension
      select = (s) => s.dimensions[dim]
    }
    const paired = pairHoldout(ctx.judgeScores, baseline, scenarioIds, select)
    // Orient to the good direction: maximize ⇒ bootstrap (candidate − baseline);
    // minimize ⇒ bootstrap (baseline − candidate) by swapping args, so a
    // positive bootstrap always reads as "candidate better on this axis".
    const before = obj.direction === 'maximize' ? paired.before : paired.after
    const after = obj.direction === 'maximize' ? paired.after : paired.before
    const n = paired.before.length
    const binaryScale = obj.binaryScale
    const floorTolerance =
      obj.floorTolerance ?? 0.05 * (binaryScale ?? detectScale([...paired.before, ...paired.after]))
    const gainThreshold = obj.gainThreshold ?? 0
    // Axes are decided on the MEAN paired delta — which for a pass/fail axis is
    // exactly the change in success rate. The median is structurally blind on
    // the shapes eval data lands in: with most pairs tied its bootstrap CI
    // collapses to [0,0] and the axis reads 'flat', hiding real gains AND real
    // regressions — pass/fail axes on ANY encoding ({0,1} and the 0-100 one
    // `detectScale` exists for), and low-cardinality axes even below half ties.
    // Orthogonal to `pairedDeltaTest`'s own small-sample switch: that picks the
    // TEST (bootstrap CI at n ≥ 20, exact sign test below), this picks the
    // ESTIMATOR the test is applied to. Both are needed — an exact sign test on
    // a tie-pinned median is still blind.
    const bootstrapStatistic = opts.statistic ?? DECISION_PAIRED_DELTA_STATISTIC
    // Both burdens of proof route through the ONE shared rule
    // (`decidePairedPromotion`), so a pass/fail axis is judged on Tango's score
    // interval — the only paired-binary construction valid at the nonzero
    // margins `gainThreshold` / `floorTolerance` create — and a zero-width
    // interval cannot buy a verdict in either direction.
    const improvement = decidePairedPromotion(before, after, {
      confidence,
      resamples,
      statistic: bootstrapStatistic,
      seed,
      threshold: gainThreshold,
      minPairs: opts.minProductiveRuns,
      binaryScale,
    })
    const regression = decidePairedPromotion(after, before, {
      confidence,
      resamples,
      statistic: bootstrapStatistic,
      seed,
      threshold: floorTolerance,
      minPairs: opts.minProductiveRuns,
      binaryScale,
    })
    const bootstrap =
      improvement.bootstrap ??
      pairedBootstrap(before, after, {
        confidence,
        resamples,
        statistic: bootstrapStatistic,
        seed,
      })
    // A floor breach fires on EITHER burden of proof, because they cover
    // different failures and the floor is the anti-Goodhart guard:
    //   - `improvement.low < -floorTolerance` — the CREDIBLE WORST CASE exceeds
    //     the tolerance. This is the contract `AxisEvidence.floorTolerance` and
    //     `paretoPolicy`'s own reason string state, and it is the conservative
    //     posture a safety axis needs: block unless the data can rule the
    //     breach out, rather than waiting for the breach to be proven. Read off
    //     the DECIDING interval, so a pass/fail axis is not screened by a
    //     bootstrap that is pinned wherever ties dominate.
    //   - `regression.promote` — a PROVEN drop past the tolerance. Adds the
    //     small-sample path, where the decision is an exact sign test because
    //     the bootstrap interval is descriptive only.
    // A tied binary axis still has uncertainty about unseen discordant pairs.
    // Its diagnostic bootstrap collapses to zero, so only the deciding score
    // interval can establish that a regression stays within the declared floor.
    const floorBreached = improvement.low < -floorTolerance || regression.promote
    // Floor check precedes the gain check: a credible regression must never be
    // masked as "improved". With the defaults (gainThreshold 0, positive floor)
    // the regions are disjoint and order is moot, but a consumer who sets a
    // negative gainThreshold ("accept small dips") could otherwise have a real
    // floor breach classified as a gain — anti-Goodhart wins the tie.
    const verdict: AxisVerdict = !improvement.sufficient
      ? 'few_runs'
      : improvement.indeterminate
        ? 'indeterminate'
        : floorBreached
          ? 'regressed'
          : improvement.promote
            ? 'improved'
            : 'flat'
    axes.push({
      name: obj.name,
      source: obj.source,
      direction: obj.direction,
      bootstrap,
      bootstrapStatistic,
      ci: { low: improvement.low, high: improvement.high },
      decisionStatistic: improvement.statistic,
      mcnemar: improvement.mcnemar,
      indeterminate: improvement.indeterminate,
      n,
      minimumRequired: improvement.minimumPairs,
      decisionMethod: improvement.method,
      gainThreshold,
      floorTolerance,
      verdict,
    })
  }
  const ns = axes.map((a) => a.n).filter((n) => n > 0)
  const minN = ns.length > 0 ? Math.min(...ns) : 0
  return { axes, minN, cost: { candidate: ctx.cost.candidate, baseline: ctx.cost.baseline } }
}

/**
 * Require a supported gain and every configured regression floor to clear.
 * A failed floor holds the candidate, including when uncertainty permits a loss.
 * Missing or indeterminate evidence requires more work; no gain holds release.
 */
export const paretoPolicy: PromotionPolicy = (ev) => {
  const contributingGates = ev.axes.map((ax) => ({
    name: `objective:${ax.name}`,
    status:
      ax.verdict === 'regressed'
        ? ('fail' as const)
        : ax.verdict === 'few_runs' || ax.verdict === 'indeterminate'
          ? ('not_evaluated' as const)
          : ('pass' as const),
    detail: {
      direction: ax.direction,
      source: ax.source,
      verdict: ax.verdict,
      n: ax.n,
      deltaMedian: ax.bootstrap.median,
      ciLow: ax.ci.low,
      ciHigh: ax.ci.high,
      decisionStatistic: ax.decisionStatistic,
      decisionMethod: ax.decisionMethod,
      mcnemar: ax.mcnemar,
      indeterminate: ax.indeterminate,
      bootstrapCiLow: ax.bootstrap.low,
      bootstrapCiHigh: ax.bootstrap.high,
      confidence: ax.bootstrap.confidence,
      gainThreshold: ax.gainThreshold,
      floorTolerance: ax.floorTolerance,
    },
  }))

  const regressed = ev.axes.filter((a) => a.verdict === 'regressed')
  const insufficient = ev.axes.filter(
    (a) => a.verdict === 'few_runs' || a.verdict === 'indeterminate',
  )
  const improved = ev.axes.filter((a) => a.verdict === 'improved')

  let decision: GateDecision
  const reasons: string[] = []
  if (regressed.length > 0) {
    // A gain on another axis cannot excuse an unresolved regression floor.
    decision = 'hold'
    for (const a of regressed) {
      reasons.push(
        `objective '${a.name}' did not clear its regression floor -${a.floorTolerance}: good-direction CI [${a.ci.low.toFixed(3)}, ${a.ci.high.toFixed(3)}] (n=${a.n})`,
      )
    }
  } else if (insufficient.length > 0) {
    // An unresolved axis cannot establish either a gain or a safe floor.
    decision = 'need_more_work'
    for (const a of insufficient) {
      reasons.push(
        a.verdict === 'few_runs'
          ? `objective '${a.name}' has only n=${a.n} paired runs — insufficient evidence to claim significance`
          : `objective '${a.name}' has an indeterminate deciding CI [${a.ci.low}, ${a.ci.high}] — insufficient evidence to clear its regression floor (n=${a.n})`,
      )
    }
  } else if (improved.length > 0) {
    decision = 'ship'
    reasons.push(
      `Supported objective gain: ${improved
        .map(
          (a) =>
            `'${a.name}' +${a.ci.low > 0 ? a.ci.low.toFixed(3) : a.bootstrap.mean.toFixed(3)} (CI.low ${a.ci.low.toFixed(3)})`,
        )
        .join(', ')}; every regression floor cleared`,
    )
  } else {
    // Every floor cleared, but no objective demonstrated a significant gain.
    decision = 'hold'
    reasons.push(
      'no Pareto improvement: no objective shows a significant gain; every regression floor cleared',
    )
  }

  // `delta` surfaces the composite axis if present, else the first axis — a
  // single convenience scalar; the vector lives in `contributingGates`.
  const composite = ev.axes.find((a) => a.source.kind === 'composite') ?? ev.axes[0]
  return { decision, reasons, contributingGates, delta: composite?.bootstrap.median }
}

export interface ParetoSignificanceGateOptions extends BuildEvidenceVectorOptions {
  /** The objective vector. Every axis is both a gain source and a safety floor. */
  objectives: PromotionObjective[]
  /** Strategy applied to the evidence vector. Default `paretoPolicy`. Override
   *  to run a stricter/looser strategy over the SAME bus (competing policies). */
  policy?: PromotionPolicy
  /** Override the gate name in reports. */
  name?: string
}

/**
 * Wrap the bus + a policy as a `Gate`. Plugs into the existing
 * `runImprovementLoop({ gate })` slot and composes via `composeGate`; default
 * loop behavior is unchanged because consumers opt in by passing this gate.
 */
export function paretoSignificanceGate<TArtifact = unknown, TScenario extends Scenario = Scenario>(
  options: ParetoSignificanceGateOptions,
): Gate<TArtifact, TScenario> {
  if (options.objectives.length === 0) {
    throw new Error('paretoSignificanceGate: at least 1 objective required')
  }
  const policy = options.policy ?? paretoPolicy
  return {
    name: options.name ?? 'paretoSignificanceGate',
    async decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult> {
      const ev = buildEvidenceVector(ctx, options.objectives, options)
      return policy(ev)
    },
  }
}
