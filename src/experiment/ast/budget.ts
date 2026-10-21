import { ValidationError } from '../../errors'
import type { GateResult } from './validity'

/** Checks as prerequisites: any named gate failing refuses the spend. */
export interface HaltRule {
  when: { kind: 'any-gate-failed'; gates: string[] }
  action: 'refuse-spend'
  report: 'settling-n'
}

export interface HaltOutcome {
  fired: boolean
  action: 'refuse-spend' | null
  failedGates: string[]
}

export function evaluateHaltRule(halt: HaltRule, gates: readonly GateResult[]): HaltOutcome {
  const seen = new Map(gates.map((g) => [g.id, g]))
  const missing = halt.when.gates.filter((id) => !seen.has(id))
  if (missing.length > 0) {
    throw new ValidationError(
      `evaluateHaltRule: halt references gates that were not evaluated: [${missing.join(', ')}]`,
    )
  }
  const failed = halt.when.gates.filter((id) => !seen.get(id)!.passed)
  return failed.length > 0
    ? { fired: true, action: halt.action, failedGates: failed }
    : { fired: false, action: null, failedGates: [] }
}

// ── Budget rules ─────────────────────────────────────────────────────

/**
 * Spend schedules as data. `ledger` names every entry the ceiling counts, so
 * what the gate reads is registered, not improvised at gate time.
 */
export type BudgetRule =
  | {
      kind: 'uniform-pass'
      ceilingUsd: number
      maxPasses: number
      projection: 'last-pass-cost'
      costSource: 'priced-per-call'
      ledger: { id: string; usd: number }[]
      partialPass: 'report-never-lift'
    }
  | {
      kind: 'n-ladder'
      steps: number[]
      ceilingUsd: number
      projection: 'unit-cost-times-rows-times-n'
      onExhaust: 'refuse-report-projection'
    }

export interface UniformPassDecision {
  pass: number
  cumulativeBefore: number
  projected: number
  go: boolean
}

export interface UniformPassSchedule {
  decisions: UniformPassDecision[]
  uniformN: number
}

/**
 * Execute the uniform-pass schedule against measured pass costs. Pass 1 always
 * runs; each later pass runs only when the cumulative spend plus the last
 * measured pass cost stays at or under the registered ceiling. The registered
 * ledger is the pre-spend the ceiling counts.
 */
export function runUniformPassBudget(
  rule: Extract<BudgetRule, { kind: 'uniform-pass' }>,
  measuredPassCosts: readonly number[],
): UniformPassSchedule {
  const preSpend = rule.ledger.reduce((sum, entry) => sum + entry.usd, 0)
  let cumulative = preSpend
  const decisions: UniformPassDecision[] = []
  let uniformN = 0
  for (let pass = 1; pass <= rule.maxPasses; pass++) {
    if (pass === 1) {
      if (measuredPassCosts[0] === undefined) break
      cumulative += measuredPassCosts[0]
      uniformN = 1
      continue
    }
    const projected = measuredPassCosts[pass - 2]
    if (projected === undefined) break
    const go = cumulative + projected <= rule.ceilingUsd
    decisions.push({ pass, cumulativeBefore: cumulative, projected, go })
    if (!go || measuredPassCosts[pass - 1] === undefined) break
    cumulative += measuredPassCosts[pass - 1]!
    uniformN = pass
  }
  return { decisions, uniformN }
}

export interface NLadderProjection {
  chosenN: number | null
  projections: { n: number; projectedUsd: number; affordable: boolean }[]
  refusal: null | { onExhaust: 'refuse-report-projection'; reason: string }
}

/**
 * Walk the registered n-ladder and pick the first affordable step. When no
 * step fits the ceiling, the rule refuses and reports the projection instead
 * of shrinking the row set — "never subset rows" is the registered invariant.
 */
export function projectNLadderBudget(
  rule: Extract<BudgetRule, { kind: 'n-ladder' }>,
  measured: { unitCostUsd: number; rows: number },
): NLadderProjection {
  const projections = rule.steps.map((n) => {
    const projectedUsd = measured.unitCostUsd * measured.rows * n
    return { n, projectedUsd, affordable: projectedUsd <= rule.ceilingUsd }
  })
  const first = projections.find((p) => p.affordable)
  if (first) return { chosenN: first.n, projections, refusal: null }
  return {
    chosenN: null,
    projections,
    refusal: {
      onExhaust: rule.onExhaust,
      reason: `no ladder step fits the ${rule.ceilingUsd} USD ceiling at ${measured.rows} rows x ${measured.unitCostUsd} USD per unit`,
    },
  }
}

// ── Matched budget and reissue ───────────────────────────────────────

/** Arm budget matching as a refusal, not prose. Verified by `verifyMatchedBudgets`. */
export interface MatchedBudgetRule {
  measure: 'realized-tokens'
  tolerance: number
  onFail: 'refuse-contrast'
}
