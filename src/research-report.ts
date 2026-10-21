/** Assemble research report evidence, guidance, figures, and rendered documents. */

import type { HeldOutGateDecision } from './held-out-gate'
import type { FailureClusterReport } from './pipelines/failure-cluster'
import { hashJson } from './pre-registration'
import { renderResearchHtml } from './reporting-html'
import {
  buildExecutiveSummary,
  buildMethodology,
  buildRecommendation,
  classifyCandidate,
  decisionWeight,
  RESEARCH_REPORT_HARD_PAIR_FLOOR,
} from './research-report-analysis'
import { renderResearchMarkdown } from './research-report-render'
import type { RunRecord } from './run-record'
import { pairedPosterior } from './summary-report-evidence'
import {
  type GainDistributionFigureSpec,
  gainHistogram,
  gateLabel,
  type ParetoFigureSpec,
  type ParetoPoint,
  paretoChart,
  type SummaryTable,
  summaryTable,
} from './summary-report-figures'

export { RESEARCH_REPORT_HARD_PAIR_FLOOR } from './research-report-analysis'

export type ResearchReportDecision =
  | 'promote'
  | 'hold'
  | 'reject'
  | 'equivalent'
  | 'needs_more_data'

export interface ResearchReportOptions {
  /** Human-readable report title. */
  title?: string
  /** Comparator candidate id. Required for statistical decision guidance. */
  comparator?: string
  /** Which split to use for the primary decision. Default 'holdout'. */
  split?: 'search' | 'holdout'
  /** Confidence level used by lower-level report helpers. Default 0.95. */
  confidence?: number
  /** FDR threshold for q-values. Default 0.05. */
  fdr?: number
  /**
   * Soft floor on paired observations before issuing a directional
   * promote / reject. Below this we report `needs_more_data` and surface the
   * minimum detectable effect at the current N. Default 20 — chosen so the
   * Wilcoxon signed-rank approximation is reasonable and so the paired
   * bootstrap CI has non-degenerate coverage. Hard floor is enforced at
   * `RESEARCH_REPORT_HARD_PAIR_FLOOR` (6) regardless of this value.
   */
  minPairs?: number
  /**
   * Region of Practical Equivalence on the paired delta. When a candidate's
   * paired-delta CI is fully contained in `[low, high]`, the decision is
   * `equivalent` rather than `hold`. Sourced from the domain owner — there is
   * no statistically-defensible default.
   */
  rope?: { low: number; high: number }
  /**
   * Power for the minimum detectable effect (MDE) reported on each candidate.
   * Default 0.8.
   */
  mdePower?: number
  /**
   * Two-sided alpha for the MDE. Default matches `fdr` so the reported MDE
   * lines up with the test the report actually runs.
   */
  mdeAlpha?: number
  /** Optional held-out gate decisions keyed by candidate id. */
  gateDecisions?: Record<string, HeldOutGateDecision>
  /** Optional failure clusters from failureClusterView. */
  failureClusters?: FailureClusterReport
  /** Build gain histograms for these candidates. Defaults to all non-comparator candidates. */
  candidateIds?: string[]
  /** Deterministic bootstrap seed passed to gainHistogram and the posterior helper. */
  seed?: number
  /** Report timestamp. Defaults to current time. */
  generatedAt?: string
  /**
   * Hash of a preregistered protocol (e.g. `signManifest({...}).contentHash`).
   * Embedded verbatim in the report so the analysis can be cited as the
   * preregistered one rather than a post-hoc fishing expedition.
   */
  preregistrationHash?: string
}

export interface ResearchReportRecommendation {
  decision: ResearchReportDecision
  candidateId: string | null
  rationale: string[]
  risks: string[]
  nextActions: string[]
}

