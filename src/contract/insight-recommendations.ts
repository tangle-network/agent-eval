/** Release readiness and recommended actions from an insight report's evidence. */

import type {
  FailureClassTally,
  FailureClusterInsight,
  InsightReport,
  InterRaterInsight,
  JudgeInsight,
  LiftInsight,
  OutcomeCorrelationInsight,
  PriorPeriodComparison,
  Recommendation,
  ScalarDistribution,
} from './insight-report'

interface RecommendationContext {
  composite: ScalarDistribution
  judges: Record<string, JudgeInsight>
  interRater?: InterRaterInsight
  lift?: LiftInsight
  failureClusters?: FailureClusterInsight
  failureClasses?: FailureClassTally[]
  contamination?: InsightReport['contamination']
  outcomeCorrelation?: OutcomeCorrelationInsight
  priorPeriodComparison?: PriorPeriodComparison
  threshold: number
}

/** A bootstrap interval with no spread: every resample landed on the same
 *  value, so the interval carries no information about how far the point
 *  estimate could be wrong and cannot support a directional claim. */
function zeroWidth(ci: readonly [number, number]): boolean {
  return !Number.isFinite(ci[0]) || !Number.isFinite(ci[1]) || ci[0] === ci[1]
}

export function buildReleaseScorecard(
  composite: ScalarDistribution,
  lift: LiftInsight | undefined,
  contamination: InsightReport['contamination'],
): InsightReport['release'] {
  // Synthesise a minimal scorecard from the rolled-up signal. The
  // substrate's `evaluateReleaseConfidence` primitive consumes a richer
  // input shape that callers can produce by wiring SLO definitions; the
  // shape here is the contract `selfImprove`/`analyzeRuns` consumers
  // receive automatically. They can call `evaluateReleaseConfidence`
  // directly when they want SLO-based axis evaluation.
  const axes: InsightReport['release']['axes'] = []
  const liftPass =
    lift === undefined
      ? ('not_evaluated' as const)
      : !lift.decisionEligible
        ? ('not_evaluated' as const)
        : lift.ci95[0] > 0 && !zeroWidth(lift.ci95)
          ? ('pass' as const)
          : lift.delta > 0
            ? ('warn' as const)
            : ('fail' as const)
  axes.push({
    name: 'quality-lift',
    status: liftPass,
    detail: lift
      ? `delta=${lift.delta.toFixed(3)}, CI95=[${lift.ci95[0].toFixed(3)}, ${lift.ci95[1].toFixed(3)}], n=${lift.n}${lift.decisionEligible ? '' : ` (descriptive only; ${lift.minimumRequired} required)`}`
      : 'no baseline/candidate pair available',
  })
  const contamPass =
    contamination === undefined
      ? ('not_evaluated' as const)
      : contamination.leaks === 0
        ? ('pass' as const)
        : ('fail' as const)
  axes.push({
    name: 'contamination',
    status: contamPass,
    detail: contamination ? `${contamination.leaks} canary leak(s)` : 'no canaries supplied',
  })
  axes.push(
    composite.n === 0
      ? {
          name: 'composite-distribution',
          status: 'not_evaluated',
          detail: 'no task-quality scores available',
        }
      : {
          name: 'composite-distribution',
          status:
            composite.mean !== null && composite.mean >= 0.5
              ? 'pass'
              : composite.mean !== null && composite.mean >= 0.3
                ? 'warn'
                : 'fail',
          detail:
            composite.mean === null || composite.p50 === null || composite.p95 === null
              ? 'task-quality distribution is internally incomplete'
              : `mean=${composite.mean.toFixed(3)}, p50=${composite.p50.toFixed(3)}, p95=${composite.p95.toFixed(3)} over n=${composite.n}`,
        },
  )
  const status = axes.some((a) => a.status === 'fail')
    ? 'fail'
    : axes.some((a) => a.status === 'warn' || a.status === 'not_evaluated')
      ? 'warn'
      : 'pass'
  return {
    status,
    axes,
    issues: [],
  }
}

