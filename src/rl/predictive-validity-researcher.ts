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
import type { OutcomeStore } from '../meta-eval/outcome-store'
import {
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
  outcomeMetrics: string[]
  /** Score threshold below which a run counts as a "failure." Default 0.5. */
  failureThreshold?: number
  /** Spearman bucket below which a rubric is "decorative." Default 0.4. */
  decorativeThreshold?: number
  /** Optional steering-namespace prefix for proposed changes. Default `'rubric_weight'`. */
  steeringNamespace?: string
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
 * Concrete `Researcher` driven by `rubricPredictiveValidity`. The brain:
 * rubrics that don't predict deployment outcomes don't earn weight.
 */
export class PredictiveValidityResearcher implements Researcher {
  private opts: PredictiveValidityResearcherOptions
  private lastReport: RubricPredictiveValidityReport | null = null

  constructor(opts: PredictiveValidityResearcherOptions) {
    this.opts = opts
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

    const decorativeThreshold = this.opts.decorativeThreshold ?? 0.4
    const changes: SteeringChange[] = []

    for (const ranking of this.lastReport.ranked) {
      if (ranking.verdict === 'load_bearing') continue
      if (Math.abs(ranking.spearman) >= decorativeThreshold) continue
      changes.push({
        kind: 'reviewer_prompt',
        payload: {
          rubric: ranking.rubric,
          action: 'down-weight',
          spearman: ranking.spearman,
          bestOutcome: ranking.bestOutcome,
        },
        rationale: `predictive-validity Spearman=${ranking.spearman.toFixed(3)} vs ${ranking.bestOutcome} (decorative); recommend down-weighting`,
        expectedDelta: -Math.max(0, 0.05 - Math.abs(ranking.spearman)),
      })
    }
    for (const ranking of this.lastReport.ranked.slice(0, 1)) {
      if (ranking.verdict !== 'load_bearing') continue
      changes.push({
        kind: 'reviewer_prompt',
        payload: {
          rubric: ranking.rubric,
          action: 'up-weight',
          spearman: ranking.spearman,
          bestOutcome: ranking.bestOutcome,
        },
        rationale: `predictive-validity Spearman=${ranking.spearman.toFixed(3)} vs ${ranking.bestOutcome} (load-bearing); recommend up-weighting`,
        expectedDelta: Math.max(0, Math.abs(ranking.spearman) - 0.5) * 0.1,
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
      outcomeMetrics: this.opts.outcomeMetrics,
      rubrics: this.opts.rubrics,
    })
    if (this.opts.onReport) await this.opts.onReport(report)
    this.lastReport = report
    return report
  }

  /**
   * Force-feed a predictive-validity report into the researcher state —
   * useful when the consumer ran the report out-of-band and wants the
   * researcher's later proposals informed by it.
   */
  setReport(report: RubricPredictiveValidityReport): void {
    this.lastReport = report
  }

  getLastReport(): RubricPredictiveValidityReport | null {
    return this.lastReport
  }
}

/** Coverage of a split that was never dealt any work. */
function emptyCoverage(): SplitCoverage {
  return { dealt: 0, answered: 0, unscoredPairs: 0, candidateOnly: 0, baselineOnly: 0, coverage: 0 }
}
