/**
 * `PredictiveValidityResearcher` reports failures and recommends rubric changes
 * from supplied scores and observed outcomes.
 *
 * `inspectFailures` groups runs below the configured score threshold.
 * `runValidityCheck` stores a correlation report for subsequent recommendations.
 * `proposeChange` recommends rubric changes from that report.
 * `applyChange` appends those recommendations to an experiment plan.
 * `evaluateChange` returns no runs and declines promotion because this class
 * does not execute plans.
 *
 * Callers apply rubric changes, execute the experiment, and supply fresh results
 * for the next validity check.
 */

import type { GateDecision, SplitCoverage } from '../held-out-gate'
import {
  assertUniqueObservationIds,
  validateOutcomeMetricSpecifications,
} from '../meta-eval/outcome-observations'
import type { OutcomeStore } from '../meta-eval/outcome-store'
import {
  type OutcomeMetricSpec,
  type RubricPredictiveValidityReport,
  rubricPredictiveValidity,
} from '../meta-eval/rubric-predictive-validity'
import type {
  ExperimentPlan,
  ExperimentResult,
  FailureMode,
  Researcher,
  SteeringChange,
} from '../researcher'
import { type RunRecord, runTaskScore } from '../run-record'

export interface PredictiveValidityResearcherOptions {
  outcomes: OutcomeStore
  /** Fix one desired outcome before observing the report; recommendations never choose an outcome post hoc. */
  targetOutcome: OutcomeMetricSpec
  /** Score threshold below which a run counts as a "failure." Default 0.5. */
  failureThreshold?: number
  /** Override the rubric set the researcher inspects. Default: every numeric `outcome.raw` key seen. */
  rubrics?: string[]
  /**
   * Snapshot stash hook — called with the most recent predictive-validity
   * report. Useful when a downstream system wants to log rubric drift over
   * time. Default no-op.
   */
  onReport?: (report: RubricPredictiveValidityReport) => void | Promise<void>
}

/**
 * Proposes rubric experiments against one declared outcome.
 * A correlation supports a hypothesis; the caller must measure any resulting change.
 */
export class PredictiveValidityResearcher implements Researcher {
  private readonly opts: PredictiveValidityResearcherOptions
  private lastReport: RubricPredictiveValidityReport | null = null

  constructor(opts: PredictiveValidityResearcherOptions) {
    validateOutcomeMetricSpecifications([opts.targetOutcome])
    if (opts.rubrics !== undefined) assertUniqueObservationIds(opts.rubrics, 'rubric')
    if (opts.failureThreshold !== undefined && !Number.isFinite(opts.failureThreshold)) {
      throw new Error('failureThreshold must be finite')
    }
    this.opts = {
      ...opts,
      targetOutcome: { ...opts.targetOutcome },
      rubrics: opts.rubrics === undefined ? undefined : [...opts.rubrics],
    }
  }

  async inspectFailures(runs: RunRecord[]): Promise<FailureMode[]> {
    const threshold = this.opts.failureThreshold ?? 0.5
    const failures: FailureMode[] = []
    // Ungated: the researcher reports what the runs actually scored. A gamed
    // run scored high and is therefore NOT a low-score failure mode — calling it
    // one here would attribute the wrong failure to the candidate.
    const failingRuns = runs.filter((r) => {
      const score = runTaskScore(r)
      return typeof score === 'number' && score < threshold
    })
    if (failingRuns.length === 0) return failures

    // Group failures by candidateId — the researcher's primary handle is
    // "this candidate is producing low-scoring outputs in this scenario."
    const grouped = new Map<string, RunRecord[]>()
    for (const r of failingRuns) {
      const arr = grouped.get(r.candidateId) ?? []
      arr.push(r)
      grouped.set(r.candidateId, arr)
    }

    for (const [candidateId, group] of grouped.entries()) {
      const meanScore =
        group.reduce((s, r) => {
          const score = runTaskScore(r)
          if (score === undefined) {
            throw new Error(`failing run ${r.runId} unexpectedly has no task score`)
          }
          return s + score
        }, 0) / group.length
      failures.push({
        code: `low-score-${candidateId}`,
        description: `${candidateId} scored < ${threshold} on ${group.length} run(s) (mean ${meanScore.toFixed(3)})`,
        evidence: {
          runIds: group.slice(0, 8).map((r) => r.runId),
          samples: group.length,
        },
      })
    }
    return failures
  }

