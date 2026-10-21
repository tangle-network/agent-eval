/** Evidence-based report verdicts, recommendations, and methodology. */

import type { HeldOutGateDecision } from './held-out-gate'
import type { FailureClusterReport } from './pipelines/failure-cluster'
import type {
  ResearchReportCandidate,
  ResearchReportDecision,
  ResearchReportMethodology,
  ResearchReportRecommendation,
} from './research-report'
import { fmt, formatRope } from './research-report-render'
import type { pairedPosterior } from './summary-report-evidence'
import type { ParetoPoint, SummaryTableRow } from './summary-report-figures'

/**
 * Hard floor below which a paired comparison is treated as uninformative
 * regardless of `minPairs`. Mirrors the lower limit on Wilcoxon signed-rank
 * exact tables; below this the test has no power to separate effect sizes.
 */
export const RESEARCH_REPORT_HARD_PAIR_FLOOR = 6

export function buildMethodology(ctx: {
  split: 'search' | 'holdout'
  comparator: string | null
  fdr: number
  minPairs: number
  rope: { low: number; high: number } | null
  confidence: number
  mdePower: number
  mdeAlpha: number
}): ResearchReportMethodology {
  const assumptions: string[] = [
    'Pairs are matched by (experimentId, scenarioId, seed); input order does not affect the comparison.',
    'Paired deltas are exchangeable conditional on the matched scenario — no mid-run distribution shift.',
    `Decisions are pre-specified at fdr=${ctx.fdr}, minPairs=${ctx.minPairs}, confidence=${ctx.confidence}; deviating from these post-hoc invalidates the false-discovery control.`,
  ]
  if (ctx.rope) {
    assumptions.push(
      `The Region of Practical Equivalence ${formatRope(ctx.rope)} is supplied by the domain owner; equivalent verdicts are only meaningful if that range is treated as the standing definition of "no material difference."`,
    )
  }
  if (ctx.comparator === null) {
    assumptions.push('No comparator was configured; this run is descriptive, not causal.')
  }
  const methods: string[] = [
    "Marginal scores summarised with BH-FDR-adjusted Wilcoxon signed-rank q-values and paired Cohen's dz via summaryTable.",
    'Paired evidence summarised with a frequentist bootstrap CI on the median delta and a Dirichlet-weight Bayesian bootstrap for Pr(Δ>0) and Pr(Δ∈ROPE) on the mean delta.',
    `Minimum detectable effect reported per candidate at α=${ctx.mdeAlpha} (two-sided), power=${ctx.mdePower}, standardised by the observed paired-delta SD.`,
    'Pareto frontier flagged as a separate axis (cost vs quality); a candidate can be on-frontier without winning the paired test.',
    'Held-out gate decisions, when supplied, override the statistical verdict in the reject direction.',
  ]
  const alternatives: string[] = [
    'Paired t-test rejected: not robust to the heavy-tailed score distributions common in agent benchmarks.',
    'Unpaired Mann–Whitney rejected: matched scenarios make pairing free; unpaired throws away that variance reduction.',
    'Sequential / always-valid inference (e-values, mSPRT) is the right tool for iterative sweeps and is out of scope for this single-look report — preregister and run once, or wrap this report in an alpha-spending schedule.',
    'Hierarchical Bayesian shrinkage across many candidates is future work; the current ranking uses raw paired statistics.',
  ]
  const whenNotToApply: string[] = [
    `Paired N below ${RESEARCH_REPORT_HARD_PAIR_FLOOR} on any candidate — the bootstrap CI is degenerate.`,
    'Comparator chosen post-hoc by inspecting the same data; q-values are no longer false-discovery-controlled.',
    'Scenarios not drawn under a stable preregistered protocol; the report can describe the data but cannot anchor a launch decision.',
    'Score distributions with mid-run shift (judge model swap, rubric change, infra outage) — pair exchangeability is violated.',
  ]
  const citations: string[] = [
    'Benjamini, Y. & Hochberg, Y. (1995). Controlling the false discovery rate: a practical and powerful approach to multiple testing. JRSS B, 57(1), 289–300.',
    'Wilcoxon, F. (1945). Individual comparisons by ranking methods. Biometrics Bulletin, 1(6), 80–83.',
    'Efron, B. (1979). Bootstrap methods: another look at the jackknife. Annals of Statistics, 7(1), 1–26.',
    'Rubin, D. B. (1981). The Bayesian bootstrap. Annals of Statistics, 9(1), 130–134.',
    'Kruschke, J. K. (2018). Rejecting or accepting parameter values in Bayesian estimation. Advances in Methods and Practices in Psychological Science, 1(2), 270–280. (ROPE.)',
  ]
  return { assumptions, methods, alternatives, whenNotToApply, citations }
}

