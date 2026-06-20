/**
 * Thin Gate adapter — exposes delta-threshold-on-holdout as a composable
 * `Gate`. Use when you want held-out as one of N composed gates instead of
 * the full `defaultProductionGate` stack.
 */

import type { Gate, GateContext, GateResult, Scenario } from '../types'

export interface HeldOutGateOptions<TScenario extends Scenario = Scenario> {
  scenarios: TScenario[]
  deltaThreshold?: number
}

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
      const baseline = meanForScenarios(ctx.baselineJudgeScores ?? ctx.judgeScores, scenarioIds)
      const candidate = meanForScenarios(ctx.judgeScores, scenarioIds)
      const delta = candidate - baseline
      const passed = delta >= deltaThreshold
      return {
        decision: passed ? 'ship' : 'hold',
        reasons: passed
          ? [`held-out delta ${delta.toFixed(3)} ≥ ${deltaThreshold}`]
          : [`held-out delta ${delta.toFixed(3)} < ${deltaThreshold}`],
        contributingGates: [
          { name: 'heldOutGate', passed, detail: { baseline, candidate, delta, deltaThreshold } },
        ],
        delta,
      }
    },
  }
}

function meanForScenarios(
  judgeScoresByCell: Map<string, Record<string, { composite: number }>>,
  scenarioIds: Set<string>,
): number {
  const composites: number[] = []
  for (const [cellId, scores] of judgeScoresByCell) {
    const scenarioId = cellId.split(':')[0] ?? ''
    if (!scenarioIds.has(scenarioId)) continue
    const vals = Object.values(scores).map((s) => s.composite)
    if (vals.length > 0) composites.push(vals.reduce((a, b) => a + b, 0) / vals.length)
  }
  return composites.length === 0 ? 0 : composites.reduce((a, b) => a + b, 0) / composites.length
}
