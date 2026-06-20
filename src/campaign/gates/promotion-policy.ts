/**
 * Promotion policy over the evidence VECTOR — the substrate's answer to "never
 * collapse the multi-objective promotion decision into one scalar." A
 * `defaultProductionGate` is one opinionated composition; this module factors
 * the decision into two reusable pieces so MANY policies can compete over the
 * SAME evidence (the quant-desk pattern: one evidence bus, plural strategies):
 *
 *   buildEvidenceVector(ctx, objectives, opts) -> EvidenceVector   // the bus
 *   PromotionPolicy = (ev: EvidenceVector) => GateResult           // a strategy
 *   paretoPolicy(ev)                                               // the default strategy
 *   paretoSignificanceGate(options): Gate                          // bus + policy as a Gate
 *
 * The Pareto policy is SYMMETRIC multi-objective: every objective is BOTH a
 * potential gain source AND a safety floor (unlike `defaultProductionGate`,
 * where only `composite` can win and `criticalDimensions` are pure floors). A
 * candidate ships iff it weakly DOMINATES the baseline at the confidence level —
 * no objective credibly worse (CI floor breach) AND at least one objective
 * credibly better (CI gain). Insufficient evidence on ANY axis -> need_more_work
 * (NOT folded into hold: "gather more reps" and "reject" are different actions).
 *
 * Cost/latency are NOT CI axes here — `GateContext` carries only an aggregate
 * per-side cost, no per-cell observation vector to bootstrap. Treat them as hard
 * constraints (compose with a budget gate via `composeGate`), not faked CIs.
 */

import type { Direction } from '../../pareto'
import { type PairedBootstrapResult, pairedBootstrap } from '../../statistics'
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
  /** The good-direction paired-delta CI lower bound must EXCEED this to count
   *  as a significant gain on this axis. Interpreted in the judge's native
   *  scale. Default 0 (⇒ "confidently better"). */
  gainThreshold?: number
  /** A floor breach (regression) is declared when the good-direction CI lower
   *  bound is below −floorTolerance. When omitted it auto-scales off observed
   *  magnitudes (0.05 on [0,1], 5 on 0-100), matching `dimensionRegressions`. */
  floorTolerance?: number
}

/** Per-axis verdict from the good-direction paired bootstrap. */
export type AxisVerdict = 'improved' | 'regressed' | 'flat' | 'few_runs'

export interface AxisEvidence {
  name: string
  source: ObjectiveSource
  direction: Direction
  /** Paired bootstrap on the GOOD-DIRECTION delta (oriented by `direction`):
   *  a positive value means the candidate is better on this axis. */
  bootstrap: PairedBootstrapResult
  /** Paired observations contributing to this axis. */
  n: number
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
   *  it the axis is `few_runs`. Default 3. */
  minProductiveRuns?: number
  /** Confidence level for every axis bootstrap. Default 0.95. */
  confidence?: number
  /** Bootstrap resamples. Default 2000. */
  resamples?: number
  /** Fixed bootstrap seed for a deterministic, reproducible verdict. Default 1337. */
  seed?: number
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
  const minProductiveRuns = opts.minProductiveRuns ?? 3
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
    const bootstrap = pairedBootstrap(before, after, {
      confidence,
      resamples,
      statistic: 'median',
      seed,
    })
    const n = paired.before.length
    const floorTolerance =
      obj.floorTolerance ?? 0.05 * detectScale([...paired.before, ...paired.after])
    const gainThreshold = obj.gainThreshold ?? 0
    // Floor check precedes the gain check: a credible regression must never be
    // masked as "improved". With the defaults (gainThreshold 0, positive floor)
    // the regions are disjoint and order is moot, but a consumer who sets a
    // negative gainThreshold ("accept small dips") could otherwise have a real
    // floor breach classified as a gain — anti-Goodhart wins the tie.
    const verdict: AxisVerdict =
      n < minProductiveRuns
        ? 'few_runs'
        : bootstrap.low < -floorTolerance
          ? 'regressed'
          : bootstrap.low > gainThreshold
            ? 'improved'
            : 'flat'
    axes.push({
      name: obj.name,
      source: obj.source,
      direction: obj.direction,
      bootstrap,
      n,
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
 * The default strategy: symmetric multi-objective Pareto significance. Ship iff
 * the candidate weakly dominates the baseline at the confidence level — no axis
 * credibly worse AND ≥1 axis credibly better. Floor breach on any axis → hold
 * (anti-Goodhart, dominates everything). Insufficient evidence on any axis →
 * need_more_work. Statistically equivalent → hold (never ship noise).
 */
export const paretoPolicy: PromotionPolicy = (ev) => {
  const contributingGates = ev.axes.map((ax) => ({
    name: `objective:${ax.name}`,
    passed: ax.verdict === 'improved',
    detail: {
      direction: ax.direction,
      source: ax.source,
      verdict: ax.verdict,
      n: ax.n,
      deltaMedian: ax.bootstrap.median,
      ciLow: ax.bootstrap.low,
      ciHigh: ax.bootstrap.high,
      confidence: ax.bootstrap.confidence,
      gainThreshold: ax.gainThreshold,
      floorTolerance: ax.floorTolerance,
    },
  }))

  const regressed = ev.axes.filter((a) => a.verdict === 'regressed')
  const fewRuns = ev.axes.filter((a) => a.verdict === 'few_runs')
  const improved = ev.axes.filter((a) => a.verdict === 'improved')

  let decision: GateDecision
  const reasons: string[] = []
  if (regressed.length > 0) {
    // Floor breach dominates: a credible regression on ANY axis blocks ship even
    // if another axis improved. This makes the +gain/−safety false positive
    // structurally impossible whenever the safety dim is an objective.
    decision = 'hold'
    for (const a of regressed) {
      reasons.push(
        `objective '${a.name}' regressed: good-direction CI.low ${a.bootstrap.low.toFixed(3)} < -${a.floorTolerance} (n=${a.n})`,
      )
    }
  } else if (fewRuns.length > 0) {
    // No credible regression on the scored axes, but ≥1 axis lacks the evidence
    // to claim a gain ⇒ gather more reps, do NOT reject.
    decision = 'need_more_work'
    for (const a of fewRuns) {
      reasons.push(
        `objective '${a.name}' has only n=${a.n} paired runs — insufficient evidence to claim significance`,
      )
    }
  } else if (improved.length > 0) {
    // Weakly dominates (no axis worse) AND strictly better on ≥1 axis ⇒ a Pareto
    // improvement at the confidence level.
    decision = 'ship'
    reasons.push(
      `Pareto improvement at the confidence level: ${improved
        .map(
          (a) =>
            `'${a.name}' +${a.bootstrap.median.toFixed(3)} (CI.low ${a.bootstrap.low.toFixed(3)})`,
        )
        .join(', ')}; no objective regressed`,
    )
  } else {
    // Enough evidence, nothing credibly better or worse ⇒ statistically
    // equivalent. Do NOT ship a no-op.
    decision = 'hold'
    reasons.push(
      'no Pareto improvement: candidate statistically equivalent to baseline on every objective',
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