export function classifyCandidate(
  row: SummaryTableRow,
  ctx: {
    comparator: string | null
    posterior: ReturnType<typeof pairedPosterior> | null
    point?: ParetoPoint
    gateDecision?: HeldOutGateDecision
    split: 'search' | 'holdout'
    fdr: number
    minPairs: number
    rope: { low: number; high: number } | null
  },
): { decision: ResearchReportDecision; reason: string } {
  if (ctx.comparator && row.candidateId === ctx.comparator) {
    return { decision: 'hold', reason: 'Comparator baseline.' }
  }
  if (ctx.gateDecision && !ctx.gateDecision.promote) {
    const code = ctx.gateDecision.rejectionCode ?? 'rejected'
    return {
      decision: 'reject',
      reason: `Held-out gate returned ${code}: ${ctx.gateDecision.reason}`,
    }
  }
  if (!ctx.comparator) {
    return {
      decision: ctx.point?.onFrontier ? 'hold' : 'needs_more_data',
      reason:
        'No comparator configured; report ranks candidates but cannot anchor a promotion call.',
    }
  }
  if (!ctx.posterior || ctx.posterior.n < RESEARCH_REPORT_HARD_PAIR_FLOOR) {
    return {
      decision: 'needs_more_data',
      reason: `Only ${ctx.posterior?.n ?? 0} paired observations; below hard floor of ${RESEARCH_REPORT_HARD_PAIR_FLOOR} for any paired inference.`,
    }
  }
  const ci = ctx.posterior.ci
  if (ctx.split === 'search') {
    return {
      decision: 'hold',
      reason:
        'Search-split evidence is descriptive; release decisions require matched holdout runs.',
    }
  }
  // A ZERO-WIDTH interval cannot support any directional or equivalence claim:
  // every resample was identical, so it says nothing about how far the estimate
  // could be wrong. It is the shape that sits fully inside any ROPE containing
  // it (a fake "practically equivalent") and clears any threshold below it (a
  // fake "promote"). Both are an absence of evidence, so it is disqualified from
  // each claim rather than short-circuiting the whole classifier — the
  // sample-size and MDE diagnostics below are still the more useful answer when
  // they apply.
  const degenerate = !Number.isFinite(ci.low) || !Number.isFinite(ci.high) || ci.low === ci.high
  if (!degenerate && ctx.rope && ci.low >= ctx.rope.low && ci.high <= ctx.rope.high) {
    return {
      decision: 'equivalent',
      reason: `Paired-delta CI [${fmt(ci.low)}, ${fmt(ci.high)}] is fully inside ROPE ${formatRope(ctx.rope)}; candidate is practically equivalent to comparator.`,
    }
  }
  const gainPositive = !degenerate && ci.low > 0
  const gainNegative = !degenerate && ci.high < 0
  if (gainNegative) {
    return {
      decision: 'reject',
      reason: `Paired-delta CI [${fmt(ci.low)}, ${fmt(ci.high)}] lies entirely below zero.`,
    }
  }
  if (ctx.posterior.n < ctx.minPairs) {
    return {
      decision: 'needs_more_data',
      reason: `Only ${ctx.posterior.n} paired observations; minimum detectable effect at this N is ${fmt(ctx.posterior.mde)} score units (need ≥ ${ctx.minPairs} pairs to issue a directional verdict).`,
    }
  }
  if (degenerate) {
    return {
      decision: 'needs_more_data',
      reason: `Paired-delta CI [${fmt(ci.low)}, ${fmt(ci.high)}] has zero width — every resample was identical, so the interval carries no information about how far the estimate could be wrong and cannot support a promote or equivalence call.`,
    }
  }
  if (row.qValue !== null && row.qValue <= ctx.fdr && gainPositive) {
    return {
      decision: 'promote',
      reason: `BH-adjusted q=${fmt(row.qValue)} ≤ ${ctx.fdr} and paired-delta CI [${fmt(ci.low)}, ${fmt(ci.high)}] excludes zero; Pr(Δ>0)=${fmt(ctx.posterior.prGreaterThanZero)}.`,
    }
  }
  return {
    decision: 'hold',
    reason: `Pr(Δ>0)=${fmt(ctx.posterior.prGreaterThanZero)} but CI [${fmt(ci.low)}, ${fmt(ci.high)}] crosses zero; effect not decisive at fdr=${ctx.fdr}.`,
  }
}

