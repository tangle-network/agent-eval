/**
 * @experimental
 *
 * Compose multiple `Gate` implementations — every gate must pass for the
 * composite to ship. Closes the alignment reviewer's "default-only
 * heldOutGate + costGate would happily promote a reward-hacked prompt"
 * concern by making safety gates first-class composable defaults.
 */

import type { Gate, GateContext, GateDecision, GateResult, Scenario } from '../types'

/** Compose gates — all must `ship` for the composite to `ship`. First
 *  non-ship verdict short-circuits the composite verdict, but ALL gates run
 *  (so the result records every gate's reason — useful for diagnostics). */
export function composeGate<TArtifact = unknown, TScenario extends Scenario = Scenario>(
  ...gates: Array<Gate<TArtifact, TScenario>>
): Gate<TArtifact, TScenario> {
  if (gates.length === 0) {
    throw new Error('composeGate requires at least one gate')
  }
  return {
    name: `composed(${gates.map((g) => g.name).join(',')})`,
    async decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult> {
      const results: Array<{ gate: Gate<TArtifact, TScenario>; res: GateResult }> = []
      for (const gate of gates) {
        const res = await gate.decide(ctx)
        results.push({ gate, res })
      }

      // Substrate-wide verdict policy:
      //   - all 'ship' → 'ship'
      //   - any 'arch_ceiling' → 'arch_ceiling' (architectural ceiling beats other holds)
      //   - any 'model_ceiling' → 'model_ceiling'
      //   - any 'hold' → 'hold'
      //   - else 'need_more_work'
      const decisions = results.map((r) => r.res.decision)
      const overall: GateDecision = decisions.every((d) => d === 'ship')
        ? 'ship'
        : decisions.includes('arch_ceiling')
          ? 'arch_ceiling'
          : decisions.includes('model_ceiling')
            ? 'model_ceiling'
            : decisions.includes('hold')
              ? 'hold'
              : 'need_more_work'

      const contributing = results.flatMap((r) =>
        r.res.contributingGates.length > 0
          ? r.res.contributingGates
          : [{ name: r.gate.name, passed: r.res.decision === 'ship', detail: r.res }],
      )

      const reasons = results.flatMap((r) =>
        r.res.reasons.map((reason) => `[${r.gate.name}] ${reason}`),
      )

      return {
        decision: overall,
        reasons,
        contributingGates: contributing,
        delta: results[0]?.res.delta,
      }
    },
  }
}
