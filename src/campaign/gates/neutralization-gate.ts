/**
 * @module
 * Composable placebo / neutralization promotion gate.
 *
 * A held-out gate proves a candidate beat baseline. It CANNOT prove the lift came
 * from the candidate's CONTENT rather than from the prompt/mount FOOTPRINT the
 * content happened to add (more bytes, a longer prompt). This gate closes that
 * hole: it compares the candidate's held-out lift against the lift of a
 * FOOTPRINT-MATCHED neutralized variant (same layout + length, zero content, via
 * `neutralizeText`). If the neutralized variant reproduces more than
 * `maxDecorativeFraction` of the candidate's lift, the lift is decorative — it
 * survives blanking the content — and the candidate is HELD regardless of how
 * large or significant its raw lift is.
 *
 * Compose it AFTER the significance gate — significance says the lift is real,
 * this says the lift is CAUSED BY THE CONTENT:
 *   composeGate(heldOutGate({ ... }), neutralizationGate({ ... }))
 *
 * Requires `ctx.neutralizedJudgeScores`, populated by `runImprovementLoop` when it
 * is given a `neutralize` function. A gate composed without that wiring fails
 * loud rather than silently passing an unproven candidate.
 */

import type { Gate, GateContext, GateResult, Scenario } from '../types'
import { pairHoldout } from './statistical-heldout'

export interface NeutralizationGateOptions<TScenario extends Scenario = Scenario> {
  scenarios: TScenario[]
  /** Reject when the neutralized (content-blanked, footprint-matched) variant
   *  reproduces at least this fraction of the candidate's held-out lift. Default
   *  0.5 — if blanking the content keeps half the lift, the content is decorative.
   *  Equality rejects: a neutralized lift == threshold·candidateLift is decorative. */
  maxDecorativeFraction?: number
}

/** Mean of a numeric array; 0 for an empty array (callers guard n separately). */
function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Paired mean held-out lift of `arm` over baseline, on the in-scope cells. */
function pairedLift(
  arm: Map<string, Record<string, { composite: number }>>,
  baseline: Map<string, Record<string, { composite: number }>>,
  scenarioIds: Set<string>,
): { lift: number; n: number } {
  const paired = pairHoldout(arm as never, baseline as never, scenarioIds, (s) => s.composite)
  const deltas = paired.after.map((a, i) => a - (paired.before[i] ?? 0))
  return { lift: mean(deltas), n: deltas.length }
}

/**
 * Composable placebo gate: ships only when the candidate's held-out lift is NOT
 * mostly reproduced by a footprint-matched neutralized variant.
 */
export function neutralizationGate<TArtifact, TScenario extends Scenario>(
  options: NeutralizationGateOptions<TScenario>,
): Gate<TArtifact, TScenario> {
  const maxDecorativeFraction = options.maxDecorativeFraction ?? 0.5
  return {
    name: 'neutralizationGate',
    async decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult> {
      if (!ctx.baselineJudgeScores) {
        throw new Error(
          'neutralizationGate: ctx.baselineJudgeScores is required — the placebo control measures lift OVER baseline.',
        )
      }
      if (!ctx.neutralizedJudgeScores) {
        throw new Error(
          'neutralizationGate: ctx.neutralizedJudgeScores is required. It is populated by runImprovementLoop only when a `neutralize` function is supplied — composing this gate without that wiring would pass an unproven candidate.',
        )
      }
      const scenarioIds = new Set(options.scenarios.map((s) => s.id))
      const cand = pairedLift(
        ctx.judgeScores as never,
        ctx.baselineJudgeScores as never,
        scenarioIds,
      )
      const neut = pairedLift(
        ctx.neutralizedJudgeScores as never,
        ctx.baselineJudgeScores as never,
        scenarioIds,
      )

      // No positive candidate lift → nothing to attribute. Fail closed: the
      // placebo control has no basis to clear the candidate (the significance
      // gate is what judges lift magnitude; this one only judges its CAUSE).
      if (cand.lift <= 0) {
        return {
          decision: 'hold',
          reasons: [
            `neutralization: candidate held-out lift ${cand.lift.toFixed(3)} ≤ 0 — no positive lift to attribute to content`,
          ],
          contributingGates: [
            {
              name: 'neutralizationGate',
              passed: false,
              detail: { candidateLift: cand.lift, neutralizedLift: neut.lift, n: cand.n },
            },
          ],
          delta: cand.lift,
        }
      }

      const decorativeFraction = neut.lift / cand.lift
      const passed = decorativeFraction < maxDecorativeFraction
      const pct = (decorativeFraction * 100).toFixed(0)
      return {
        decision: passed ? 'ship' : 'hold',
        reasons: passed
          ? [
              `neutralization: content is causal — blanked variant reproduces ${pct}% of the lift (< ${(maxDecorativeFraction * 100).toFixed(0)}%); candidate Δ ${cand.lift.toFixed(3)}, neutralized Δ ${neut.lift.toFixed(3)}`,
            ]
          : [
              `neutralization: lift is DECORATIVE — blanking the content (footprint-matched) reproduces ${pct}% of the lift (≥ ${(maxDecorativeFraction * 100).toFixed(0)}%); candidate Δ ${cand.lift.toFixed(3)}, neutralized Δ ${neut.lift.toFixed(3)}`,
            ],
        contributingGates: [
          {
            name: 'neutralizationGate',
            passed,
            detail: {
              candidateLift: cand.lift,
              neutralizedLift: neut.lift,
              decorativeFraction,
              maxDecorativeFraction,
              n: cand.n,
            },
          },
        ],
        delta: cand.lift,
      }
    },
  }
}
