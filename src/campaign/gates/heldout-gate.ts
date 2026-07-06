/**
 * @module
 * Composable held-out promotion gate — statistical, not point-estimate.
 *
 * HISTORY (the fold): this gate originally compared candidate-vs-baseline MEAN
 * composites and shipped on `delta >= threshold` — the exact point-estimate
 * false positive `statistical-heldout.ts` was built to prevent (run-to-run
 * model noise read as a "+4 lift" and shipped). The name and the composable
 * `Gate` shape are preserved; the verdict now comes from the same paired
 * bootstrap significance core `defaultProductionGate` uses: pair by full
 * `scenario:rep` cellId, bootstrap the paired delta, ship only when CI.low
 * clears the threshold with at least `minProductiveRuns` paired observations.
 *
 * Use when you want held-out significance as ONE of N composed gates instead
 * of the full `defaultProductionGate` stack (which adds critical-dimension
 * regression + reward-hacking guards on top).
 */

import type { Gate, GateContext, GateResult, Scenario } from '../types'
import { heldoutSignificance, pairHoldout } from './statistical-heldout'

export interface HeldOutGateOptions<TScenario extends Scenario = Scenario> {
  scenarios: TScenario[]
  /** Effect-size threshold the CI lower bound must clear, in the judge's native
   *  scale. Default 0.5 (unchanged from the point-estimate era). */
  deltaThreshold?: number
  /** Bootstrap CI confidence. Default 0.95. */
  confidence?: number
  /** Minimum paired holdout observations to claim significance. Default 3. */
  minProductiveRuns?: number
  /** Bootstrap resamples. Default 2000. */
  resamples?: number
}

/**
 * Composable held-out gate: ships only when the PAIRED bootstrap CI lower bound
 * of the candidate-minus-baseline composite delta clears `deltaThreshold`.
 */
export function heldOutGate<TArtifact, TScenario extends Scenario>(
  options: HeldOutGateOptions<TScenario>,
): Gate<TArtifact, TScenario> {
  const deltaThreshold = options.deltaThreshold ?? 0.5
  return {
    name: 'heldOutGate',
    async decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult> {
      const scenarioIds = new Set(options.scenarios.map((s) => s.id))
      // Baseline scores live in their OWN map — falling back to `judgeScores`
      // would compare the candidate against itself (delta 0).
      const sig = heldoutSignificance(
        pairHoldout(
          ctx.judgeScores,
          ctx.baselineJudgeScores ?? ctx.judgeScores,
          scenarioIds,
          (s) => s.composite,
        ),
        {
          deltaThreshold,
          confidence: options.confidence ?? 0.95,
          minProductiveRuns: options.minProductiveRuns ?? 3,
          resamples: options.resamples ?? 2000,
        },
      )
      const delta = sig.bootstrap.median
      const passed = sig.significant
      const ci = `${(sig.bootstrap.confidence * 100).toFixed(0)}% CI [${sig.bootstrap.low.toFixed(3)}, ${sig.bootstrap.high.toFixed(3)}]`
      return {
        decision: passed ? 'ship' : 'hold',
        reasons: passed
          ? [
              `held-out paired Δ median ${delta.toFixed(3)}, CI.low ${sig.bootstrap.low.toFixed(3)} > ${deltaThreshold} (${ci}, n=${sig.n})`,
            ]
          : [
              sig.fewRuns
                ? `held-out: only ${sig.n} paired runs — too few to claim significance`
                : `held-out paired Δ median ${delta.toFixed(3)}, CI.low ${sig.bootstrap.low.toFixed(3)} ≤ ${deltaThreshold} (${ci}, n=${sig.n})`,
            ],
        contributingGates: [
          {
            name: 'heldOutGate',
            passed,
            detail: {
              deltaMedian: delta,
              ciLow: sig.bootstrap.low,
              ciHigh: sig.bootstrap.high,
              confidence: sig.bootstrap.confidence,
              n: sig.n,
              deltaThreshold,
              fewRuns: sig.fewRuns,
            },
          },
        ],
        delta,
      }
    },
  }
}
