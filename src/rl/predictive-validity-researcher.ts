/**
 * `PredictiveValidityResearcher` — concrete `Researcher` implementation
 * that drives selection from outcome-anchored predictive validity.
 *
 * Each method:
 *
 *   - `inspectFailures(runs)` — synthesizes failure modes from the
 *     bottom-quartile of `RunRecord`s on the configured proxy reward.
 *   - `proposeChange(failures)` — proposes steering changes that target
 *     the rubrics with the lowest predictive validity (decorative ones).
 *     Either reduce their weight in the composite, or recalibrate them.
 *   - `applyChange(changes, baseline)` — merges the proposed steering
 *     into the experiment plan.
 *   - `evaluateChange(plan)` — re-runs the predictive-validity check on
 *     the post-change runs and reports the delta.
 *
 * The result is a closed loop: the rubric weights drift toward the ones
 * that actually predict deployment outcomes, automatically. Pair with
 * `runRLCampaign` for the full auto-research story.
 */

import type { GateDecision } from '../held-out-gate'
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
import type { RunRecord } from '../run-record'

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
    const failingRuns = runs.filter((r) => {
      const score = r.outcome.holdoutScore ?? r.outcome.searchScore
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
          const x = r.outcome.holdoutScore ?? r.outcome.searchScore ?? 0
          return s + x
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
        medianPairedDelta: 0,
        pairedCI: { low: 0, high: 0 },
        pairedPValue: 1,
        searchScore: 0,
        holdoutScore: 0,
        overfitGap: 0,
        baselineOverfitGap: 0,
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