export interface ResearchReportCandidate {
  candidateId: string
  n: number
  mean: number
  ciLow: number
  ciHigh: number
  qValue: number | null
  cohensD: number | null
  meanDeltaVsComparator: number | null
  pairedN: number
  medianGain: number | null
  meanGain: number | null
  gainCi: { low: number; high: number } | null
  /**
   * Bayesian-bootstrap posterior summaries on the paired mean delta.
   * Dirichlet(1, ..., 1) weights represent uncertainty over the empirical
   * distribution of matched deltas.
   */
  prGreaterThanZero: number | null
  prInRope: number | null
  /**
   * Minimum detectable effect (in score units) at the candidate's paired N,
   * the configured power, and the configured alpha. Standardised by the
   * observed paired-delta SD and inverted via `requiredSampleSize`. Reported
   * for every candidate so a `needs_more_data` verdict is actionable.
   */
  mde: number | null
  onParetoFrontier: boolean
  gate?: ParetoPoint['gate']
  decision: ResearchReportDecision
  decisionReason: string
}

export interface ResearchReportMethodology {
  /**
   * Plain-language assumptions the report depends on. Read these first when
   * deciding whether the verdict is load-bearing for a launch decision.
   */
  assumptions: string[]
  /** Tests and estimators the verdict was computed from. */
  methods: string[]
  /** Alternatives the author considered and why this report didn't take them. */
  alternatives: string[]
  /** Failure modes — when this report should NOT drive a decision. */
  whenNotToApply: string[]
  /** Citations for the methodological choices above. */
  citations: string[]
}

export interface ResearchReport {
  kind: 'agent-eval-research-report'
  title: string
  generatedAt: string
  split: 'search' | 'holdout'
  comparator: string | null
  /**
   * SHA-256 over the canonicalised set of `(runId, candidateId, split)` triples
   * the report was computed from, plus the comparator and split. Stable across
   * key insertion order; recomputable by the reader to verify provenance.
   */
  runFingerprint: string
  preregistrationHash: string | null
  rope: { low: number; high: number } | null
  executiveSummary: string[]
  recommendation: ResearchReportRecommendation
  candidates: ResearchReportCandidate[]
  summary: SummaryTable
  charts: {
    pareto: ParetoFigureSpec
    gains: GainDistributionFigureSpec[]
  }
  methodology: ResearchReportMethodology
  failureClusters?: FailureClusterReport
  markdown: string
  html: string
}

/**
 * Executive research report for CPO / AI-lead / launch-review consumption.
 *
 * Composes:
 *   - `summaryTable`         marginal stats with BH-FDR-adjusted q-values
 *   - `paretoChart`           cost-vs-quality frontier with gate overlay
 *   - `gainHistogram`         per-candidate paired-delta distribution
 *   - paired posterior (this file): bootstrap CI on median, Bayesian-bootstrap Pr(Δ>0),
 *                              Pr(Δ∈ROPE), MDE at the configured power
 *
 * Decisions are made on paired evidence — never on marginal means alone —
 * and respect any held-out gate decision the caller passes through. The
 * report embeds a SHA-256 fingerprint of the input run set and, optionally,
 * the hash of a preregistered protocol so a downstream reader can verify
 * provenance and that the analysis was the preregistered one.
 *
 * Async because the fingerprint uses Web Crypto via `hashJson`; deterministic
 * for any fixed `runs`, `seed`, and ROPE.
 */
