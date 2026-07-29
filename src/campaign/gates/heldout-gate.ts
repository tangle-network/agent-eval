/**
 * @module
 * Composable held-out promotion gate.
 *
 * Pair by full `scenario:rep` cellId, then ship only when the lower bound of
 * the interval the outcome's SHAPE admits strictly clears the threshold, with
 * at least `minProductiveRuns` paired observations. The rule is
 * `decidePairedPromotion` (`src/paired-promotion-decision.ts`) — the same one
 * `HeldOutGate` decides on, not a second copy: a pass/fail holdout decides on
 * Tango's score interval, McNemar's exact test vetoes at a non-negative
 * threshold, and a zero-width interval is refused rather than promoted.
 *
 * Use when you want held-out significance as ONE of N composed gates instead
 * of the full `defaultProductionGate` stack (which adds critical-dimension
 * regression + reward-hacking guards on top).
 */

import type { Gate, GateContext, GateResult, Scenario } from '../types'
import { heldoutSignificance, pairHoldout, TIE_WARN_FRACTION } from './statistical-heldout'

export interface HeldOutGateOptions<TScenario extends Scenario = Scenario> {
  scenarios: TScenario[]
  /** Effect-size threshold the CI lower bound must clear, in the judge's native
   *  scale. Default 0.5. Equality holds; CI.low must be greater than this value. */
  deltaThreshold?: number
  /** Bootstrap CI confidence. Default 0.95. */
  confidence?: number
  /** Minimum paired holdout observations to claim significance. The exact
   *  small-sample test may require more observations at the selected
   *  confidence. Default 3. */
  minProductiveRuns?: number
  /** Bootstrap resamples. Default 2000. */
  resamples?: number
  /** Fixed bootstrap seed for deterministic verdicts. Default 1337. */
  bootstrapSeed?: number
}

/**
 * Composable held-out gate: ships only when the lower bound of the DECIDING
 * paired interval on the candidate-minus-baseline composite delta clears
 * `deltaThreshold` — Tango's score interval on a pass/fail holdout, the mean
 * bootstrap otherwise. See {@link decidePairedPromotion}.
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
      // Report the interval that DECIDED, not the diagnostic bootstrap: on a
      // pass/fail holdout the verdict comes from Tango's score interval, and
      // printing the bootstrap's bounds next to that verdict would put a
      // number in the reason string that did not produce it.
      const dec = sig.decision
      const delta = dec.delta
      const passed = sig.significant
      const status = sig.fewRuns ? 'not_evaluated' : passed ? 'pass' : 'fail'
      const tieNote =
        sig.tieFraction >= TIE_WARN_FRACTION ? `, ${(sig.tieFraction * 100).toFixed(0)}% tied` : ''
      const ci = `${(dec.confidence * 100).toFixed(0)}% CI [${dec.low.toFixed(3)}, ${dec.high.toFixed(3)}]`
      const held = `held-out ${dec.label} Δ ${delta.toFixed(3)}`
      const holdReason = sig.fewRuns
        ? `held-out: only ${sig.n} paired runs; ${sig.minimumRequired} required — too few to claim significance`
        : dec.indeterminate
          ? `held-out: ${dec.indeterminateCause}, so the paired CI is ${ci} and carries no direction — it cannot clear ${deltaThreshold} on evidence (n=${sig.n}${tieNote})`
          : dec.exactTestVetoes
            ? `${held}, McNemar exact p=${dec.mcnemar?.pValue.toExponential(2)} does not reject at α=${(1 - dec.confidence).toFixed(4)} (${ci}, n=${sig.n}${tieNote})`
            : `${held}, CI.low ${dec.low.toFixed(3)} ≤ ${deltaThreshold} (${ci}, n=${sig.n}${tieNote})`
      return {
        decision: passed ? 'ship' : 'hold',
        reasons: passed
          ? [
              `${held}, CI.low ${dec.low.toFixed(3)} > ${deltaThreshold} (${ci}, n=${sig.n}${tieNote})`,
            ]
          : [holdReason],
        contributingGates: [
          {
            name: 'heldOutGate',
            status,
            detail: {
              deltaMean: sig.bootstrap.mean,
              decidingDelta: delta,
              decisionStatistic: sig.decisionStatistic,
              decisionMethod: sig.decisionMethod,
              binaryScale: dec.binaryScale,
              mcnemar: dec.mcnemar,
              indeterminate: dec.indeterminate,
              deltaMedianDiagnostic: sig.medianBootstrap.median,
              tieFraction: sig.tieFraction,
              ciLow: dec.low,
              ciHigh: dec.high,
              bootstrapCiLow: sig.bootstrap.low,
              bootstrapCiHigh: sig.bootstrap.high,
              confidence: dec.confidence,
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