export function buildRecommendation(
  candidates: ResearchReportCandidate[],
  ctx: {
    comparator: string | null
    failureClusters?: FailureClusterReport
    rope: { low: number; high: number } | null
    minPairs: number
    preregistrationHash: string | null
  },
): ResearchReportRecommendation {
  const nonComparator = candidates.filter((c) => c.candidateId !== ctx.comparator)
  const bestPromote = nonComparator.find((c) => c.decision === 'promote')
  const bestEquivalent = nonComparator.find((c) => c.decision === 'equivalent')
  const chosen = bestPromote ?? bestEquivalent ?? nonComparator[0] ?? null
  const decision: ResearchReportDecision = bestPromote
    ? 'promote'
    : nonComparator.some((c) => c.decision === 'needs_more_data')
      ? 'needs_more_data'
      : bestEquivalent
        ? 'equivalent'
        : nonComparator.some((c) => c.decision === 'hold')
          ? 'hold'
          : 'reject'

  const rationale: string[] = []
  const risks: string[] = []
  const nextActions: string[] = []

  if (chosen) {
    rationale.push(`${chosen.candidateId}: ${chosen.decisionReason}`)
    if (chosen.gainCi) {
      const probSummary =
        chosen.prGreaterThanZero !== null ? `, Pr(Δ>0)=${fmt(chosen.prGreaterThanZero)}` : ''
      rationale.push(
        `Median paired gain CI: [${fmt(chosen.gainCi.low)}, ${fmt(chosen.gainCi.high)}]${probSummary}.`,
      )
    }
    if (chosen.mde !== null && Number.isFinite(chosen.mde)) {
      rationale.push(`MDE at current paired N=${chosen.pairedN}: ${fmt(chosen.mde)} score units.`)
    }
  }
  if (!ctx.comparator) {
    risks.push('No comparator was configured; verdict is descriptive, not causal.')
    nextActions.push('Re-run with a stable comparator candidate for paired inference.')
  }
  if (!ctx.preregistrationHash) {
    risks.push(
      'No preregistration hash supplied; readers cannot verify the analysis was specified before data inspection.',
    )
    nextActions.push(
      'Sign a HypothesisManifest before the next sweep and pass `preregistrationHash` so the report cites it.',
    )
  }
  if (ctx.rope === null && nonComparator.length > 0) {
    risks.push(
      'No ROPE configured; the report cannot distinguish "equivalent" from "inconclusive".',
    )
    nextActions.push(
      'Define a domain-specific Region of Practical Equivalence and pass it to lock in the equivalence threshold.',
    )
  }
  const inconclusive = nonComparator.filter((c) => c.decision === 'needs_more_data')
  if (inconclusive.length > 0) {
    const worst = inconclusive.reduce((a, b) => (b.pairedN < a.pairedN ? b : a))
    risks.push(
      `${inconclusive.length} candidate(s) below soft floor (${ctx.minPairs} pairs); thinnest is ${worst.candidateId} with ${worst.pairedN}.`,
    )
    nextActions.push(
      `Collect at least ${ctx.minPairs - worst.pairedN} more matched holdout runs for ${worst.candidateId}.`,
    )
  }
  const rejected = nonComparator.filter((c) => c.decision === 'reject')
  if (rejected.length > 0) {
    risks.push(
      `${rejected.length} candidate(s) failed the paired test or held-out gate; do not ship those variants.`,
    )
  }
  if (ctx.failureClusters && ctx.failureClusters.clusters.length > 0) {
    const top = ctx.failureClusters.clusters[0]!
    risks.push(`Top failure cluster: ${top.failureClass} across ${top.runCount} run(s).`)
    nextActions.push('Prioritize the largest failure cluster before broad rollout.')
  }
  if (decision === 'promote') {
    nextActions.push('Ship behind the existing promotion gate and monitor canaries.')
  } else if (decision === 'hold') {
    nextActions.push('Keep current production candidate while expanding holdout evidence.')
  } else if (decision === 'equivalent') {
    nextActions.push(
      'Either keep the comparator (no quality regression) or promote on cost/latency grounds — equivalence does not justify either; the choice is a product decision, not a stats one.',
    )
  } else if (decision === 'reject') {
    nextActions.push(
      'Do not promote this sweep; inspect failures and generate a revised candidate.',
    )
  }

  return {
    decision,
    candidateId: chosen?.candidateId ?? null,
    rationale,
    risks,
    nextActions,
  }
}