export async function researchReport(
  runs: RunRecord[],
  opts: ResearchReportOptions = {},
): Promise<ResearchReport> {
  const split = opts.split ?? 'holdout'
  const comparator = opts.comparator ?? null
  const confidence = opts.confidence ?? 0.95
  const fdr = opts.fdr ?? 0.05
  const minPairs = Math.max(opts.minPairs ?? 20, RESEARCH_REPORT_HARD_PAIR_FLOOR)
  const rope = opts.rope ?? null
  const mdePower = opts.mdePower ?? 0.8
  const mdeAlpha = opts.mdeAlpha ?? fdr
  const title = opts.title ?? 'Agent Evaluation Research Report'
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const preregistrationHash = opts.preregistrationHash ?? null

  if (rope && !(Number.isFinite(rope.low) && Number.isFinite(rope.high) && rope.low <= rope.high)) {
    throw new Error(
      `researchReport: rope must satisfy low ≤ high with finite bounds, got ${JSON.stringify(rope)}`,
    )
  }

  const summary = summaryTable(runs, {
    comparator: comparator ?? undefined,
    split,
    confidence,
    fdr,
  })
  const pareto = paretoChart(runs, { split, gateDecisions: opts.gateDecisions })
  const candidateIds =
    opts.candidateIds ?? summary.rows.map((r) => r.candidateId).filter((id) => id !== comparator)
  const gains = comparator
    ? candidateIds.map((id) =>
        gainHistogram(runs, id, comparator, {
          split,
          confidence,
          seed: opts.seed,
        }),
      )
    : []

  const gainByCandidate = new Map(gains.map((g) => [g.candidateId, g]))
  const paretoByCandidate = new Map(pareto.points.map((p) => [p.candidateId, p]))
  const posteriorByCandidate = new Map<string, ReturnType<typeof pairedPosterior>>()
  if (comparator) {
    for (const id of candidateIds) {
      posteriorByCandidate.set(
        id,
        pairedPosterior(runs, id, comparator, {
          split,
          confidence,
          seed: opts.seed,
          rope,
          mdePower,
          mdeAlpha,
        }),
      )
    }
  }

  const candidates = summary.rows
    .map((row) => {
      const gain = gainByCandidate.get(row.candidateId)
      const point = paretoByCandidate.get(row.candidateId)
      const posterior = posteriorByCandidate.get(row.candidateId) ?? null
      const gateDecision = opts.gateDecisions?.[row.candidateId]
      const classified = classifyCandidate(row, {
        comparator,
        posterior,
        point,
        gateDecision,
        split,
        fdr,
        minPairs,
        rope,
      })
      return {
        candidateId: row.candidateId,
        n: row.n,
        mean: row.mean,
        ciLow: row.ciLow,
        ciHigh: row.ciHigh,
        qValue: row.qValue,
        cohensD: row.cohensD,
        meanDeltaVsComparator: posterior ? posterior.meanDelta : null,
        pairedN: posterior?.n ?? gain?.n ?? 0,
        medianGain: posterior ? posterior.medianDelta : gain ? gain.median : null,
        meanGain: posterior ? posterior.meanDelta : null,
        gainCi: posterior ? posterior.ci : gain ? gain.ci : null,
        prGreaterThanZero: posterior ? posterior.prGreaterThanZero : null,
        prInRope: posterior ? posterior.prInRope : null,
        mde: posterior ? posterior.mde : null,
        onParetoFrontier: point?.onFrontier ?? false,
        gate: gateDecision ? gateLabel(gateDecision) : undefined,
        decision: classified.decision,
        decisionReason: classified.reason,
      } satisfies ResearchReportCandidate
    })
    .sort((a, b) => {
      const decisionRank = decisionWeight(b.decision) - decisionWeight(a.decision)
      if (decisionRank !== 0) return decisionRank
      return b.mean - a.mean
    })

  const recommendation = buildRecommendation(candidates, {
    comparator,
    failureClusters: opts.failureClusters,
    rope,
    minPairs,
    preregistrationHash,
  })
  const executiveSummary = buildExecutiveSummary(candidates, recommendation, {
    comparator,
    split,
    failureClusters: opts.failureClusters,
    preregistrationHash,
  })
  const methodology = buildMethodology({
    split,
    comparator,
    fdr,
    minPairs,
    rope,
    confidence,
    mdePower,
    mdeAlpha,
  })

  const runFingerprint = await hashJson({
    triples: runs
      .filter((r) => r.splitTag === split)
      .map((r) => ({ runId: r.runId, candidateId: r.candidateId, splitTag: r.splitTag }))
      .sort((a, b) => a.runId.localeCompare(b.runId)),
    comparator,
    split,
  })

  const markdown = renderResearchMarkdown({
    title,
    generatedAt,
    split,
    comparator,
    rope,
    runFingerprint,
    preregistrationHash,
    executiveSummary,
    recommendation,
    candidates,
    summary,
    pareto,
    gains,
    methodology,
    failureClusters: opts.failureClusters,
  })
  const html = renderResearchHtml(markdown, title)

  return {
    kind: 'agent-eval-research-report',
    title,
    generatedAt,
    split,
    comparator,
    runFingerprint,
    preregistrationHash,
    rope,
    executiveSummary,
    recommendation,
    candidates,
    summary,
    charts: { pareto, gains },
    methodology,
    failureClusters: opts.failureClusters,
    markdown,
    html,
  }
}
