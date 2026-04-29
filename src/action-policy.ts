import type { FeedbackLabel, ProposedSideEffect } from './feedback-trajectory'

export interface ActionExecutionPolicy {
  allowedTypes?: string[]
  blockedTypes?: string[]
  alwaysRequireApprovalTypes?: string[]
  autoApproveTypes?: string[]
  requireApprovalForExternalSideEffects?: boolean
  requireApprovalAboveCostUsd?: number
  maxActionCostUsd?: number
  remainingBudgetUsd?: number
  expectedOutcomeRequired?: boolean
  killCriteriaRequired?: boolean
}

export interface ActionPolicyDecision {
  allowed: boolean
  blocked: boolean
  requiresApproval: boolean
  reasons: string[]
  label?: FeedbackLabel
}

export function evaluateActionPolicy(
  action: ProposedSideEffect,
  policy: ActionExecutionPolicy = {},
  options: { createdAt?: string } = {},
): ActionPolicyDecision {
  const reasons: string[] = []
  let blocked = false
  let requiresApproval = Boolean(action.requiresApproval)

  if (policy.allowedTypes?.length && !policy.allowedTypes.includes(action.type)) {
    blocked = true
    reasons.push(`action type "${action.type}" is not allowed`)
  }
  if (policy.blockedTypes?.includes(action.type)) {
    blocked = true
    reasons.push(`action type "${action.type}" is blocked`)
  }
  if (policy.alwaysRequireApprovalTypes?.includes(action.type)) {
    requiresApproval = true
    reasons.push(`action type "${action.type}" requires approval`)
  }
  if (policy.requireApprovalForExternalSideEffects && action.externalSideEffect) {
    requiresApproval = true
    reasons.push('external side effect requires approval')
  }
  if (policy.requireApprovalAboveCostUsd !== undefined && (action.costUsd ?? 0) > policy.requireApprovalAboveCostUsd) {
    requiresApproval = true
    reasons.push(`cost ${action.costUsd} exceeds approval threshold ${policy.requireApprovalAboveCostUsd}`)
  }
  if (policy.maxActionCostUsd !== undefined && (action.costUsd ?? 0) > policy.maxActionCostUsd) {
    blocked = true
    reasons.push(`cost ${action.costUsd} exceeds max action cost ${policy.maxActionCostUsd}`)
  }
  if (policy.remainingBudgetUsd !== undefined && (action.costUsd ?? 0) > policy.remainingBudgetUsd) {
    blocked = true
    reasons.push(`cost ${action.costUsd} exceeds remaining budget ${policy.remainingBudgetUsd}`)
  }
  if (policy.expectedOutcomeRequired && !action.metadata?.expectedOutcome) {
    blocked = true
    reasons.push('expected outcome is required')
  }
  if (policy.killCriteriaRequired && !action.metadata?.killCriteria) {
    blocked = true
    reasons.push('kill criteria are required')
  }
  if (policy.autoApproveTypes?.includes(action.type) && requiresApproval) {
    reasons.push(`action type "${action.type}" is auto-approved only when no approval policy applies`)
  }

  if (!reasons.length) reasons.push(requiresApproval ? 'approval required' : 'action allowed')

  const label = blocked || requiresApproval
    ? {
        source: 'policy' as const,
        kind: blocked ? 'policy_block' as const : 'comment' as const,
        value: { actionType: action.type, blocked, requiresApproval },
        reason: reasons.join('; '),
        severity: blocked ? 'critical' as const : 'warning' as const,
        createdAt: options.createdAt ?? new Date().toISOString(),
        metadata: { action, policy },
      }
    : undefined

  return {
    allowed: !blocked,
    blocked,
    requiresApproval: !blocked && requiresApproval,
    reasons,
    label,
  }
}
