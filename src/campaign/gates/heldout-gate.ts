/**
 * @module
 * Composable held-out promotion gate backed by paired bootstrap confidence.
 *
 * Pair by full `scenario:rep` cellId, bootstrap the paired candidate-minus-
 * baseline delta, and ship only when CI.low strictly clears the threshold with
 * at least `minProductiveRuns` paired observations.
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
   *  scale. Default 0.5. Equality holds; CI.low must be greater than this value. */
  deltaThreshold?: number
  /** Bootstrap CI confidence. Default 0.95. */
  confidence?: number
  /** Minimum paired holdout observations to claim significance. Default 3. */
  minProductiveRuns?: number
  /** Bootstrap resamples. Default 2000. */
  resamples?: number
  /** Fixed bootstrap seed for deterministic verdicts. Default 1337. */
  bootstrapSeed?: number
}

/**
 * Composable held-out gate: ships only when the PAIRED bootstrap CI lower bound
 * of the candidate-minus-baseline composite delta clears `deltaThreshold`.
 */
export function heldOutGate<TArtifact, TScenario extends Scenario>(
  options: HeldOutGateOptions<TScenario>,
): Gate<TArtifact, TScenario> {
  const deltaThreshold = options.deltaThreshold ?? 0.5
  const confidence = options.confidence ?? 0.95
  const minProductiveRuns = options.minProductiveRuns ?? 3
  const resamples = options.resamples ?? 2000
  const seed = options.bootstrapSeed ?? 1337
  return {
    name: 'heldOutGate',
    async decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult> {
      if (!ctx.baselineJudgeScores) {
        throw new Error(
          'heldOutGate: ctx.baselineJudgeScores is required — comparing candidate scores against themselves would hide a missing baseline',
        )
      }
      const scenarioIds = new Set(options.scenarios.map((s) => s.id))
      const sig = heldoutSignificance(
        pairHoldout(ctx.judgeScores, ctx.baselineJudgeScores, scenarioIds, (s) => s.composite),
        {
          deltaThreshold,
          confidence,
          minProductiveRuns,
          resamples,
          seed,
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
              seed,
            },
          },
        ],
        delta,
      }
    },
  }
}