export function buildExecutiveSummary(
  candidates: ResearchReportCandidate[],
  recommendation: ResearchReportRecommendation,
  ctx: {
    comparator: string | null
    split: 'search' | 'holdout'
    failureClusters?: FailureClusterReport
    preregistrationHash: string | null
  },
): string[] {
  const lines: string[] = []
  const nonComparator = candidates.filter((c) => c.candidateId !== ctx.comparator)
  lines.push(
    `Evaluated ${nonComparator.length} candidate(s) on the ${ctx.split} split${ctx.comparator ? ` against ${ctx.comparator}` : ''}.`,
  )
  lines.push(
    `Recommendation: ${recommendation.decision}${recommendation.candidateId ? ` ${recommendation.candidateId}` : ''}.`,
  )
  const promoted = nonComparator.filter((c) => c.decision === 'promote').length
  const held = nonComparator.filter((c) => c.decision === 'hold').length
  const equivalent = nonComparator.filter((c) => c.decision === 'equivalent').length
  const rejected = nonComparator.filter((c) => c.decision === 'reject').length
  const more = nonComparator.filter((c) => c.decision === 'needs_more_data').length
  lines.push(
    `Decision mix: ${promoted} promote, ${equivalent} equivalent, ${held} hold, ${rejected} reject, ${more} need more data.`,
  )
  const frontier = nonComparator.filter((c) => c.onParetoFrontier).map((c) => c.candidateId)
  if (frontier.length > 0) lines.push(`Pareto-frontier candidates: ${frontier.join(', ')}.`)
  if (ctx.failureClusters) {
    lines.push(
      `Failure clustering found ${ctx.failureClusters.totalFailures}/${ctx.failureClusters.totalRuns} failed runs across ${ctx.failureClusters.clusters.length} reportable cluster(s).`,
    )
  }
  lines.push(
    ctx.preregistrationHash
      ? `Preregistered analysis: ${ctx.preregistrationHash.slice(0, 12)}…`
      : 'Analysis is post-hoc — no preregistration hash supplied.',
  )
  return lines
}

export function decisionWeight(decision: ResearchReportDecision): number {
  if (decision === 'promote') return 5
  if (decision === 'equivalent') return 4
  if (decision === 'hold') return 3
  if (decision === 'needs_more_data') return 2
  return 1
}
