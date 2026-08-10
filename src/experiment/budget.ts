/**
 * Matched-budget verification between arms, as a refusal object.
 *
 * A paired contrast is only meaningful when both arms spent comparable
 * resources; "realized prompt and completion tokens must agree within 5%" is
 * a registered rule, so its verification returns a verdict artifact — the
 * refusal lives inside the result, never in prose beside it.
 */

import { CaptureIntegrityError } from '../errors'
import type { MatchedBudgetRule } from './ast'

/** Arms whose realized budgets diverge past the registered tolerance. */
export class MatchedBudgetError extends CaptureIntegrityError {}

export interface ArmRealizedBudget {
  armId: string
  /** Realized prompt + completion tokens the arm actually consumed. */
  realizedTokens: number
}

export interface MatchedBudgetVerdict {
  rule: MatchedBudgetRule
  arms: ArmRealizedBudget[]
  /** (max - min) / max over all arms; 0 when every arm spent nothing. */
  maxRelativeGap: number
  /** The two arms with the widest gap; null when fewer than two arms. */
  widestPair: [string, string] | null
  matched: boolean
  /** Populated exactly when `matched` is false. */
  refusal: null | { onFail: 'refuse-contrast'; reason: string }
}

/**
 * Compare realized per-arm spend under the registered tolerance. Requires at
 * least two arms — a single arm has nothing to match against. Negative or
 * non-finite token counts are refused as evidence corruption, not compared.
 */
export function verifyMatchedBudgets(
  rule: MatchedBudgetRule,
  arms: readonly ArmRealizedBudget[],
): MatchedBudgetVerdict {
  if (arms.length < 2) {
    throw new MatchedBudgetError(
      `verifyMatchedBudgets: need >= 2 arms to match budgets, got ${arms.length}`,
    )
  }
  for (const arm of arms) {
    if (!Number.isFinite(arm.realizedTokens) || arm.realizedTokens < 0) {
      throw new MatchedBudgetError(
        `verifyMatchedBudgets: arm '${arm.armId}' has invalid realized tokens ${arm.realizedTokens}`,
      )
    }
  }
  const sorted = [...arms].sort((a, b) => a.realizedTokens - b.realizedTokens)
  const min = sorted[0]!
  const max = sorted[sorted.length - 1]!
  const maxRelativeGap =
    max.realizedTokens === 0 ? 0 : (max.realizedTokens - min.realizedTokens) / max.realizedTokens
  const matched = maxRelativeGap <= rule.tolerance
  return {
    rule,
    arms: [...arms],
    maxRelativeGap,
    widestPair: [min.armId, max.armId],
    matched,
    refusal: matched
      ? null
      : {
          onFail: rule.onFail,
          reason:
            `realized ${rule.measure} diverge ${(maxRelativeGap * 100).toFixed(1)}% between ` +
            `'${min.armId}' (${min.realizedTokens}) and '${max.armId}' (${max.realizedTokens}) — ` +
            `registered tolerance is ${(rule.tolerance * 100).toFixed(1)}%; the contrast is refused`,
        },
  }
}

/** Throw the refusal for callers that gate the contrast on it. */
export function assertMatchedBudgets(
  rule: MatchedBudgetRule,
  arms: readonly ArmRealizedBudget[],
): MatchedBudgetVerdict {
  const verdict = verifyMatchedBudgets(rule, arms)
  if (verdict.refusal) throw new MatchedBudgetError(verdict.refusal.reason)
  return verdict
}