export function buildRecommendations(ctx: RecommendationContext): Recommendation[] {
  const out: Recommendation[] = []

  // Prior-period regressions — highest customer-impact signal when present.
  // "Did my last change help?" with a falsifiable answer.
  if (ctx.priorPeriodComparison) {
    const ppc = ctx.priorPeriodComparison
    const label = ppc.windowLabel ?? 'baseline period'
    for (const name of ppc.regressedMetrics) {
      const d = ppc.metrics[name]
      if (d?.status !== 'ok') continue
      out.push({
        priority: 'critical',
        kind: 'investigate',
        title: `${name} regressed from ${d.baseline.toFixed(3)} → ${d.current.toFixed(3)} vs ${label}`,
        detail: `Welch CI95 = [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}], p=${d.pValue.toFixed(4)}, Cohen's d=${d.cohensD.toFixed(2)} (n_current=${d.currentN}, n_baseline=${d.baselineN}). The regression is statistically significant at p<0.05 with at-least-small effect size.`,
        evidencePath: `priorPeriodComparison.metrics.${name}`,
      })
    }
    for (const name of ppc.improvedMetrics) {
      const d = ppc.metrics[name]
      if (d?.status !== 'ok') continue
      out.push({
        priority: 'low',
        kind: 'ship',
        title: `${name} improved from ${d.baseline.toFixed(3)} → ${d.current.toFixed(3)} vs ${label}`,
        detail: `Welch CI95 = [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}], p=${d.pValue.toFixed(4)}, Cohen's d=${d.cohensD.toFixed(2)} (n_current=${d.currentN}, n_baseline=${d.baselineN}). Statistically significant improvement worth flagging.`,
        evidencePath: `priorPeriodComparison.metrics.${name}`,
      })
    }
    for (const name of ppc.inconclusiveMetrics) {
      const d = ppc.metrics[name]
      if (!d || d.status === 'ok' || d.delta === 0) continue
      const reason =
        d.status === 'zero-variance'
          ? 'both periods have zero observed variance'
          : 'one or both periods have fewer than two observations'
      out.push({
        priority: 'high',
        kind: 'investigate',
        title: `${name} changed from ${d.baseline.toFixed(3)} → ${d.current.toFixed(3)} vs ${label}; inference unavailable`,
        detail: `Observed delta ${d.delta.toFixed(3)} across n_current=${d.currentN} and n_baseline=${d.baselineN}, but ${reason}. The report does not fabricate a p-value, confidence interval, or effect size; inspect independence and data capture before acting.`,
        evidencePath: `priorPeriodComparison.metrics.${name}`,
      })
    }
  }

  // Composite-distribution branch. Fires when the overall quality signal is
  // poor regardless of lift / contamination / clusters — the customer needs
  // to know they have a problem AND which specific runs to inspect.
  if (
    ctx.composite.n > 0 &&
    ctx.composite.mean !== null &&
    ctx.composite.p50 !== null &&
    ctx.composite.p95 !== null
  ) {
    if (ctx.composite.mean < 0.3) {
      const tail = ctx.composite.tailRuns ?? []
      const names = tail
        .slice(0, 5)
        .map((t) => `${t.runId}=${t.score.toFixed(3)}`)
        .join(', ')
      out.push({
        priority: 'critical',
        kind: 'investigate',
        title: `Composite mean ${ctx.composite.mean.toFixed(3)} is below the 0.3 floor — the agent is broken on this corpus`,
        detail:
          tail.length > 0
            ? `Worst ${tail.length} run${tail.length === 1 ? '' : 's'} to inspect first: ${names}. Histogram p50=${ctx.composite.p50.toFixed(3)}, p95=${ctx.composite.p95.toFixed(3)}.`
            : `Histogram p50=${ctx.composite.p50.toFixed(3)}, p95=${ctx.composite.p95.toFixed(3)}.`,
        evidencePath: 'composite.tailRuns',
      })
    } else if (ctx.composite.mean < 0.5) {
      const tail = ctx.composite.tailRuns ?? []
      const names = tail
        .slice(0, 3)
        .map((t) => `${t.runId}=${t.score.toFixed(3)}`)
        .join(', ')
      out.push({
        priority: 'high',
        kind: 'investigate',
        title: `Composite mean ${ctx.composite.mean.toFixed(3)} is below 0.5 — investigate the lower tail before claiming the agent is healthy`,
        detail:
          tail.length > 0
            ? `Worst ${tail.length} run${tail.length === 1 ? '' : 's'}: ${names}. Histogram p50=${ctx.composite.p50.toFixed(3)}, p95=${ctx.composite.p95.toFixed(3)}.`
            : `Histogram p50=${ctx.composite.p50.toFixed(3)}, p95=${ctx.composite.p95.toFixed(3)}.`,
        evidencePath: 'composite.tailRuns',
      })
    }
  }

  // A healthy-looking mean can hide a group of failed tasks sharing one
  // producer-reported cause. This path does not require an analyst.
  if (ctx.failureClasses && ctx.failureClasses.length > 0) {
    const top = ctx.failureClasses[0]!
    if (top.count >= 3 && top.share >= 0.15) {
      out.push({
        priority: top.share >= 0.25 ? 'high' : 'medium',
        kind: 'investigate',
        title: `'${top.failureClass}' is the dominant failure class — ${top.count} runs (${(top.share * 100).toFixed(0)}% of the corpus)`,
        detail: `The mean composite can look acceptable while one failure class dominates the lower tail. ${top.count} of ${ctx.composite.n} runs failed with '${top.failureClass}'${ctx.failureClasses.length > 1 ? ` (next: '${ctx.failureClasses[1]!.failureClass}' ×${ctx.failureClasses[1]!.count})` : ''}. Fix this cause first.`,
        evidencePath: 'failureClasses',
      })
    }
  }

  // Missing-judges branch. The report can't surface per-dimension or
  // calibration signal when `outcome.judgeScores` is empty across the
  // corpus. Tell the customer how to enrich.
  if (Object.keys(ctx.judges).length === 0 && ctx.composite.n > 0) {
    out.push({
      priority: 'medium',
      kind: 'expand-corpus',
      title: 'No judge scores recorded — per-dimension + calibration insights unavailable',
      detail:
        'Records have no `outcome.judgeScores`. To unlock perDimension, judges, and calibration, attach a Judge run during your eval pass and populate `outcome.judgeScores.perJudge[judgeName][dimension] = score`. See `docs/insight-report.md` for the expected shape.',
      evidencePath: 'judges',
    })
  }

  if (ctx.lift) {
    if (!ctx.lift.decisionEligible) {
      out.push({
        priority: 'high',
        kind: 'expand-corpus',
        title: `Inconclusive — ${ctx.lift.n} paired runs; ${ctx.lift.minimumRequired} required`,
        detail: `The bootstrap interval is descriptive below ${ctx.lift.minimumRequired} paired observations and cannot support a ship decision.`,
        evidencePath: 'lift',
      })
    } else {
      const pairedEffect =
        ctx.lift.cohensD === null ? 'undefined (zero delta variance)' : ctx.lift.cohensD.toFixed(2)
      const pairedP =
        ctx.lift.pValue === null ? 'undefined (zero delta variance)' : ctx.lift.pValue.toFixed(4)
      const requiredRuns =
        ctx.lift.requiredN === null ? 'not estimable' : `~${ctx.lift.requiredN} paired runs`
      // A ZERO-WIDTH interval never reads as "ship": n identical paired deltas
      // make every resample identical, so `[g, g]` clears any threshold below g
      // and `[0, 0]` clears any negative `decisionThreshold`, on no spread at
      // all. It falls through to the inconclusive/hold arms, which is where a
      // sample carrying no information about its own error belongs.
      const decisive = !zeroWidth(ctx.lift.ci95) && ctx.lift.ci95[0] > ctx.threshold
      const inconclusive = ctx.lift.ci95[0] <= ctx.threshold && ctx.lift.ci95[1] > ctx.threshold
      if (decisive) {
        out.push({
          priority: 'critical',
          kind: 'ship',
          title: `Ship — lift ${ctx.lift.delta.toFixed(3)} (95% CI ${ctx.lift.ci95[0].toFixed(3)}..${ctx.lift.ci95[1].toFixed(3)})`,
          detail: `Holdout lift exceeds threshold ${ctx.threshold} with 95% bootstrap confidence (n=${ctx.lift.n}, p=${pairedP}, paired d=${pairedEffect}).`,
          evidencePath: 'lift',
        })
      } else if (inconclusive) {
        out.push({
          priority: 'high',
          kind: 'expand-corpus',
          title: `Inconclusive — required sample is ${requiredRuns} (have ${ctx.lift.n}) at current effect size`,
          detail: `CI straddles threshold. Current MDE at 80% power is ${ctx.lift.mde.toFixed(3)}; observed delta is ${ctx.lift.delta.toFixed(3)}.`,
          evidencePath: 'lift',
        })
      } else {
        out.push({
          priority: 'critical',
          kind: 'hold',
          title: `Hold — lift CI lower bound ${ctx.lift.ci95[0].toFixed(3)} is at or below threshold ${ctx.threshold}`,
          detail: `Bootstrap CI provides no statistical evidence the candidate is better. Consider tightening the mutation or expanding the holdout.`,
          evidencePath: 'lift',
        })
      }
    }
  }

  if (ctx.contamination && ctx.contamination.leaks > 0) {
    out.push({
      priority: 'critical',
      kind: 'fix',
      title: `${ctx.contamination.leaks} canary leak${ctx.contamination.leaks === 1 ? '' : 's'} detected`,
      detail: `Holdout integrity is compromised. The lift number is unreliable until you investigate.`,
      evidencePath: 'contamination',
    })
  }

  if (ctx.interRater && ctx.interRater.kappa < 0.5) {
    out.push({
      priority: 'high',
      kind: 'recalibrate',
      title: `Inter-rater weighted kappa ${ctx.interRater.kappa.toFixed(2)} is below 0.5`,
      detail:
        'Raters disagree on what good looks like. Review the largest disagreement cases and refine the rubric before automating these decisions.',
      evidencePath: 'interRater',
    })
  }

  if (ctx.failureClusters && ctx.failureClusters.clusters.length > 0) {
    const top = ctx.failureClusters.clusters[0]!
    out.push({
      priority: 'high',
      kind: 'investigate',
      title: `Top failure cluster: ${top.name} (${(top.share * 100).toFixed(0)}% of failures)`,
      detail: `${ctx.failureClusters.totalFailures} runs failed. The largest cluster groups ${top.exemplars.length} exemplars under '${top.name}'.`,
      evidencePath: 'failureClusters.clusters[0]',
    })
  }

  if (ctx.outcomeCorrelation && Math.abs(ctx.outcomeCorrelation.spearman) < 0.3) {
    out.push({
      priority: 'medium',
      kind: 'recalibrate',
      title: `Judge scores decoupled from ${ctx.outcomeCorrelation.metric} (Spearman ρ=${ctx.outcomeCorrelation.spearman.toFixed(2)})`,
      detail: `Your judges score what they were trained to score, but it isn't predicting downstream ${ctx.outcomeCorrelation.metric}. Consider retraining the judge against ${ctx.outcomeCorrelation.metric} as the gold signal.`,
      evidencePath: 'outcomeCorrelation',
    })
  }

  return out
}
