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
 * Observations that share a parent run or task are one unit. Several decision
 * points taken from one historical run share that run's state, so they carry
 * one run's evidence however many cells they fill. Pass
 * `independentUnitByScenarioId` to map every scenario to its unit: the gate
 * then averages the paired cells within each unit, gives units equal weight,
 * and counts units, not cells, as the observations `minProductiveRuns` and the
 * decision rule see. A scored scenario missing from a supplied map is an
 * error. Without a map each paired cell is its own observation, which holds
 * only when cells are sampled independently.
 *
 * Use when you want held-out significance as ONE of N composed gates instead
 * of the full `defaultProductionGate` stack (which adds critical-dimension
 * regression + reward-hacking guards on top).
 */

import type { Gate, GateContext, GateResult, Scenario } from '../types'
import { heldoutSignificance, pairHoldout, TIE_WARN_FRACTION } from './statistical-heldout'

export interface HeldOutGateOptions<TScenario extends Scenario = Scenario> {
  scenarios: TScenario[]
  /**
   * Independent unit for every held-out scenario, such as the historical run
   * a decision point was taken from. Cells pair first, then their scores are
   * averaged within each unit and every unit counts once. Omit only when each
   * execution cell is an independent observation. The gate copies the map
   * when it is built.
   */
  independentUnitByScenarioId?: ReadonlyMap<string, string>
  /** Effect-size threshold the CI lower bound must clear, in the judge's native
   *  scale. Default 0.5. Equality holds; CI.low must be greater than this value. */
  deltaThreshold?: number
  /** Bootstrap CI confidence. Default 0.95. */
  confidence?: number
  /** Minimum paired independent units (or paired cells when no unit map is
   *  supplied) to claim significance. The exact small-sample test may require
   *  more observations at the selected confidence. Default 3. */
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
  const independentUnitByScenarioId =
    options.independentUnitByScenarioId === undefined
      ? undefined
      : new Map(options.independentUnitByScenarioId)
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
          independentUnitByScenarioId,
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
      // With a unit map, n counts units. Name both counts so a reader cannot
      // take the number of cells for the number of independent observations.
      const registered = sig.observationUnit === 'registered'
      const units = `${sig.n} independent units from ${sig.pairedCellN} paired cells`
      const observed = registered ? units : `${sig.n} paired runs`
      const count = registered ? `n=${units}` : `n=${sig.n}`
      const tieNote =
        sig.tieFraction >= TIE_WARN_FRACTION ? `, ${(sig.tieFraction * 100).toFixed(0)}% tied` : ''
      const ci = `${(dec.confidence * 100).toFixed(0)}% CI [${dec.low.toFixed(3)}, ${dec.high.toFixed(3)}]`
      const held = `held-out ${dec.label} Δ ${delta.toFixed(3)}`
      const holdReason = sig.fewRuns
        ? `held-out: only ${observed}; ${sig.minimumRequired} required — too few to claim significance`
        : dec.indeterminate
          ? `held-out: ${dec.indeterminateCause}, so the paired CI is ${ci} and carries no direction — it cannot clear ${deltaThreshold} on evidence (${count}${tieNote})`
          : dec.exactTestVetoes
            ? `${held}, McNemar exact p=${dec.mcnemar?.pValue.toExponential(2)} does not reject at α=${(1 - dec.confidence).toFixed(4)} (${ci}, ${count}${tieNote})`
            : `${held}, CI.low ${dec.low.toFixed(3)} ≤ ${deltaThreshold} (${ci}, ${count}${tieNote})`
      return {
        decision: passed ? 'ship' : 'hold',
        reasons: passed
          ? [
              `${held}, CI.low ${dec.low.toFixed(3)} > ${deltaThreshold} (${ci}, ${count}${tieNote})`,
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
              // Present only with a unit map, so the detail a caller without
              // one receives is unchanged.
              ...(registered
                ? {
                    pairedCellN: sig.pairedCellN,
                    observationUnit: sig.observationUnit,
                    unitIds: sig.unitIds,
                  }
                : {}),
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