  async proposeChange(failures: FailureMode[]): Promise<SteeringChange[]> {
    if (failures.length === 0) return []

    // Without a prior report, return a single "collect more outcome data"
    // change — the researcher refuses to reweight rubrics from zero evidence.
    if (this.lastReport === null) {
      return [
        {
          kind: 'threshold',
          payload: { directive: 'researcher.collect-more-outcomes' },
          rationale:
            'predictive-validity researcher has no prior report; cannot recommend rubric reweighting until at least one report exists',
        },
      ]
    }

    const changes: SteeringChange[] = []
    const target = { ...this.opts.targetOutcome }
    const pairs = this.lastReport.pairs.filter(
      (pair) =>
        pair.outcome === target.id &&
        pair.outcomeDirection === target.direction &&
        (this.opts.rubrics === undefined || this.opts.rubrics.includes(pair.rubric)),
    )
    if (pairs.length === 0) {
      return [
        {
          kind: 'threshold',
          payload: { directive: 'researcher.collect-more-outcomes', targetOutcome: target },
          rationale: `no estimable rubric association with ${target.id}; collect independent outcome observations before proposing weight changes`,
        },
      ]
    }
    for (const pair of pairs) {
      const interval = pair.alignedSpearmanCi95
      const aligned = pair.alignedSpearman >= 0.4 && interval !== null && interval.lower > 0
      const inverse = pair.alignedSpearman <= -0.4 && interval !== null && interval.upper < 0
      const action = aligned
        ? 'test-up-weight'
        : inverse
          ? 'test-reverse-or-replace'
          : 'collect-calibration-evidence'
      changes.push({
        kind: 'reviewer_prompt',
        payload: {
          rubric: pair.rubric,
          action,
          targetOutcome: target,
          spearman: pair.spearman,
          alignedSpearman: pair.alignedSpearman,
          alignedSpearmanCi95: interval === null ? null : { ...interval },
          samples: pair.n,
        },
        rationale: aligned
          ? `higher ${pair.rubric} scores associate with better ${target.id}; test increased weight on fresh evidence before adopting it`
          : inverse
            ? `higher ${pair.rubric} scores associate with worse ${target.id}; test reversal or replacement on fresh evidence`
            : `the association of ${pair.rubric} with desired ${target.id} does not support a direction of change; collect calibration evidence`,
      })
    }
    return changes
  }

  async applyChange(changes: SteeringChange[], baseline: ExperimentPlan): Promise<ExperimentPlan> {
    // Merge proposed changes into the plan's `changes` array, preserving
    // any changes the baseline already had.
    return {
      ...baseline,
      changes: [...baseline.changes, ...changes],
    }
  }

  async evaluateChange(plan: ExperimentPlan): Promise<ExperimentResult> {
    // The researcher contract takes a *plan* and returns a *result* —
    // implementations that only understand re-scoring runs can produce a
    // "no-op" gate decision and let the caller drive the actual sweep.
    // Real evaluators (CallbackResearcher) execute the plan; we report.
    const emptyGate: GateDecision = {
      promote: false,
      candidateId: plan.proposedCandidateId,
      baselineId: plan.baselineCandidateId,
      evidence: {
        productiveRuns: 0,
        unpairedCandidateRuns: 0,
        unpairedBaselineRuns: 0,
        medianPairedDelta: null,
        deltaStatistic: 'median_bootstrap',
        decidingDelta: null,
        pairedCI: null,
        pairedPValue: null,
        mcnemar: null,
        binaryScale: null,
        tieFraction: null,
        searchScore: null,
        holdoutScore: null,
        overfitGap: null,
        baselineOverfitGap: null,
        medianCandidateCost: null,
        medianBaselineCost: null,
        realnessGatedRuns: 0,
        // Nothing was dealt, so nothing was answered — this researcher never
        // runs the sweep, it only reports that the caller must.
        holdoutCoverage: emptyCoverage(),
        searchCoverage: emptyCoverage(),
      },
      reason:
        'predictive-validity researcher does not execute plans; the caller is expected to run the sweep and call rubricPredictiveValidity directly with the resulting RunRecord[].',
      rejectionCode: 'few_runs',
    }
    return {
      plan,
      runs: [],
      gateDecision: emptyGate,
    }
  }

  /**
   * Run the predictive-validity check explicitly against a fresh RunRecord
   * set. Updates the researcher's cached report so subsequent
   * `proposeChange` calls have evidence to draw from.
   */
  async runValidityCheck(runs: RunRecord[]): Promise<RubricPredictiveValidityReport> {
    const report = await rubricPredictiveValidity({
      runs,
      outcomes: this.opts.outcomes,
      outcomeMetrics: [this.opts.targetOutcome],
      rubrics: this.opts.rubrics,
    })
    if (this.opts.onReport) await this.opts.onReport(structuredClone(report))
    this.setReport(report)
    return report
  }

  /**
   * Force-feed a predictive-validity report into the researcher state —
   * useful when the consumer ran the report out-of-band and wants the
   * researcher's later proposals informed by it.
   */
  setReport(report: RubricPredictiveValidityReport): void {
    const target = report.outcomeMetrics.find((metric) => metric.id === this.opts.targetOutcome.id)
    if (target?.direction !== this.opts.targetOutcome.direction) {
      throw new Error(
        'predictive validity report does not match the declared target outcome and direction',
      )
    }
    this.lastReport = structuredClone(report)
  }

  getLastReport(): RubricPredictiveValidityReport | null {
    return this.lastReport === null ? null : structuredClone(this.lastReport)
  }
}

/** Coverage of a split that was never dealt any work. */
function emptyCoverage(): SplitCoverage {
  return { dealt: 0, answered: 0, unscoredPairs: 0, candidateOnly: 0, baselineOnly: 0, coverage: 0 }
}
